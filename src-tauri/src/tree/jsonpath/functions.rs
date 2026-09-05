//! The five functions RFC 9535 defines, and the type rules that admit them.
//!
//! `length()`, `count()`, `match()`, `search()` and `value()` are the whole of
//! §2.4 — with them the expression language is the RFC's, not a subset of it.
//!
//! **The types are checked while parsing**, which is where the RFC puts them
//! (§2.4.3 calls it well-typedness). A function's parameters and result are
//! fixed by its name, so whether `length(@.*)` makes sense is a question about
//! the text and not about any document — and answering it here means the
//! reader is told while they are still looking at what they typed, rather than
//! getting an empty result from one file and an error from the next.
//!
//! Three types, and they are not interchangeable:
//!
//! * **ValueType** — one value, or nothing. Literals, singular queries, and
//!   what `length`/`count`/`value` give back.
//! * **NodesType** — however many nodes a query selects. Only a query is one,
//!   and `count` and `value` take one; this is the whole reason `count(@.*)`
//!   is allowed where `length(@.*)` is not.
//! * **LogicalType** — true or false. `match` and `search` give one, and a
//!   filter's own condition is one, which is why those two stand alone and
//!   never appear beside `==`.

use std::sync::Arc;

use regex::Regex;

use super::filter::{resolve, Budget, Cursor, Operand, Query};
use super::values::{value_of, Literal, Value};
use crate::error::{Error, Result};
use crate::tree::index::TreeIndex;

/// What a function takes and gives back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Value,
    Nodes,
    Logical,
}

impl Ty {
    fn name(self) -> &'static str {
        match self {
            Ty::Value => "a value",
            Ty::Nodes => "a query",
            Ty::Logical => "a test",
        }
    }
}

/// One function's shape. The table below is the only place these are stated.
struct Signature {
    name: &'static str,
    params: &'static [Ty],
    returns: Ty,
}

const SIGNATURES: [Signature; 5] = [
    Signature { name: "length", params: &[Ty::Value], returns: Ty::Value },
    Signature { name: "count", params: &[Ty::Nodes], returns: Ty::Value },
    Signature {
        name: "match",
        params: &[Ty::Value, Ty::Value],
        returns: Ty::Logical,
    },
    Signature {
        name: "search",
        params: &[Ty::Value, Ty::Value],
        returns: Ty::Logical,
    },
    Signature { name: "value", params: &[Ty::Nodes], returns: Ty::Value },
];

/// A call, with its types already settled.
#[derive(Debug, Clone)]
pub struct Call {
    pub name: &'static str,
    pub args: Vec<Arg>,
    pub returns: Ty,
    /// The pattern of a `match`/`search` whose second argument was written
    /// out, compiled once here rather than once per candidate node.
    pub pattern: Option<Arc<Regex>>,
}

impl PartialEq for Call {
    /// Two calls are the same call when they were written the same way. The
    /// compiled pattern is derived from the arguments, so comparing it would
    /// only ask the same question twice — and `Regex` has no equality anyway.
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && self.args == other.args
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Query(Query),
    Literal(Literal),
    Call(Call),
}

impl Arg {
    /// Which of the three types this argument is.
    fn ty(&self) -> Ty {
        match self {
            // A query is nodes. It is *also* a value when it is singular, and
            // `fits` is where that second reading is allowed.
            Arg::Query(_) => Ty::Nodes,
            Arg::Literal(_) => Ty::Value,
            Arg::Call(call) => call.returns,
        }
    }

    /// Whether this argument may stand in a `wanted` position.
    fn fits(&self, wanted: Ty) -> bool {
        match (wanted, self) {
            // A singular query selects at most one node, which is a value.
            // A wider one is not — `length(@.*)` has no single thing to
            // measure, and the RFC refuses it rather than picking one.
            (Ty::Value, Arg::Query(query)) => query.singular,
            (Ty::Value, _) => self.ty() == Ty::Value,
            // Only a query is a list of nodes. `count(1)` is asking how many
            // nodes a literal is, which is not a question.
            (Ty::Nodes, Arg::Query(_)) => true,
            (Ty::Nodes, _) => false,
            (Ty::Logical, _) => self.ty() == Ty::Logical,
        }
    }
}

