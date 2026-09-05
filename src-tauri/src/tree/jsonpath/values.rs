//! What a value is, and what it means for two of them to compare.
//!
//! Split out of `filter` because none of it is about reading an expression.
//! The comparison rules are RFC 9535 §2.3.5.2.2 and they hold for whoever
//! asks — `functions` asks as often as the filter does, and having it reach
//! into the parser for `Value` had the dependency pointing the wrong way.
//!
//! `Literal` and `Op` are here too. A literal is a value the author wrote out
//! instead of pointing at, and an operator is the question asked of two
//! values; `filter` reads both out of the text and this answers them.

use std::borrow::Cow;

use crate::error::{Error, Result};
use crate::tree::index::TreeIndex;
use crate::tree::scanner::Kind;
use crate::tree::text;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Str(String),
    /// Whole numbers stay whole. Two integers compare exactly, which `f64`
    /// stops doing somewhere past nine quadrillion — and an id is an integer.
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
}

/// What a query found, as something comparable.
///
/// `Nothing` is a value here rather than an absence, because the RFC gives it
/// meaning: a missing thing equals a missing thing and is unordered against
/// everything, which is how `[?@.a == @.b]` is true of a node that has
/// neither.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Value<'a> {
    Nothing,
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Cow<'a, str>),
    /// An object or an array. Comparing two of those means deep equality,
    /// which this does not do — see `compare`. The count is carried because
    /// `length()` asks for exactly it, and the index already knows it.
    Composite { count: u32 },
}

impl<'a> From<&'a Literal> for Value<'a> {
    fn from(literal: &'a Literal) -> Self {
        match literal {
            Literal::Str(text) => Value::Str(Cow::Borrowed(text)),
            Literal::Int(n) => Value::Int(*n),
            Literal::Float(n) => Value::Float(*n),
            Literal::Bool(b) => Value::Bool(*b),
            Literal::Null => Value::Null,
        }
    }
}

/// A node's value, read from the bytes it was scanned out of.
///
/// **Not the row preview.** `text::decode_scalar` cuts a value off at the
/// length a row can show, which is right for drawing and wrong for comparing:
/// two strings that differ only after the cut would come back equal. So this
/// reads the whole span, and pays for a copy only when there is an escape in
/// it — the same bargain `named` takes over keys.
pub(super) fn value_of<'a>(bytes: &'a [u8], index: &TreeIndex, id: u32) -> Value<'a> {
    let Some(node) = index.node(id) else {
        return Value::Nothing;
    };
    let start = node.val_start as usize;
    let end = start.saturating_add(node.val_len as usize).min(bytes.len());
    let raw = bytes.get(start..end).unwrap_or_default();

    match node.kind {
        Kind::String => {
            let inner = raw.get(1..raw.len().saturating_sub(1)).unwrap_or_default();
            if inner.contains(&b'\\') {
                Value::Str(Cow::Owned(
                    text::decode_full(bytes, node, usize::MAX).0,
                ))
            } else {
                Value::Str(String::from_utf8_lossy(inner))
            }
        }
        Kind::Number => number_of(raw),
        Kind::Bool => Value::Bool(raw == b"true"),
        Kind::Null => Value::Null,
        // XML never reaches here — `select_by_path` refuses it — and an object
        // or an array is a thing you can test the existence of or measure, not
        // compare.
        _ => Value::Composite {
            count: node.child_count,
        },
    }
}

fn number_of(raw: &[u8]) -> Value<'static> {
    let text = std::str::from_utf8(raw).unwrap_or_default();
    if !text.contains(['.', 'e', 'E']) {
        if let Ok(whole) = text.parse::<i64>() {
            return Value::Int(whole);
        }
    }
    Value::Float(text.parse::<f64>().unwrap_or(f64::NAN))
}

/// RFC 9535 §2.3.5.2.2, which is shorter than it sounds:
///
/// * a missing value equals a missing value and nothing else;
/// * numbers compare as numbers, whichever way each was written;
/// * strings compare by code point;
/// * `true`, `false` and `null` can be equal or not, and nothing more;
/// * two different types are never equal and never ordered.
///
/// The one place this stops is an object or an array, where the RFC asks for
/// deep equality. Said out loud rather than answered as `false`: a filter that
/// quietly finds nothing looks exactly like a filter that found nothing.
pub(super) fn compare(left: &Value<'_>, op: Op, right: &Value<'_>) -> Result<bool> {
    if matches!(left, Value::Composite { .. }) || matches!(right, Value::Composite { .. }) {
        return Err(Error::BadPath {
            detail: "comparing an object or an array is not supported yet; compare one of its values instead"
                .to_owned(),
        });
    }

    let ordering = match (left, right) {
        (Value::Int(a), Value::Int(b)) => Some(a.cmp(b)),
        // Mixed or fractional, so as far as `f64` reaches. `partial_cmp` is
        // None for a NaN, which no valid JSON number is.
        (Value::Int(a), Value::Float(b)) => (*a as f64).partial_cmp(b),
        (Value::Float(a), Value::Int(b)) => a.partial_cmp(&(*b as f64)),
        (Value::Float(a), Value::Float(b)) => a.partial_cmp(b),
        (Value::Str(a), Value::Str(b)) => Some(a.cmp(b)),
        _ => None,
    };

    if let Some(ordering) = ordering {
        use std::cmp::Ordering;
        return Ok(match op {
            Op::Eq => ordering == Ordering::Equal,
            Op::Ne => ordering != Ordering::Equal,
            Op::Lt => ordering == Ordering::Less,
            Op::Le => ordering != Ordering::Greater,
            Op::Gt => ordering == Ordering::Greater,
            Op::Ge => ordering != Ordering::Less,
        });
    }

    // Not ordered against each other. Equality is still a question, and the
    // answer is yes only for two of the same unordered thing.
    let equal = match (left, right) {
        (Value::Nothing, Value::Nothing) | (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        _ => false,
    };
    Ok(match op {
        Op::Eq => equal,
        Op::Ne => !equal,
        // Unordered, so every ordering question is false — including `<=`
        // between two equal booleans, which the RFC also says is false.
        Op::Lt | Op::Le | Op::Gt | Op::Ge => false,
    })
}
