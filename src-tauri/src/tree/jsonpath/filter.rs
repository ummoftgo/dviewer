//! Filter expressions: `[?@.price < 10]`.
//!
//! A filter asks a question of every child and keeps the ones that answer yes.
//! Everything else in an expression narrows by *place* — this is the one step
//! that narrows by what a node holds, which is why it is the only one that has
//! to read values at all.
//!
//! This file is the question: the shape it can take, and how the text becomes
//! that shape. Asking it of a node is `select`'s job.
//!
//! The grammar is RFC 9535 §2.3.5.1, and the shape of the code follows it:
//! `or` over `and` over a basic expression, where a basic expression is a
//! parenthesised one, a comparison, or a bare query that is true when it finds
//! something. Following the RFC's layering rather than inventing one is what
//! makes `!`, `&&` and `||` bind the way a reader expects.

use std::sync::atomic::{AtomicBool, Ordering};

use super::{bad, unsupported, Step};
use crate::error::{Error, Result};
use crate::tree::index::TreeIndex;
use crate::tree::scanner::Kind;
use crate::tree::text;

/// A question about one node.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Or(Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    /// A query with nothing compared to it: true when it selects anything.
    /// `[?@.isbn]` is every child that has an `isbn` at all.
    Exists(Query),
    Compare(Box<Operand>, Op, Box<Operand>),
}

/// One side of a comparison.
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    Query(Query),
    Literal(Literal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Where a query starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Root {
    /// `@` — the node being asked about.
    Current,
    /// `$` — the whole document, so a filter can compare against something
    /// outside the run it is filtering (`[?@.price > $.expensive]`).
    Document,
}

/// A path relative to `@` or `$`.
///
/// `singular` is decided here rather than at evaluation time, which is how the
/// RFC defines it: a query made only of names and indices selects at most one
/// node *whatever document it runs against*, so it is the syntax that says so.
/// Deciding it here also means a comparison against `@.items[*]` is refused
/// while the reader is still looking at what they typed, rather than answering
/// for some documents and failing for others.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub root: Root,
    pub steps: Vec<Step>,
    pub singular: bool,
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

/// The names this does not have, and what a reader who wrote one is told.
///
/// Refused rather than ignored: a filter that quietly drops a `length()` would
/// answer a different question than the one asked, and look like it answered
/// the right one.
const FUNCTIONS: [&str; 5] = ["length", "count", "match", "search", "value"];

/// Parse the inside of a `[?...]`, with `source` only for error messages.
pub fn parse_filter(source: &str, body: &str) -> Result<Expr> {
    let mut cursor = Cursor {
        source,
        text: body,
        at: 0,
    };
    let expr = cursor.or_expr()?;
    cursor.spaces();
    if cursor.rest().is_empty() {
        Ok(expr)
    } else {
        Err(cursor.here("the filter goes on after it has finished"))
    }
}

struct Cursor<'a> {
    /// The whole expression, so an error can quote what was typed.
    source: &'a str,
    text: &'a str,
    at: usize,
}

