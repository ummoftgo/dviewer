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

use crate::error::{Error, Result};
use crate::tree::index::TreeIndex;
use crate::tree::text;

/// One step of an expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// `.name` or `["name"]` — the children of an object under that key.
    Key(String),
    /// `[n]` — the nth child, counted the way the file writes it.
    Index(u32),
    /// `[*]` or `.*` — every child.
    Any,
    /// `..` — the node itself and everything under it, which the next step
    /// then applies to. On its own at the end it selects the whole subtree.
    Descend,
}

/// Parse an expression, or say why it cannot be one.
pub fn parse(source: &str) -> Result<Vec<Step>> {
    let text = source.trim();
    let mut chars = text.char_indices().peekable();

    match chars.next() {
        Some((_, '$')) => {}
        // A path expression names where to start. Without `$` this is a
        // substring, which is what the literal reading is for.
        _ => return Err(bad(source, "expressions start at `$`")),
    }

    let mut steps = Vec::new();
    while let Some(&(at, ch)) = chars.peek() {
        match ch {
            '.' => {
                chars.next();
                if matches!(chars.peek(), Some((_, '.'))) {
                    chars.next();
                    steps.push(Step::Descend);
                    // `..` may be followed by a name, a bracket, or nothing.
                    if matches!(chars.peek(), Some((_, '[')) | None) {
                        continue;
                    }
                }
                if matches!(chars.peek(), Some((_, '*'))) {
                    chars.next();
                    steps.push(Step::Any);
                    continue;
                }
                let name = take_name(&mut chars);
                if name.is_empty() {
                    return Err(bad(source, "a `.` needs a name after it"));
                }
                steps.push(Step::Key(name));
            }
            '[' => {
                chars.next();
                steps.push(bracket(source, &mut chars)?);
            }
            _ => {
                return Err(bad(
                    source,
                    &format!("expected `.` or `[` at position {}", at + 1),
                ))
            }
        }
    }
    Ok(steps)
}

type Chars<'a> = std::iter::Peekable<std::str::CharIndices<'a>>;

fn take_name(chars: &mut Chars<'_>) -> String {
    let mut name = String::new();
    while let Some(&(_, ch)) = chars.peek() {
        if ch == '.' || ch == '[' {
            break;
        }
        name.push(ch);
        chars.next();
    }
    name
}

/// What is inside `[...]`.
fn bracket(source: &str, chars: &mut Chars<'_>) -> Result<Step> {
    let mut inner = String::new();
    let mut closed = false;
    let mut quote: Option<char> = None;
    for (_, ch) in chars.by_ref() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == ']' => {
                closed = true;
                break;
            }
            None => {}
        }
        if !closed {
            inner.push(ch);
        }
    }
    if !closed {
        return Err(bad(source, "a `[` with no `]`"));
    }

    let trimmed = inner.trim();
    if trimmed == "*" {
        return Ok(Step::Any);
    }
    // The parts of the syntax this does not do. Naming them is the point: a
    // reader who wrote one gets told, rather than getting a shorter answer.
    if trimmed.starts_with('?') {
        return Err(unsupported(source, "filter expressions `[?(...)]`"));
    }
    if trimmed.contains(':') {
        return Err(unsupported(source, "slices `[1:3]`"));
    }
    if trimmed.contains(',') {
        return Err(unsupported(source, "unions `[0,2]`"));
    }
    if let Some(name) = quoted(trimmed) {
        return Ok(Step::Key(name));
    }
    trimmed
        .parse::<u32>()
        .map(Step::Index)
        .map_err(|_| bad(source, &format!("`[{trimmed}]` is neither an index nor a name")))
}

fn quoted(text: &str) -> Option<String> {
    for mark in ['\'', '"'] {
        if text.len() >= 2 && text.starts_with(mark) && text.ends_with(mark) {
            return Some(text[1..text.len() - 1].to_owned());
        }
    }
    None
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

/// The nodes an expression selects, in document order.
///
/// The root is where the document starts — node 0, or its children when the
/// scanner wrapped several top-level values in a synthetic array, because in
/// that case `$` means the file rather than the wrapper this app invented.
pub fn select(index: &TreeIndex, bytes: &[u8], steps: &[Step]) -> Vec<u32> {
    if index.nodes.is_empty() {
        return Vec::new();
    }
    let mut current = vec![0u32];
    let mut at = 0usize;

    while at < steps.len() {
        let mut next: Vec<u32> = Vec::new();
        match &steps[at] {
            // `..` followed by anything is read as one step. Collecting the
            // subtree and then filtering it would be the same answer by way of
            // a list of every node in the document — on a 38-million-node file
            // that is 150MB of node ids to build and sort before throwing
            // nearly all of them away.
            // `..name` is every node under here that is called `name`. A node
            // called `name` is by definition a child of its parent, so the
            // answer is a pass over the subtree testing keys — not the children
            // of every node in it, which would allocate a list per node.
            Step::Descend if matches!(steps.get(at + 1), Some(Step::Key(_))) => {
                let Some(Step::Key(name)) = steps.get(at + 1) else {
                    unreachable!("just matched")
                };
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    for descendant in id + 1..id + node.subtree_size {
                        if named(index, bytes, descendant, name) {
                            next.push(descendant);
                        }
                    }
                }
                at += 2;
            }
            // `..*` is every node under here except the one we started from,
            // since every other node in a subtree is some node's child.
            Step::Descend if matches!(steps.get(at + 1), Some(Step::Any)) => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    next.extend(id + 1..id + node.subtree_size);
                }
                at += 2;
            }
            Step::Descend if at + 1 < steps.len() => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    for descendant in id..id + node.subtree_size {
                        apply(index, bytes, &steps[at + 1], descendant, &mut next);
                    }
                }
                at += 2;
            }
            // On its own at the end, `..` is the subtree itself.
            Step::Descend => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    next.extend(id..id + node.subtree_size);
                }
                at += 1;
            }
            step => {
                for &id in &current {
                    apply(index, bytes, step, id, &mut next);
                }
                at += 1;
            }
        }
        next.sort_unstable();
        next.dedup();
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