/// Read `name(...)`, with the cursor just past the name.
///
/// The arguments are read by the filter parser — it owns the text — and the
/// rules about what may be one live here.
pub fn parse_call(cursor: &mut Cursor<'_>, name: &str) -> Result<Call> {
    let Some(signature) = SIGNATURES.iter().find(|s| s.name == name) else {
        return Err(cursor.here(&format!("`{name}()` is not a function this knows")));
    };
    if !cursor.eat("(") {
        return Err(cursor.here(&format!("`{name}` needs a `(` after it")));
    }

    let mut args = Vec::new();
    if !cursor.eat(")") {
        loop {
            args.push(match cursor.comparable()? {
                Operand::Query(query) => Arg::Query(query),
                Operand::Literal(literal) => Arg::Literal(literal),
                Operand::Function(call) => Arg::Call(call),
            });
            if cursor.eat(",") {
                continue;
            }
            if !cursor.eat(")") {
                return Err(cursor.here(&format!("`{name}(` with no `)`")));
            }
            break;
        }
    }

    if args.len() != signature.params.len() {
        return Err(cursor.here(&format!(
            "`{name}()` takes {} argument(s), not {}",
            signature.params.len(),
            args.len()
        )));
    }
    for (at, (arg, wanted)) in args.iter().zip(signature.params).enumerate() {
        if !arg.fits(*wanted) {
            return Err(cursor.here(&format!(
                "argument {} of `{name}()` has to be {}",
                at + 1,
                wanted.name()
            )));
        }
    }

    // A pattern written out in the expression is the same for every node, so
    // it is compiled once, here. One written as a query is not known until a
    // node is in hand; see `regex_for`.
    let pattern = match (name, args.get(1)) {
        ("match" | "search", Some(Arg::Literal(Literal::Str(text)))) => {
            Some(Arc::new(compile(name, text)?))
        }
        _ => None,
    };

    Ok(Call {
        name: signature.name,
        args,
        returns: signature.returns,
        pattern,
    })
}

/// Build the regex a `match` or a `search` needs.
///
/// `match` is anchored and `search` is not — that is the only difference
/// between the two, and the RFC states it exactly this way. The group around
/// the pattern matters: without it `match(@.a, "a|b")` would anchor only the
/// `a`, and `"b"` alone would match anywhere.
///
/// Case folding is off. I-Regexp has no case-insensitive mode, so a pattern
/// that matched `"ABC"` against `"abc"` would be answering a question the
/// expression did not ask.
fn compile(name: &str, pattern: &str) -> Result<Regex> {
    let source = if name == "match" {
        format!("^(?:{pattern})$")
    } else {
        pattern.to_owned()
    };
    crate::query::compile(&source, true)
}

// --- asking the question ---------------------------------------------------

/// Evaluate a call that gives back a value.
///
/// The result borrows from the document and from the expression, which is
/// what keeps a filter from copying a string per candidate. Neither outlives
/// the walk: the bytes are mapped for the search and the `Call` is part of the
/// parsed expression being walked, so tying both to one `'a` costs nothing and
/// says what is true.
pub fn value<'a>(
    index: &TreeIndex,
    bytes: &'a [u8],
    call: &'a Call,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<Value<'a>> {
    match call.name {
        // The number of code points in a string, of members in an object, of
        // elements in an array — and nothing at all for anything else, which
        // is the RFC's answer rather than an error. `length(1)` is not wrong
        // to ask, it just has no answer, and Nothing compares like one.
        "length" => Ok(match argument(index, bytes, call, 0, current, budget)? {
            Value::Str(text) => Value::Int(text.chars().count() as i64),
            Value::Composite { count } => Value::Int(i64::from(count)),
            _ => Value::Nothing,
        }),
        // How many nodes the query selected. This is the one place a query
        // that selects many is what was wanted.
        "count" => {
            let found = nodes(index, bytes, call, 0, current, budget)?;
            Ok(Value::Int(found.len() as i64))
        }
        // Exactly one node has a value; none and several do not. "Several"
        // being Nothing rather than an error is what lets `value(@..a)` be
        // written at all — it is the RFC's way of asking "is there exactly
        // one, and what is it".
        "value" => {
            let found = nodes(index, bytes, call, 0, current, budget)?;
            Ok(match found.as_slice() {
                [only] => value_of(bytes, index, *only),
                _ => Value::Nothing,
            })
        }
        // The type check above is what keeps `match` and `search` out of here.
        // An error rather than a panic: this runs on a search worker, and a
        // gap in the rules should refuse the query, not take the thread down.
        other => Err(Error::BadPath {
            detail: format!("`{other}()` does not give back a value"),
        }),
    }
}

/// Evaluate a call that gives back true or false.
pub fn test(
    index: &TreeIndex,
    bytes: &[u8],
    call: &Call,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<bool> {
    let subject = argument(index, bytes, call, 0, current, budget)?;
    let Value::Str(subject) = subject else {
        // Neither a number nor an object is text to match against, and the
        // RFC says so as false rather than as an error.
        return Ok(false);
    };
    let pattern = argument(index, bytes, call, 1, current, budget)?;

    let regex = match (&call.pattern, &pattern) {
        (Some(compiled), _) => Some(Arc::clone(compiled)),
        (None, Value::Str(text)) => regex_for(call.name, text, budget),
        (None, _) => None,
    };
    // A pattern that is not a string, or not a valid regex, matches nothing.
    // The RFC is explicit that an invalid I-Regexp is false rather than an
    // error: the pattern came out of the document, and one bad row should not
    // take down the whole query.
    Ok(regex.is_some_and(|regex| regex.is_match(&subject)))
}

/// The compiled form of a pattern that came from the document.
///
/// Cached one deep, which is all it takes: every candidate looks at the same
/// `$.pattern`, so the second lookup onwards hits. Compiling per candidate
/// would put a regex build inside the walk.
fn regex_for(name: &str, pattern: &str, budget: &mut Budget<'_>) -> Option<Arc<Regex>> {
    if let Some((cached, regex)) = budget.regex.as_ref() {
        if cached == pattern {
            return Some(Arc::clone(regex));
        }
    }
    let regex = Arc::new(compile(name, pattern).ok()?);
    budget.regex = Some((pattern.to_owned(), Arc::clone(&regex)));
    Some(regex)
}

/// One argument, as a value.
///
/// Borrowed, never copied. A literal is read out of the `Call` itself and a
/// query out of the document's bytes; both live as long as the walk, so the
/// only string this ever allocates is one an escape forced `value_of` to
/// decode.
fn argument<'a>(
    index: &TreeIndex,
    bytes: &'a [u8],
    call: &'a Call,
    at: usize,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<Value<'a>> {
    match &call.args[at] {
        Arg::Literal(literal) => Ok(Value::from(literal)),
        Arg::Call(inner) => value(index, bytes, inner, current, budget),
        // Singular by the type check above, so at most one node.
        Arg::Query(query) => {
            let found = resolve(index, bytes, query, current, budget)?;
            Ok(match found.first() {
                Some(&id) => value_of(bytes, index, id),
                None => Value::Nothing,
            })
        }
    }
}