impl<'a> Cursor<'a> {
    fn rest(&self) -> &'a str {
        &self.text[self.at..]
    }

    fn spaces(&mut self) {
        let trimmed = self.rest().trim_start();
        self.at = self.text.len() - trimmed.len();
    }

    /// Whether the next thing is `token`, and step over it if so.
    fn eat(&mut self, token: &str) -> bool {
        self.spaces();
        if self.rest().starts_with(token) {
            self.at += token.len();
            return true;
        }
        false
    }

    fn here(&self, why: &str) -> crate::error::Error {
        bad(self.source, &format!("{why} (in the filter, at {})", self.at + 1))
    }

    // --- the grammar, outermost first -------------------------------------

    fn or_expr(&mut self) -> Result<Expr> {
        let mut left = self.and_expr()?;
        while self.eat("||") {
            let right = self.and_expr()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and_expr(&mut self) -> Result<Expr> {
        let mut left = self.basic_expr()?;
        while self.eat("&&") {
            let right = self.basic_expr()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    /// A parenthesised expression, a comparison, or a bare query.
    ///
    /// `!` belongs to this level and to the two things below it, which is the
    /// RFC's own shape: `!@.a` and `!(a || b)` are expressions, `!@.a == 1` is
    /// not. Reading it any other way would make `!` bind looser than `==` and
    /// surprise anyone who writes both.
    fn basic_expr(&mut self) -> Result<Expr> {
        if self.eat("!") {
            // `!=` is one operator, not a negation followed by something.
            if self.rest().starts_with('=') {
                return Err(self.here("`!=` needs something on its left"));
            }
            let inner = self.paren_or_test()?;
            return Ok(Expr::Not(Box::new(inner)));
        }
        self.paren_or_comparison()
    }

    /// What `!` may be put in front of: a parenthesis or a bare query.
    fn paren_or_test(&mut self) -> Result<Expr> {
        if self.eat("(") {
            let inner = self.or_expr()?;
            if !self.eat(")") {
                return Err(self.here("a `(` with no `)`"));
            }
            return Ok(inner);
        }
        match self.comparable()? {
            Operand::Query(query) => Ok(Expr::Exists(query)),
            Operand::Literal(_) => Err(self.here("`!` needs a query or a `(` after it")),
        }
    }

    fn paren_or_comparison(&mut self) -> Result<Expr> {
        if self.eat("(") {
            let inner = self.or_expr()?;
            if !self.eat(")") {
                return Err(self.here("a `(` with no `)`"));
            }
            return Ok(inner);
        }

        let left = self.comparable()?;
        let Some(op) = self.operator() else {
            // Nothing to compare with, so this is an existence test — which
            // only a query can be. A bare `1` is not a question.
            return match left {
                Operand::Query(query) => Ok(Expr::Exists(query)),
                Operand::Literal(_) => {
                    Err(self.here("a value on its own is not a test; compare it to something"))
                }
            };
        };
        let right = self.comparable()?;

        for side in [&left, &right] {
            if let Operand::Query(query) = side {
                if !query.singular {
                    return Err(unsupported(
                        self.source,
                        "comparisons against a query that can select more than one node \
                         (a wildcard, a slice, a filter or `..` inside `[?...]`)",
                    ));
                }
            }
        }
        Ok(Expr::Compare(Box::new(left), op, Box::new(right)))
    }

    fn operator(&mut self) -> Option<Op> {
        self.spaces();
        // The two-character ones first: `<` is a prefix of `<=`.
        for (token, op) in [
            ("==", Op::Eq),
            ("!=", Op::Ne),
            ("<=", Op::Le),
            (">=", Op::Ge),
            ("<", Op::Lt),
            (">", Op::Gt),
        ] {
            if self.rest().starts_with(token) {
                self.at += token.len();
                return Some(op);
            }
        }
        None
    }

    // --- the leaves --------------------------------------------------------

    fn comparable(&mut self) -> Result<Operand> {
        self.spaces();
        let rest = self.rest();
        match rest.chars().next() {
            Some('@') => {
                self.at += 1;
                Ok(Operand::Query(self.query(Root::Current)?))
            }
            Some('$') => {
                self.at += 1;
                Ok(Operand::Query(self.query(Root::Document)?))
            }
            Some('\'') | Some('"') => Ok(Operand::Literal(self.string()?)),
            Some(ch) if ch == '-' || ch.is_ascii_digit() => Ok(Operand::Literal(self.number()?)),
            Some(ch) if ch.is_ascii_alphabetic() => self.word(),
            _ => Err(self.here("expected a value or a query")),
        }
    }

    /// `true`, `false`, `null` — or a function name, which is refused by name.
    fn word(&mut self) -> Result<Operand> {
        let rest = self.rest();
        let end = rest
            .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
            .unwrap_or(rest.len());
        let word = &rest[..end];

        if let Some(name) = FUNCTIONS.iter().find(|name| **name == word) {
            return Err(unsupported(
                self.source,
                &format!("the function `{name}()`"),
            ));
        }
        let literal = match word {
            "true" => Literal::Bool(true),
            "false" => Literal::Bool(false),
            "null" => Literal::Null,
            other => return Err(self.here(&format!("`{other}` is not a value"))),
        };
        self.at += end;
        Ok(Operand::Literal(literal))
    }

    /// The steps after `@` or `$`, and whether they can select only one node.
    fn query(&mut self, root: Root) -> Result<Query> {
        let mut steps = Vec::new();
        let mut singular = true;
        loop {
            if self.rest().starts_with('.') && !self.rest().starts_with("..") {
                self.at += 1;
                let rest = self.rest();
                if rest.starts_with('*') {
                    self.at += 1;
                    steps.push(Step::Any);
                    singular = false;
                    continue;
                }
                let Some(name) = self.name() else {
                    return Err(self.here("a `.` needs a name after it"));
                };
                steps.push(Step::Key(name));
                continue;
            }
            if self.rest().starts_with("..") {
                self.at += 2;
                steps.push(Step::Descend);
                singular = false;
                // `..` may be followed by a name, the way it is outside a
                // filter. Leaving it to the loop would stop at the name and
                // call the rest of the filter leftovers.
                if let Some(name) = self.name() {
                    steps.push(Step::Key(name));
                }
                continue;
            }
            if self.rest().starts_with('[') {
                let inner = self.bracket_body()?;
                let step = super::parse::bracket_step(self.source, &inner)?;
                if !matches!(step, Step::Key(_) | Step::Index(_)) {
                    singular = false;
                }
                steps.push(step);
                continue;
            }
            break;
        }
        Ok(Query {
            root,
            steps,
            singular,
        })
    }

    /// A bare name, if one starts here.
    fn name(&mut self) -> Option<String> {
        let rest = self.rest();
        let end = rest
            .find(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
            .unwrap_or(rest.len());
        if end == 0 {
            return None;
        }
        self.at += end;
        Some(rest[..end].to_owned())
    }

    /// The text inside a `[...]`, quotes and nesting respected.
    fn bracket_body(&mut self) -> Result<String> {
        let rest = self.rest();
        let mut quote: Option<char> = None;
        let mut depth = 0usize;
        for (at, ch) in rest.char_indices() {
            match quote {
                Some(q) if ch == q => quote = None,
                Some(_) => {}
                None => match ch {
                    '\'' | '"' => quote = Some(ch),
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            self.at += at + 1;
                            return Ok(rest[1..at].to_owned());
                        }
                    }
                    _ => {}
                },
            }
        }
        Err(self.here("a `[` with no `]`"))
    }

    fn string(&mut self) -> Result<Literal> {
        let rest = self.rest();
        let mark = rest.chars().next().expect("a quote is here");
        let mut out = String::new();
        let mut chars = rest.char_indices().skip(1);

        while let Some((at, ch)) = chars.next() {
            match ch {
                ch if ch == mark => {
                    self.at += at + ch.len_utf8();
                    return Ok(Literal::Str(out));
                }
                '\\' => {
                    let Some((_, escaped)) = chars.next() else { break };
                    match escaped {
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'u' => {
                            let hex: String = (&mut chars).take(4).map(|(_, c)| c).collect();
                            let code = u32::from_str_radix(&hex, 16)
                                .ok()
                                .and_then(char::from_u32)
                                .ok_or_else(|| self.here("a `\\u` needs four hex digits"))?;
                            out.push(code);
                        }
                        // `\\`, `\'`, `\"`, `\/` and anything else stand for
                        // themselves. A viewer is better off reading an odd
                        // escape literally than refusing the query over it.
                        other => out.push(other),
                    }
                }
                other => out.push(other),
            }
        }
        Err(self.here("a quote with no closing quote"))
    }

    fn number(&mut self) -> Result<Literal> {
        let rest = self.rest();
        let end = rest
            .find(|ch: char| !matches!(ch, '0'..='9' | '-' | '+' | '.' | 'e' | 'E'))
            .unwrap_or(rest.len());
        let text = &rest[..end];
        self.at += end;

        // A whole number stays whole unless it does not fit, and then it
        // becomes a float rather than an error — refusing a query over the
        // width of one of its numbers would be a strange place to stop.
        if !text.contains(['.', 'e', 'E']) {
            if let Ok(whole) = text.parse::<i64>() {
                return Ok(Literal::Int(whole));
            }
        }
        text.parse::<f64>()
            .map(Literal::Float)
            .map_err(|_| bad(self.source, &format!("`{text}` is not a number")))
    }
}


// --- asking the question ---------------------------------------------------

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
    Str(std::borrow::Cow<'a, str>),
    /// An object or an array. Comparing two of those means deep equality,
    /// which this does not do — see `compare`.
    Composite,
}

/// Whether `expr` is true of the node `current`.
pub(crate) fn matches(
    index: &TreeIndex,
    bytes: &[u8],
    expr: &Expr,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<bool> {
    budget.tick()?;
    match expr {
        // Short-circuiting, which is not only speed: `@.a && @.a[0] == 1`
        // leans on the left side to keep the right side from being asked.
        Expr::Or(left, right) => Ok(matches(index, bytes, left, current, budget)?
            || matches(index, bytes, right, current, budget)?),
        Expr::And(left, right) => Ok(matches(index, bytes, left, current, budget)?
            && matches(index, bytes, right, current, budget)?),
        Expr::Not(inner) => Ok(!matches(index, bytes, inner, current, budget)?),
        Expr::Exists(query) => {
            let found = resolve(index, bytes, query, current, budget)?;
            Ok(!found.is_empty())
        }
        Expr::Compare(left, op, right) => {
            let left = operand(index, bytes, left, current, budget)?;
            let right = operand(index, bytes, right, current, budget)?;
            compare(&left, *op, &right)
        }
    }
}

/// The nodes a query inside a filter selects.
fn resolve(
    index: &TreeIndex,
    bytes: &[u8],
    query: &Query,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<Vec<u32>> {
    let from = match query.root {
        Root::Current => current,
        Root::Document => 0,
    };
    super::select::select_from(index, bytes, vec![from], &query.steps, budget)
}

fn operand<'a>(
    index: &TreeIndex,
    bytes: &'a [u8],
    operand: &'a Operand,
    current: u32,
    budget: &mut Budget<'_>,
) -> Result<Value<'a>> {
    match operand {
        Operand::Literal(Literal::Str(text)) => Ok(Value::Str(std::borrow::Cow::Borrowed(text))),
        Operand::Literal(Literal::Int(n)) => Ok(Value::Int(*n)),
        Operand::Literal(Literal::Float(n)) => Ok(Value::Float(*n)),
        Operand::Literal(Literal::Bool(b)) => Ok(Value::Bool(*b)),
        Operand::Literal(Literal::Null) => Ok(Value::Null),
        Operand::Query(query) => {
            let found = resolve(index, bytes, query, current, budget)?;
            // A singular query, so at most one — and the parser has already
            // refused the shapes that could give more.
            match found.first() {
                None => Ok(Value::Nothing),
                Some(&id) => Ok(value_of(bytes, index, id)),
            }
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
fn value_of<'a>(bytes: &'a [u8], index: &TreeIndex, id: u32) -> Value<'a> {
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
                Value::Str(std::borrow::Cow::Owned(
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
        // or an array is a thing you can test the existence of, not compare.
        _ => Value::Composite,
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
fn compare(left: &Value<'_>, op: Op, right: &Value<'_>) -> Result<bool> {
    if matches!(left, Value::Composite) || matches!(right, Value::Composite) {
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

/// How much walking is allowed before the reader is asked again.
///
/// A filter is the one step whose cost follows the size of the file rather
/// than the size of its answer: `$..[?@.id > 1]` asks the question of every
/// node there is. So it has to be interruptible, and the flag is read every
/// few thousand nodes rather than every node — an atomic load per node would
/// be the most expensive thing in the walk.
pub(crate) struct Budget<'a> {
    cancel: &'a AtomicBool,
    seen: u32,
}

/// Chosen the way the table search chose its own: often enough that a click
/// feels answered, rarely enough to disappear into the walk.
const CHECK_EVERY: u32 = 4_096;

impl<'a> Budget<'a> {
    pub(crate) fn new(cancel: &'a AtomicBool) -> Self {
        Self { cancel, seen: 0 }
    }

    pub(crate) fn tick(&mut self) -> Result<()> {
        self.seen += 1;
        if self.seen % CHECK_EVERY == 0 && self.cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        Ok(())
    }

    /// For the steps that are not filters, which need no budget of their own.
    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn expr(body: &str) -> Expr {
        parse_filter("$[?...]", body).expect("parse")
    }

    fn at(name: &str) -> Query {
        Query {
            root: Root::Current,
            steps: vec![Step::Key(name.to_owned())],
            singular: true,
        }
    }

    #[test]
    fn an_existence_test_is_a_query_with_nothing_to_compare() {
        assert_eq!(expr("@.isbn"), Expr::Exists(at("isbn")));
        assert_eq!(expr("@['isbn']"), Expr::Exists(at("isbn")));
        assert_eq!(expr("!@.isbn"), Expr::Not(Box::new(Expr::Exists(at("isbn")))));

        // Not singular, which an existence test does not need to be.
        assert_eq!(
            expr("@.items[*]"),
            Expr::Exists(Query {
                root: Root::Current,
                steps: vec![Step::Key("items".into()), Step::Any],
                singular: false,
            })
        );
    }

    #[test]
    fn the_six_comparisons_and_the_values_they_take() {
        let cases = [
            ("@.a == 1", Op::Eq, Literal::Int(1)),
            ("@.a != 1", Op::Ne, Literal::Int(1)),
            ("@.a < 1", Op::Lt, Literal::Int(1)),
            ("@.a <= 1", Op::Le, Literal::Int(1)),
            ("@.a > 1", Op::Gt, Literal::Int(1)),
            ("@.a >= 1", Op::Ge, Literal::Int(1)),
            ("@.a == 'x'", Op::Eq, Literal::Str("x".into())),
            ("@.a == \"x\"", Op::Eq, Literal::Str("x".into())),
            ("@.a == true", Op::Eq, Literal::Bool(true)),
            ("@.a == false", Op::Eq, Literal::Bool(false)),
            ("@.a == null", Op::Eq, Literal::Null),
            ("@.a == -2", Op::Eq, Literal::Int(-2)),
            ("@.a == 1.5", Op::Eq, Literal::Float(1.5)),
            ("@.a == 1e3", Op::Eq, Literal::Float(1000.0)),
        ];
        for (source, op, literal) in cases {
            assert_eq!(
                expr(source),
                Expr::Compare(
                    Box::new(Operand::Query(at("a"))),
                    op,
                    Box::new(Operand::Literal(literal.clone()))
                ),
                "{source}"
            );
        }

        // Spaces are optional, and either side may be the literal.
        assert_eq!(expr("@.a==1"), expr("@.a  ==  1"));
        assert_eq!(
            expr("1 == @.a"),
            Expr::Compare(
                Box::new(Operand::Literal(Literal::Int(1))),
                Op::Eq,
                Box::new(Operand::Query(at("a")))
            )
        );
    }

    /// An integer that does not fit becomes a float rather than an error.
    #[test]
    fn a_number_too_wide_for_an_integer_is_still_a_number() {
        let Expr::Compare(_, _, right) = expr("@.a == 99999999999999999999") else {
            panic!("expected a comparison");
        };
        assert!(matches!(*right, Operand::Literal(Literal::Float(_))));
    }

    #[test]
    fn and_binds_tighter_than_or() {
        // a || (b && c), not (a || b) && c
        assert_eq!(
            expr("@.a || @.b && @.c"),
            Expr::Or(
                Box::new(Expr::Exists(at("a"))),
                Box::new(Expr::And(
                    Box::new(Expr::Exists(at("b"))),
                    Box::new(Expr::Exists(at("c")))
                ))
            )
        );
        // And parentheses say otherwise.
        assert_eq!(
            expr("(@.a || @.b) && @.c"),
            Expr::And(
                Box::new(Expr::Or(
                    Box::new(Expr::Exists(at("a"))),
                    Box::new(Expr::Exists(at("b")))
                )),
                Box::new(Expr::Exists(at("c")))
            )
        );
        // `!` binds to what follows it, not to the comparison after that.
        assert_eq!(
            expr("!(@.a == 1)"),
            Expr::Not(Box::new(Expr::Compare(
                Box::new(Operand::Query(at("a"))),
                Op::Eq,
                Box::new(Operand::Literal(Literal::Int(1)))
            )))
        );
    }

    /// The absolute root, which is what lets a filter compare against
    /// something outside the run it is filtering.
    #[test]
    fn a_filter_may_reach_the_whole_document() {
        assert_eq!(
            expr("@.price > $.expensive"),
            Expr::Compare(
                Box::new(Operand::Query(at("price"))),
                Op::Gt,
                Box::new(Operand::Query(Query {
                    root: Root::Document,
                    steps: vec![Step::Key("expensive".into())],
                    singular: true,
                }))
            )
        );
    }

    #[test]
    fn a_string_literal_keeps_what_is_escaped_in_it() {
        let text = |source| match expr(source) {
            Expr::Compare(_, _, right) => match *right {
                Operand::Literal(Literal::Str(text)) => text,
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        };
        assert_eq!(text(r"@.a == 'it\'s'"), "it's");
        assert_eq!(text(r"@.a == 'a\\b'"), r"a\b");
        assert_eq!(text(r"@.a == 'a\nb'"), "a\nb");
        assert_eq!(text(r"@.a == 'A'"), "A");
        assert_eq!(text("@.a == '가나다'"), "가나다");
        assert_eq!(text("@.a == 'x,y'"), "x,y", "a comma is just a character");
    }

    /// The functions are named, not silently dropped.
    #[test]
    fn the_functions_this_does_not_have_are_refused_by_name() {
        for (source, expected) in [
            ("length(@.a) > 2", "length()"),
            ("count(@.a[*]) == 1", "count()"),
            ("match(@.a, 'x')", "match()"),
            ("search(@.a, 'x')", "search()"),
            ("value(@.a) == 1", "value()"),
        ] {
            match parse_filter("$[?...]", source) {
                Err(Error::BadPath { detail }) => {
                    assert!(detail.contains(expected), "{source} said {detail}")
                }
                other => panic!("{source} gave {other:?}"),
            }
        }
    }

    /// A comparison needs a side that can only be one node. This is decided
    /// from the text, so it is the same answer for every document.
    #[test]
    fn a_comparison_against_many_nodes_is_refused() {
        for source in ["@.items[*] == 1", "@..a == 1", "1 == @.items[0:2]"] {
            match parse_filter("$[?...]", source) {
                // The whole sentence, not a word of it: this message is read
                // by whoever wrote the query, and a line-continuation slip in
                // it leaves a run of spaces that only a reader would notice.
                Err(Error::BadPath { detail }) => assert!(
                    detail.contains(
                        "more than one node (a wildcard, a slice, a filter or `..` inside `[?...]`) are not supported yet"
                    ),
                    "{source} said {detail}"
                ),
                other => panic!("{source} gave {other:?}"),
            }
        }
    }

    #[test]
    fn a_filter_that_is_not_an_expression_is_refused() {
        for source in [
            "",
            "@.a ==",
            "== 1",
            "@.a == 1 @.b",
            "(@.a",
            "@.a &&",
            "!1",
            "1",
            "@.",
            "maybe",
            "@.a === 1",
        ] {
            assert!(
                matches!(parse_filter("$[?...]", source), Err(Error::BadPath { .. })),
                "{source:?} should not parse"
            );
        }
    }
}
