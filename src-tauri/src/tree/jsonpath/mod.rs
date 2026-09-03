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
//! **A named subset, and the rest refused out loud.** `$`, `.key`, `["key"]`,
//! `[n]`, `[*]`, `.*` and `..`. Filter expressions (`?()`), slices (`[1:3]`)
//! and unions (`[0,2]`) are not here — and an expression that uses one is an
//! error rather than a quietly different answer, because a wrong answer that
//! looks like an answer is the worst thing this could do.

//! Split by concern: `parse` turns the text into steps, `select` walks the
//! index applying them. What is shared is here — the step type both sides
//! speak in, and the one error this module can raise.

mod parse;
mod select;

pub use parse::parse;
pub use select::select;

use crate::error::Error;

/// One step of an expression.
#[derive(Debug, Clone, PartialEq, Eq)]
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
