//! How a search query is read.
//!
//! Its own module because both readings of a document ask the same question.
//! The tree searches nodes and the grids search cells, but "is this query a
//! string to find or a pattern to match" is one decision, and a reader who
//! turns the control on in one view means the same thing in the other.

use regex::{Regex, RegexBuilder};
use serde::Deserialize;

use crate::error::{Error, Result};

/// What language the query is written in.
///
/// A second axis, not another scope: the scope says which part of a node or row
/// to look at, and this says how to read what is being looked for. The default
/// is what the box has always done, so nothing changes for anyone who does not
/// reach for the control.
///
/// Deliberately not inferred from the query's shape. `$.items` is a perfectly
/// good literal search today, and a box that quietly switched engines when a
/// query started looking like an expression would answer differently tomorrow
/// with no way to see why.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interpretation {
    #[default]
    Literal,
    /// A regular expression, matched **inside one value** — one key, one cell,
    /// one path — rather than across the document.
    ///
    /// Not a shortcut around the chunked byte scan but the only reading under
    /// which the expression means what it says. `^` and `$` over a byte stream
    /// anchor to any newline in the file, which for a JSON document is nothing
    /// at all, so `^\d+$` would answer a question nobody asked.
    ///
    /// It follows that a pattern is matched against **characters** — a string's
    /// escapes resolved, its quotes off — because that is what a regular
    /// expression is written in. A literal is bytes and is matched against
    /// bytes. The two answer differently for `\n`, and each is right about its
    /// own question.
    Regex,
    /// A JSONPath expression, which selects nodes rather than matching text.
    ///
    /// Only the tree has one — a grid has cells, not paths — and only over a
    /// JSON-shaped document, because an XML path is XPath and an expression
    /// written for one would mean something else in the other.
    JsonPath,
}

/// The question a search asks of one cell.
///
/// A literal is bytes and a pattern is characters, so the two look at slightly
/// different things — but both answer "does this cell match", and a grid that
/// wrote the loop twice would be a grid where one copy fell behind.
pub enum Matcher {
    Literal(aho_corasick::AhoCorasick),
    Pattern(regex::Regex),
}

impl Matcher {
    pub fn new(query: &str, case_sensitive: bool, how: Interpretation) -> Result<Self> {
        Ok(match how {
            Interpretation::Literal => Matcher::Literal(
                aho_corasick::AhoCorasick::builder()
                    .match_kind(aho_corasick::MatchKind::LeftmostFirst)
                    .ascii_case_insensitive(!case_sensitive)
                    .build([query.as_bytes()])
                    .map_err(|error| crate::error::Error::BadQuery {
                        detail: error.to_string(),
                    })?,
            ),
            Interpretation::Regex => Matcher::Pattern(compile(query, case_sensitive)?),
            // A grid has no paths to select, and the frontend does not offer
            // the control there. Refusing rather than falling back to a
            // literal, so a query that cannot mean what it says never quietly
            // means something else.
            Interpretation::JsonPath => {
                return Err(crate::error::Error::BadPath {
                    detail: query.to_owned(),
                })
            }
        })
    }

    pub fn matches(&self, text: &str) -> bool {
        match self {
            Matcher::Literal(finder) => finder.find(text.as_bytes()).is_some(),
            Matcher::Pattern(pattern) => pattern.is_match(text),
        }
    }
}

/// Build the expression, with the case toggle folded in.
///
/// The toggle is not made redundant by `(?i)` — it is the control that was
/// already there, and a reader who set it once should not have to remember to
/// write it into every pattern as well. A pattern that says `(?i)` itself still
/// wins inside its own group, which is what that syntax is for.
pub fn compile(query: &str, case_sensitive: bool) -> Result<Regex> {
    RegexBuilder::new(query)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| Error::BadRegex {
            detail: error.to_string(),
        })
}