/// One step, applied to one node, appending what it selects.
fn apply(index: &TreeIndex, bytes: &[u8], step: &Step, id: u32, out: &mut Vec<u32>) {
    match step {
        Step::Any => out.extend(children(index, id)),
        Step::Index(nth) => out.extend(index.children(id, *nth, 1)),
        Step::Key(name) => {
            for child in children(index, id) {
                if named(index, bytes, child, name) {
                    out.push(child);
                }
            }
        }
        // Two in a row is the same as one: everything under everything under a
        // node is everything under it.
        Step::Descend => {
            if let Some(node) = index.node(id) {
                out.extend(id..id + node.subtree_size);
            }
        }
    }
}

/// Whether a node's key is `name`.
///
/// Compared as bytes first. A key with an escape in it has to be decoded to be
/// compared, but almost none are, and decoding every key of a 38-million-node
/// document to find the few called `notes` would be the most expensive thing in
/// the walk.
fn named(index: &TreeIndex, bytes: &[u8], id: u32, name: &str) -> bool {
    let Some(node) = index.node(id) else {
        return false;
    };
    if node.key_len == 0 {
        return false;
    }
    let start = node.key_start as usize;
    let raw = &bytes[start..start + node.key_len as usize];
    if raw.contains(&b'\\') {
        return text::decode_key(bytes, node) == name;
    }
    raw == name.as_bytes()
}

fn children(index: &TreeIndex, id: u32) -> Vec<u32> {
    index.children(id, 0, u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(source: &str) -> Vec<Step> {
        parse(source).expect("parse")
    }

    #[test]
    fn the_shapes_the_subset_covers() {
        assert_eq!(steps("$"), []);
        assert_eq!(steps("$.a"), [Step::Key("a".into())]);
        assert_eq!(steps("$.a.b"), [Step::Key("a".into()), Step::Key("b".into())]);
        assert_eq!(steps("$[\"a b\"]"), [Step::Key("a b".into())]);
        assert_eq!(steps("$['a.b']"), [Step::Key("a.b".into())]);
        assert_eq!(steps("$[3]"), [Step::Index(3)]);
        assert_eq!(steps("$[*]"), [Step::Any]);
        assert_eq!(steps("$.*"), [Step::Any]);
        assert_eq!(steps("$..a"), [Step::Descend, Step::Key("a".into())]);
        assert_eq!(steps("$.."), [Step::Descend]);
        assert_eq!(
            steps("$.items[2].name"),
            [
                Step::Key("items".into()),
                Step::Index(2),
                Step::Key("name".into())
            ]
        );
        // A key with a dot in it has to be bracketed, which is what brackets
        // are for.
        assert_eq!(
            steps("$..owner['e.mail']"),
            [
                Step::Descend,
                Step::Key("owner".into()),
                Step::Key("e.mail".into())
            ]
        );
    }

    /// What the subset does not cover is refused by name. A reader who wrote a
    /// filter should be told it is not there, not handed a shorter answer.
    #[test]
    fn what_is_not_supported_is_refused_by_name() {
        for (source, expected) in [
            ("$[?(@.a==1)]", "filter"),
            ("$[1:3]", "slice"),
            ("$[0,2]", "union"),
        ] {
            match parse(source) {
                Err(Error::BadPath { detail }) => {
                    assert!(detail.contains(expected), "{source} said {detail}")
                }
                other => panic!("{source} gave {other:?}"),
            }
        }
    }

    /// A query that is not an expression at all is refused before anything is
    /// searched — it is a literal query in the wrong box.
    #[test]
    fn a_query_that_is_not_an_expression_is_refused() {
        for source in ["items", ".items", "$items", "$.", "$[", "$[a]"] {
            assert!(
                matches!(parse(source), Err(Error::BadPath { .. })),
                "{source} should not parse"
            );
        }
    }
}
