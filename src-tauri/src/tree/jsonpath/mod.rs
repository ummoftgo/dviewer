//! Selecting nodes by a JSONPath expression.
//!
//! A path *search* asks "which paths contain this text"; a path *expression*
//! asks "which nodes are at this place". The first is a substring match and
//! stays exactly as it was; this is the second, and it is a separate reading of
//! the same box rather than a replacement — see `query::Interpretation`.
//!
//! Evaluated over the flat index, not over a parsed document. Every crate that
//! does JSONPath expects a `serde_json::Value`, which is the one thing this
//! viewer never builds: the whole design is that a 500MB file is an index over
//! bytes. Walking the index instead costs nothing extra, because the index
//! already knows a node's children and its key.
//!
//! **Every selector RFC 9535 defines**, and every function it defines. `$`,
//! `.key`, `["key"]`, `[n]` (from either end), `[start:end:step]`, `[a, b]`,
//! `[?<expr>]`, `[*]`, `.*`, `..`, and `length()`, `count()`, `match()`,
//! `search()`, `value()` inside a filter. What is not here is comparing whole
//! objects or arrays, which is an error rather than a quietly different
//! answer — a wrong answer that looks like an answer is the worst thing this
//! could do.
//!
//! One deliberate departure: the RFC lets a union hand back the same node
//! twice (`[0, 0]`), and this does not. A viewer highlights nodes, and
//! highlighting one twice says nothing — results are in document order with no
//! repeats, the way every other step here already worked.

//! Split by concern: `parse` turns the text into steps, `select` walks the
//! index applying them. What is shared is here — the step type both sides
//! speak in, and the one error this module can raise.

mod filter;
mod functions;
pub(crate) mod parse;
mod select;

pub use filter::Expr;
pub use parse::parse;
pub use select::select;

use crate::error::Error;

/// One step of an expression.
/// Not `Eq`: a filter may hold a floating-point literal, and `f64` is not.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// `.name` or `["name"]` — the children of an object under that key.
    Key(String),
    /// `[n]` — the nth child, counted the way the file writes it. Negative
    /// counts from the end, so `[-1]` is the last child.
    Index(i64),
    /// `[start:end:step]` — a run of children. Any of the three may be left
    /// out, and `step` may be negative; see `select::slice_stride` for what
    /// the combinations mean.
    Slice {
        start: Option<i64>,
        end: Option<i64>,
        step: i64,
    },
    /// `[*]` or `.*` — every child.
    Any,
    /// `[?<expr>]` — the children the expression is true of.
    Filter(Expr),
    /// `[a, b, …]` — everything any of the selectors inside names.
    ///
    /// Holds steps rather than a narrower type of its own, because the things
    /// a comma may separate are exactly the things a bracket may hold. The
    /// parser is what keeps that true: it builds a union only out of what it
    /// read inside one `[...]`, so `Descend` and a nested `Union` never
    /// appear here, and a bracket with one selector in it is that selector
    /// rather than a union of one.
    Union(Vec<Step>),
    /// `..` — the node itself and everything under it, which the next step
    /// then applies to. On its own at the end it selects the whole subtree.
    Descend,
}

fn bad(source: &str, why: &str) -> Error {
    Error::BadPath {
        detail: format!("{source}: {why}"),
    }
}

fn unsupported(source: &str, what: &str) -> Error {
    Error::BadPath {
        detail: format!("{source}: {what} are not supported yet"),
    }
}