/// One argument, as the nodes it selects.
fn nodes(
    index: &TreeIndex,
    bytes: &[u8],
    call: &Call,
    at: usize,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<Vec<u32>> {
    match &call.args[at] {
        Arg::Query(query) => resolve(index, bytes, query, current, budget),
        // The type check above admits only a query here.
        _ => Err(Error::BadPath {
            detail: format!("`{}()` needs a query", call.name),
        }),
    }
}

/// That a value is *borrowed* is the whole of this module's cost, and nothing
/// about the answers it gives would change if it were copied.
///
/// So the ordinary tests cannot see it: `length(@.name)` is 5 either way. The
/// assertion has to be about the shape the value comes back in, which is why
/// these look at `Cow` variants rather than at results. "It is fast" needs a
/// benchmark; "it does not copy" is something the type can be asked.
#[cfg(test)]
mod borrowing {
    use std::borrow::Cow;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use super::super::filter::{parse_filter, Expr};
    use super::*;
    use crate::tree::index::Syntax;
    use crate::tree::scanner::{scan, ScanLimits};

    /// `esc` is the only value here that cannot be handed back as it lies.
    const DOC: &str = r#"{"name":"plain","esc":"a\nb"}"#;

    fn index() -> Arc<TreeIndex> {
        let scanned =
            scan(DOC.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).expect("scan");
        Arc::new(TreeIndex::new(scanned.nodes, scanned.synthetic_root, Syntax::Json))
    }

    /// The call inside a filter, so these test what the parser actually builds.
    fn call_of(source: &str) -> Call {
        match parse_filter("$[?...]", source).expect("parse") {
            Expr::Test(call) => call,
            Expr::Compare(left, _, _) => match *left {
                Operand::Function(call) => call,
                other => panic!("not a call: {other:?}"),
            },
            other => panic!("not a call: {other:?}"),
        }
    }

    fn ask<'a>(index: &TreeIndex, call: &'a Call, at: usize) -> Value<'a> {
        let idle = AtomicBool::new(false);
        argument(index, DOC.as_bytes(), call, at, 0, &mut Budget::new(&idle)).expect("argument")
    }

    #[test]
    fn a_string_with_no_escape_is_read_where_it_lies() {
        let index = index();
        let call = call_of("length(@.name) > 0");
        let value = ask(&index, &call, 0);
        assert!(
            matches!(value, Value::Str(Cow::Borrowed("plain"))),
            "a copy crept back in: {value:?}"
        );
    }

    #[test]
    fn an_escape_is_the_one_thing_that_has_to_be_built() {
        let index = index();
        let call = call_of("length(@.esc) > 0");
        let value = ask(&index, &call, 0);
        // `a\nb` in the file is three characters here, and no span of the
        // document holds them — this one allocation is the decode itself.
        assert!(
            matches!(&value, Value::Str(Cow::Owned(text)) if text == "a\nb"),
            "{value:?}"
        );
    }

    #[test]
    fn a_literal_is_read_out_of_the_expression() {
        let index = index();
        let call = call_of("match(@.name, 'needle')");
        let value = ask(&index, &call, 1);
        assert!(
            matches!(value, Value::Str(Cow::Borrowed("needle"))),
            "the literal was copied out of its own call: {value:?}"
        );
    }

    #[test]
    fn the_document_is_what_a_borrowed_value_points_into() {
        let index = index();
        let call = call_of("length(@.name) > 0");
        let Value::Str(Cow::Borrowed(text)) = ask(&index, &call, 0) else {
            panic!("not borrowed");
        };
        // Not merely equal to `plain` — the same bytes. Anything that copied
        // on the way here would be equal and somewhere else entirely.
        let at = text.as_ptr() as usize - DOC.as_ptr() as usize;
        assert_eq!(&DOC[at..at + text.len()], "plain");
    }
}
