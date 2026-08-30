//! Literal search across a document tree.
//!
//! Keys and values live in the document, so the fastest thing we can do is scan
//! the bytes directly and map each hit back to a node — no tree walk, no
//! per-node string allocation. `val_start` being non-decreasing in node order
//! makes that mapping a binary search.
//!
//! Paths are different: they do not exist anywhere in the file, they are
//! derived from the tree. See [`search_paths`] for how that is handled without
//! materialising a string per node.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use aho_corasick::{AhoCorasick, MatchKind};
use regex::{Regex, RegexBuilder};
use memchr::memmem;
use serde::{Deserialize, Serialize};

use super::index::{TreeIndex, Syntax};
use super::scanner::Kind;
use super::text;
use crate::error::{Error, Result};

/// Hard cap on collected hits. Past this the result list stops being something
/// a person navigates, and holding millions of ids helps nobody.
pub const MAX_HITS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    All,
    Keys,
    Values,
    /// Matches the dotted path (`$.items[3].name`) rather than document text.
    Paths,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub how: Interpretation,
    #[serde(default = "default_scope")]
    pub scope: SearchScope,
    /// Which search this is, counted by the frontend.
    ///
    /// Results come back as events, and an event carries no proof of what
    /// asked for it. Echoing this on every batch is what lets a view drop the
    /// tail of a query the reader has already replaced.
    #[serde(default)]
    pub seq: u64,
}

fn default_scope() -> SearchScope {
    SearchScope::All
}

/// What language the query is written in.
///
/// A second axis, not a fourth scope: the scope says which part of a node to
/// look at, and this says how to read what is being looked for. The default is
/// what the box has always done, so nothing changes for anyone who does not
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
    /// A regular expression, matched **inside one key, value or path** rather
    /// than across the document.
    ///
    /// That is not a shortcut around the chunked scan — it is the only reading
    /// under which the expression means what it says. `^` and `$` in a byte
    /// stream anchor to any newline in the file, which for a JSON document is
    /// nothing at all, so `^\d+$` would answer a question nobody asked.
    Regex,
}

/// Which part of a node a hit landed in. A plain `in_key` flag could not
/// describe a path match, which belongs to neither the key nor the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    Key,
    Value,
    Path,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub node: u32,
    /// Byte offset of the match in the document, for highlighting inside the
    /// row. Path hits have no such offset and report the node's own start.
    pub offset: u32,
    pub field: SearchField,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub total: usize,
    /// True when the scan stopped at `MAX_HITS`.
    pub capped: bool,
}

pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub summary: SearchSummary,
}

impl SearchResult {
    pub fn nodes(&self) -> Vec<u32> {
        let mut nodes: Vec<u32> = self.hits.iter().map(|h| h.node).collect();
        nodes.dedup();
        nodes
    }
}

/// Scan `bytes` for `options.query`, reporting each batch of hits through
/// `on_batch` so the first results reach the UI long before the scan finishes.
pub fn search(
    bytes: &[u8],
    index: &Arc<TreeIndex>,
    options: &SearchOptions,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(&[SearchHit], usize),
) -> Result<SearchResult> {
    if options.query.is_empty() {
        return Err(Error::EmptyQuery);
    }

    // Paths are synthesised, so they need a tree walk rather than a byte scan.
    if options.scope == SearchScope::Paths {
        return search_paths(bytes, index, options, cancel, on_batch);
    }
    // So does an expression, for a different reason — see `Interpretation`.
    if options.how == Interpretation::Regex {
        return search_nodes(bytes, index, options, cancel, on_batch);
    }

    let automaton = AhoCorasick::builder()
        .match_kind(MatchKind::LeftmostFirst)
        .ascii_case_insensitive(!options.case_sensitive)
        .build([options.query.as_bytes()])
        .map_err(|e| Error::BadQuery {
            detail: e.to_string(),
        })?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut batch_start = 0usize;
    let mut capped = false;

    scan_chunked(bytes, options.query.len(), cancel, SCAN_CHUNK, |offset| {
        let Some(hit) = classify(index, offset) else {
            return true;
        };
        if !scope_allows(options.scope, hit.field) {
            return true;
        }

        hits.push(hit);
        if hits.len() >= MAX_HITS {
            capped = true;
            return false;
        }
        if hits.len() - batch_start >= BATCH {
            on_batch(&hits[batch_start..], hits.len());
            batch_start = hits.len();
        }
        true
    }, &automaton)?;

    if batch_start < hits.len() {
        on_batch(&hits[batch_start..], hits.len());
    }

    let summary = SearchSummary {
        total: hits.len(),
        capped,
    };
    Ok(SearchResult { hits, summary })
}

/// Build the expression, with the case toggle folded in.
///
/// The toggle is not redundant with `(?i)` — it is the control that was already
/// there, and a reader who set it once should not have to remember to also
/// write it into every pattern. A pattern that says `(?i)` itself still wins
/// inside its own group, which is what that syntax is for.
fn compile(options: &SearchOptions) -> Result<Regex> {
    RegexBuilder::new(&options.query)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| Error::BadRegex {
            detail: error.to_string(),
        })
}

/// Match an expression against each node's key and value.
///
/// A walk rather than a scan, for the reason in `Interpretation::Regex`: the
/// unit a pattern is matched against has to be a thing the reader can point at.
/// The path search has walked the same nodes since before this existed.
///
/// What is matched is the value's **characters** — a string's escapes resolved,
/// its quotes off — because that is what a regular expression is written in.
/// The literal search matches bytes, which is what a literal is; the two answer
/// differently for `\n` and both are right about their own question.
fn search_nodes(
    bytes: &[u8],
    index: &Arc<TreeIndex>,
    options: &SearchOptions,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(&[SearchHit], usize),
) -> Result<SearchResult> {
    let pattern = compile(options)?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut batch_start = 0usize;
    let mut capped = false;

    for (id, node) in index.nodes.iter().enumerate() {
        if id % 4096 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }

        let id = id as u32;
        if node.key_len > 0 && scope_allows(options.scope, SearchField::Key) {
            let key = text::decode_key(bytes, node);
            if pattern.is_match(&key) {
                hits.push(SearchHit {
                    node: id,
                    // The key's own start: a match inside it has an offset of
                    // its own, but nothing downstream uses more than the node
                    // and the field, and a character offset into decoded text
                    // is not a byte offset into the file.
                    offset: node.key_start,
                    field: SearchField::Key,
                });
                if !room(&mut hits, &mut capped, &mut batch_start, &mut on_batch) {
                    break;
                }
            }
        }

        if !node.kind.is_container() && scope_allows(options.scope, SearchField::Value) {
            let (value, _) = text::decode_full(bytes, node, MAX_MATCHED_BYTES);
            if pattern.is_match(&value) {
                hits.push(SearchHit {
                    node: id,
                    offset: node.val_start,
                    field: SearchField::Value,
                });
                if !room(&mut hits, &mut capped, &mut batch_start, &mut on_batch) {
                    break;
                }
            }
        }
    }

    if batch_start < hits.len() {
        on_batch(&hits[batch_start..], hits.len());
    }
    let summary = SearchSummary {
        total: hits.len(),
        capped,
    };
    Ok(SearchResult { hits, summary })
}

/// How much of one value is matched against.
///
/// A value can be a 10MB base64 blob, and running a pattern over every byte of
/// several of those is time spent on something nobody is reading. The same
/// ceiling copying uses, for the same reason.
const MAX_MATCHED_BYTES: usize = 1024 * 1024;

/// Send a batch if one has filled, and say whether there is room for more.
fn room(
    hits: &mut Vec<SearchHit>,
    capped: &mut bool,
    batch_start: &mut usize,
    on_batch: &mut impl FnMut(&[SearchHit], usize),
) -> bool {
    if hits.len() >= MAX_HITS {
        *capped = true;
        return false;
    }
    if hits.len() - *batch_start >= BATCH {
        on_batch(&hits[*batch_start..], hits.len());
        *batch_start = hits.len();
    }
    true
}

const BATCH: usize = 512;

/// How much haystack one uninterruptible pass covers.
///
/// `find_iter` yields only matches, so a query with none in a 500MB file would
/// otherwise scan to the end with nothing to check the cancel flag between —
/// closing the tab would not stop it. Chunking gives the check somewhere to
/// happen. 4MB is ~1ms of scanning.
const SCAN_CHUNK: usize = 4 * 1024 * 1024;

/// Run `automaton` over `bytes` in windows, checking `cancel` between them.
///
/// The position is driven by hand rather than by `find_iter`, and that is the
/// whole point: "non-overlapping" is a property of one continuous scan, so an
/// iterator restarted at a window boundary reports matches the scan before it
/// had already consumed. Here the leftmost match in a window is the leftmost
/// match from `at` — anything earlier is behind it — and resuming past its end
/// is exactly what `find_iter` does between yields.
///
/// A window is `chunk` bytes of new ground plus enough tail that a match
/// starting in that ground is whole, so nothing falls between windows and the
/// empty-window stride is safe. `on_match` returns false to stop early.
///
/// Two things the caller owes this function, because the argument above rests
/// on them. The pattern must not be empty — a zero-length match advances
/// nothing and the loop never ends. And if `automaton` ever holds more than one
/// pattern, `pattern_len` must be the longest of them, or a match of a longer
/// one can straddle a window edge and be lost.
pub(crate) fn scan_chunked(
    bytes: &[u8],
    pattern_len: usize,
    cancel: &AtomicBool,
    chunk: usize,
    mut on_match: impl FnMut(u32) -> bool,
    automaton: &AhoCorasick,
) -> Result<()> {
    debug_assert!(pattern_len > 0, "an empty pattern would never advance `at`");
    // One window is `chunk` bytes of new ground plus enough tail that a match
    // starting inside it is whole — so a match never falls between windows.
    let window = chunk + pattern_len.saturating_sub(1);
    let mut at = 0usize;

    while at < bytes.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let end = (at + window).min(bytes.len());
        match automaton.find(&bytes[at..end]) {
            // The leftmost match in the window is the leftmost match from `at`,
            // and resuming past its end is what `find_iter` does — which is why
            // a self-overlapping pattern is counted the same either way.
            Some(found) => {
                let start = at + found.start();
                if !on_match(start as u32) {
                    return Ok(());
                }
                at += found.end();
            }
            // Nothing here. Anything starting before `at + chunk` would have
            // fit in the window, so that ground is covered.
            None => at += chunk,
        }
    }
    Ok(())
}

fn scope_allows(scope: SearchScope, field: SearchField) -> bool {
    match scope {
        SearchScope::All => true,
        SearchScope::Keys => field == SearchField::Key,
        SearchScope::Values => field == SearchField::Value,
        // Handled before the byte scan ever starts.
        SearchScope::Paths => false,
    }
}

/// Attribute a byte offset to a key or a scalar value.
///
/// Offsets that land on structural punctuation or whitespace belong to no node
/// anyone would want to jump to, so they are dropped rather than attributed to
/// whichever container happens to span them.
fn classify(index: &TreeIndex, offset: u32) -> Option<SearchHit> {
    let candidate = index.node_at_offset(offset)?;
    let node = index.node(candidate)?;

    if node.key_len > 0 && offset >= node.key_start && offset < node.key_start + node.key_len {
        return Some(SearchHit {
            node: candidate,
            offset,
            field: SearchField::Key,
        });
    }

    if !node.kind.is_container()
        && offset >= node.val_start
        && offset < node.val_start + node.val_len
    {
        // Skip the quotes around a string so `"` alone finds nothing useful.
        if node.kind == Kind::String
            && (offset == node.val_start || offset + 1 == node.val_start + node.val_len)
        {
            return None;
        }
        return Some(SearchHit {
            node: candidate,
            offset,
            field: SearchField::Value,
        });
    }

    None
}

/// Search the dotted paths of every node.
///
/// Building a string per node would mean tens of millions of allocations on a
/// large file. Instead one buffer is carried through the pre-order node list:
/// nodes already arrive parent-before-child, so the buffer is truncated back to
/// the parent's length and the node's own segment appended — the same work a
/// recursive walk would do, without the recursion.
///
/// Two facts keep the matching cheap:
///
/// * If an ancestor's path already matched, every descendant matches too, so
///   the subtree is accepted without another search.
/// * Otherwise the prefix is known not to match, so a new match must end inside
///   the freshly appended segment. Only that tail is scanned, which makes the
///   cost per node proportional to the query length rather than the path depth.
fn search_paths(
    bytes: &[u8],
    index: &Arc<TreeIndex>,
    options: &SearchOptions,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(&[SearchHit], usize),
) -> Result<SearchResult> {
    // ASCII case folding is applied to both sides up front so the inner loop is
    // a plain SIMD substring search.
    let needle: Vec<u8> = if options.case_sensitive {
        options.query.as_bytes().to_vec()
    } else {
        options.query.to_ascii_lowercase().into_bytes()
    };
    let finder = memmem::Finder::new(&needle);

    let max_depth = index.max_depth as usize;
    let mut path = Vec::<u8>::with_capacity(256);
    // Buffer length and match state after the node at each depth.
    let mut ends = vec![0usize; max_depth + 2];
    let mut matched = vec![false; max_depth + 2];

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut batch_start = 0usize;
    let mut capped = false;

    for (id, node) in index.nodes.iter().enumerate() {
        if id % 4096 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }

        let depth = node.depth as usize;
        let base = if depth == 0 { 0 } else { ends[depth - 1] };
        path.truncate(base);

        if index.syntax == Syntax::Xml {
            // XPath shape, but without the positional predicates `path_of`
            // adds. They are what makes a copied path point at one node; in a
            // search box they would only stop `item` from matching every item.
            match node.kind {
                Kind::Text | Kind::CData => path.extend_from_slice(b"/text()"),
                Kind::Comment => path.extend_from_slice(b"/comment()"),
                Kind::Directive => path.extend_from_slice(b"/processing-instruction()"),
                _ => {
                    path.push(b'/');
                    if node.kind == Kind::Attribute {
                        path.push(b'@');
                    }
                    let key = text::decode_key(bytes, node);
                    append(&mut path, key.as_bytes(), options.case_sensitive);
                }
            }
        } else if depth == 0 {
            path.push(b'$');
        } else if node.key_len > 0 {
            let key = text::decode_key(bytes, node);
            // The same shape `path_of` produces, or a copied path would not
            // find itself. Brackets and quotes are ASCII either way, so only
            // the key itself goes through the case folding.
            if super::index::is_plain_key(&key) {
                path.push(b'.');
                append(&mut path, key.as_bytes(), options.case_sensitive);
            } else {
                path.extend_from_slice(b"[\"");
                let mut escaped = String::with_capacity(key.len());
                for c in key.chars() {
                    if c == '"' || c == '\\' {
                        escaped.push('\\');
                    }
                    escaped.push(c);
                }
                append(&mut path, escaped.as_bytes(), options.case_sensitive);
                path.extend_from_slice(b"\"]");
            }
        } else {
            path.push(b'[');
            append(
                &mut path,
                node.sibling_index.to_string().as_bytes(),
                options.case_sensitive,
            );
            path.push(b']');
        }
        ends[depth] = path.len();

        let ancestor_matched = depth > 0 && matched[depth - 1];
        let hit = ancestor_matched || {
            // A fresh match has to end in the segment just appended, so it can
            // start no earlier than `needle.len() - 1` bytes before it.
            let from = base.saturating_sub(needle.len().saturating_sub(1));
            finder.find(&path[from..]).is_some()
        };
        matched[depth] = hit;
        if !hit {
            continue;
        }

        hits.push(SearchHit {
            node: id as u32,
            offset: node.val_start,
            field: SearchField::Path,
        });
        if hits.len() >= MAX_HITS {
            capped = true;
            break;
        }
        if hits.len() - batch_start >= BATCH {
            on_batch(&hits[batch_start..], hits.len());
            batch_start = hits.len();
        }
    }

    if batch_start < hits.len() {
        on_batch(&hits[batch_start..], hits.len());
    }

    let summary = SearchSummary {
        total: hits.len(),
        capped,
    };
    Ok(SearchResult { hits, summary })
}

fn append(path: &mut Vec<u8>, segment: &[u8], case_sensitive: bool) {
    if case_sensitive {
        path.extend_from_slice(segment);
    } else {
        path.extend(segment.iter().map(u8::to_ascii_lowercase));
    }
}

#[cfg(test)]
mod tests {
    /// A copied path must find itself in a path search.
    ///
    /// The two are built by different code — `path_of` for the clipboard,
    /// `search_paths` for the search box — so a key that needs brackets is
    /// exactly where they could disagree.
    #[test]
    fn a_bracketed_path_finds_itself() {
        let src = r#"{"a.b": {"c": 1}, "plain": 2}"#;
        let index = build(src);
        let copied = index.path_of(src.as_bytes(), 2);
        assert_eq!(copied, r#"$["a.b"].c"#);
        assert_eq!(paths(src, &copied, true), [copied.clone()]);

        let parent = index.path_of(src.as_bytes(), 1);
        assert_eq!(parent, r#"$["a.b"]"#);
        assert_eq!(paths(src, &parent, true), [parent.clone(), copied]);
    }


    /// Chunking must not change what a search finds.
    ///
    /// The windows overlap, so a match lying across a boundary has to be found
    /// exactly once — not missed, and not reported by both windows.
    #[test]
    fn chunking_finds_the_same_matches() {
        let mut hay = Vec::new();
        for i in 0..400 {
            hay.extend_from_slice(format!("filler{i}-").as_bytes());
            if i % 7 == 0 {
                hay.extend_from_slice(b"needle");
            }
        }
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostFirst)
            .build([b"needle".as_slice()])
            .expect("automaton");
        let expected: Vec<u32> = automaton
            .find_iter(&hay)
            .map(|m| m.start() as u32)
            .collect();
        assert!(expected.len() > 20, "the fixture must exercise many windows");

        let never = AtomicBool::new(false);
        for chunk in [1, 2, 5, 6, 7, 13, 64, 997, hay.len(), hay.len() * 2] {
            let mut found = Vec::new();
            scan_chunked(&hay, 6, &never, chunk, |offset| {
                found.push(offset);
                true
            }, &automaton)
            .expect("not cancelled");
            assert_eq!(found, expected, "chunk = {chunk}");
        }
    }

    /// Chunking must not turn one match into two.
    ///
    /// `find_iter` reports non-overlapping matches, and "non-overlapping" is a
    /// property of the whole scan: a pattern that can overlap itself is
    /// consumed by the match that claimed it. Restarting the iterator at each
    /// window boundary forgets that.
    #[test]
    fn chunking_does_not_invent_overlapping_matches() {
        let hay = b"aaaaaaaaaaaaaaaa".to_vec();
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostFirst)
            .build([b"aa".as_slice()])
            .expect("automaton");
        let expected: Vec<u32> = automaton.find_iter(&hay).map(|m| m.start() as u32).collect();

        let never = AtomicBool::new(false);
        for chunk in [1, 2, 3, 5, 7, hay.len()] {
            let mut found = Vec::new();
            scan_chunked(&hay, 2, &never, chunk, |offset| {
                found.push(offset);
                true
            }, &automaton)
            .expect("not cancelled");
            assert_eq!(found, expected, "chunk = {chunk}");
        }
    }

    /// A query with no matches anywhere still has to notice the cancel flag —
    /// that is the case `find_iter` alone could never interrupt.
    #[test]
    fn a_cancelled_scan_stops_without_a_single_match() {
        let hay = vec![b'x'; 8192];
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostFirst)
            .build([b"needle".as_slice()])
            .expect("automaton");
        let cancel = AtomicBool::new(true);
        let mut seen = 0usize;
        let result = scan_chunked(&hay, 6, &cancel, 64, |_| {
            seen += 1;
            true
        }, &automaton);
        assert!(matches!(result, Err(Error::Cancelled)));
        assert_eq!(seen, 0);
    }

    use super::super::scanner::{ScanLimits, scan};
    use super::*;

    fn build(src: &str) -> Arc<TreeIndex> {
        let scanned = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).unwrap();
        Arc::new(TreeIndex::new(scanned.nodes, scanned.synthetic_root, Syntax::Json))
    }

    fn run(src: &str, query: &str, scope: SearchScope, case_sensitive: bool) -> Vec<SearchHit> {
        let index = build(src);
        let options = SearchOptions {
            query: query.to_owned(),
            case_sensitive,
            how: Interpretation::Literal,
            scope,
            seq: 0,
        };
        let cancel = AtomicBool::new(false);
        search(src.as_bytes(), &index, &options, &cancel, |_, _| {})
            .unwrap()
            .hits
    }

    const SRC: &str = r#"{"name":"Alice","alias":"alice in name","nested":{"name":42}}"#;

    #[test]
    fn finds_keys_and_values_separately() {
        let all = run(SRC, "name", SearchScope::All, true);
        assert_eq!(all.len(), 3);

        let keys = run(SRC, "name", SearchScope::Keys, true);
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|h| h.field == SearchField::Key));

        let values = run(SRC, "name", SearchScope::Values, true);
        assert_eq!(values.len(), 1);
        assert!(values.iter().all(|h| h.field == SearchField::Value));
    }

    #[test]
    fn case_insensitive_is_the_default_behaviour() {
        assert_eq!(run(SRC, "alice", SearchScope::All, true).len(), 1);
        assert_eq!(run(SRC, "alice", SearchScope::All, false).len(), 2);
    }

    #[test]
    fn hits_map_to_the_node_that_owns_them() {
        let index = build(SRC);
        let hits = run(SRC, "42", SearchScope::All, true);
        assert_eq!(hits.len(), 1);
        let node = index.node(hits[0].node).unwrap();
        assert_eq!(node.kind, Kind::Number);
        assert_eq!(node.depth, 2);
    }

    #[test]
    fn structural_characters_are_not_matches() {
        assert!(run(SRC, "{", SearchScope::All, true).is_empty());
        assert!(run(SRC, ",", SearchScope::All, true).is_empty());
        assert!(run(SRC, "\"", SearchScope::All, true).is_empty());
    }

    // --- path scope -------------------------------------------------------

    const NESTED: &str = r#"{"alpha":{"beta":[{"name":"x"},{"name":"y"}]},"gamma":{"beta":1}}"#;

    fn paths(src: &str, query: &str, case_sensitive: bool) -> Vec<String> {
        let index = build(src);
        let hits = run(src, query, SearchScope::Paths, case_sensitive);
        assert!(hits.iter().all(|h| h.field == SearchField::Path));
        hits.iter()
            .map(|h| index.path_of(src.as_bytes(), h.node))
            .collect()
    }

    #[test]
    fn path_search_matches_key_segments() {
        // A matching ancestor carries its whole subtree.
        assert_eq!(paths(NESTED, ".gamma", true), ["$.gamma", "$.gamma.beta"]);
    }

    #[test]
    fn path_search_matches_array_indices() {
        assert_eq!(
            paths(NESTED, "beta[1]", true),
            ["$.alpha.beta[1]", "$.alpha.beta[1].name"]
        );
    }

    #[test]
    fn path_search_matches_across_a_segment_boundary() {
        // The needle starts inside the parent's portion and ends in the child's,
        // which is exactly what the tail-scan optimisation must not miss.
        let mut expected = vec!["$.alpha.beta".to_owned()];
        expected.extend(["[0]", "[0].name", "[1]", "[1].name"].map(|s| format!("$.alpha.beta{s}")));
        assert_eq!(paths(NESTED, "alpha.beta", true), expected);
    }

    #[test]
    fn path_search_finds_every_node_under_the_root_marker() {
        let index = build(NESTED);
        assert_eq!(paths(NESTED, "$", true).len(), index.nodes.len());
    }

    #[test]
    fn path_search_honours_case_sensitivity() {
        let src = r#"{"Alpha":{"BETA":1}}"#;
        assert!(paths(src, "alpha", true).is_empty());
        assert_eq!(paths(src, "alpha", false), ["$.Alpha", "$.Alpha.BETA"]);
    }

    #[test]
    fn path_search_ignores_text_that_is_not_part_of_a_path() {
        // A value never appears in any path, however common the string is.
        let empty: Vec<String> = Vec::new();
        assert_eq!(paths(r#"{"a":"needle"}"#, "needle", true), empty);
    }

    /// What the four scopes are each supposed to answer, on one document.
    ///
    /// `All` scans the file's bytes, so it sees keys and values. Paths are not
    /// in the file at all — they are derived from the tree — so they are found
    /// only by the scope that walks it.
    #[test]
    fn scopes_cover_what_they_claim() {
        let src = r#"{"alpha":{"beta":"gamma"},"delta":["alpha","x"]}"#;
        assert_eq!(run(src, "alpha", SearchScope::All, false).len(), 2);
        assert_eq!(run(src, "alpha", SearchScope::Keys, false).len(), 1);
        assert_eq!(run(src, "alpha", SearchScope::Values, false).len(), 1);
        assert_eq!(paths(src, "alpha", false), ["$.alpha", "$.alpha.beta"]);

        // A path string is nowhere in the bytes, so no byte scan can find it.
        assert_eq!(run(src, "$.alpha", SearchScope::All, false).len(), 0);
        assert_eq!(paths(src, "$.alpha", false), ["$.alpha", "$.alpha.beta"]);
    }

    /// Path search must reach the last node, not stop at the first block.
    #[test]
    fn path_search_covers_the_whole_document() {
        let items: Vec<String> = (0..9000).map(|i| format!(r#"{{"needle{i}":{i}}}"#)).collect();
        let src = format!("[{}]", items.join(","));
        let found = paths(&src, "needle", false);
        assert_eq!(found.len(), 9000);
        assert_eq!(found[0], "$[0].needle0");
        assert_eq!(found[8999], "$[8999].needle8999");
    }

    #[test]
    fn path_and_text_scopes_disagree_as_expected() {
        let src = r#"{"needle":1,"other":"needle"}"#;
        // Text search sees the key and the value; path search sees only the key.
        assert_eq!(run(src, "needle", SearchScope::All, true).len(), 2);
        assert_eq!(paths(src, "needle", true), ["$.needle"]);
    }

    /// A cancelled search reports cancellation rather than a short answer.
    ///
    /// It used to return the hits it had as an ordinary result, and the caller
    /// stored them — so the remains of an abandoned query could replace the
    /// results of the one that replaced it.
    #[test]
    fn cancellation_is_not_a_result() {
        let index = build(SRC);
        let options = SearchOptions {
            how: Interpretation::Literal,
            query: "name".to_owned(),
            case_sensitive: false,
            scope: SearchScope::All,
            seq: 0,
        };
        let cancel = AtomicBool::new(true);
        let result = search(SRC.as_bytes(), &index, &options, &cancel, |_, _| {});
        assert!(matches!(result, Err(Error::Cancelled)));

        let paths = SearchOptions {
            how: Interpretation::Literal,
            query: "$.name".to_owned(),
            case_sensitive: false,
            scope: SearchScope::Paths,
            seq: 0,
        };
        let result = search(SRC.as_bytes(), &index, &paths, &cancel, |_, _| {});
        assert!(matches!(result, Err(Error::Cancelled)));
    }

    #[test]
    fn batches_stream_before_the_scan_completes() {
        let items: Vec<String> = (0..2000).map(|i| format!(r#""needle-{i}""#)).collect();
        let src = format!("[{}]", items.join(","));
        let index = build(&src);
        let options = SearchOptions {
            how: Interpretation::Literal,
            query: "needle".to_owned(),
            case_sensitive: false,
            scope: SearchScope::All,
            seq: 0,
        };
        let cancel = AtomicBool::new(false);
        let mut batches = 0;
        let result = search(src.as_bytes(), &index, &options, &cancel, |batch, _| {
            assert!(!batch.is_empty());
            batches += 1;
        })
        .unwrap();
        assert_eq!(result.hits.len(), 2000);
        assert!(batches > 1, "expected streaming batches, got {batches}");
    }

    // --- regular expressions ------------------------------------------------

    fn run_regex(src: &str, query: &str, scope: SearchScope) -> Vec<SearchHit> {
        let index = build(src);
        let options = SearchOptions {
            query: query.to_owned(),
            case_sensitive: false,
            how: Interpretation::Regex,
            scope,
            seq: 0,
        };
        search(src.as_bytes(), &index, &options, &AtomicBool::new(false), |_, _| {})
            .expect("search")
            .hits
    }

    /// The reason the match unit is a value and not the file: an anchor has to
    /// anchor to something a reader can point at.
    #[test]
    fn an_anchor_holds_to_the_value_it_is_in() {
        let src = "{\"a\": \"123\", \"b\": \"x123\", \"c\": \"123x\", \"d\": 123}";
        let hits = run_regex(src, "^123$", SearchScope::Values);
        assert_eq!(hits.len(), 2, "the string 123 and the number 123");

        // Over the file's bytes, `^` would find the start of a line and `$` its
        // end, and this pattern would match nothing at all — which is the
        // answer a byte scan would have given.
        assert!(run_regex(src, "^x", SearchScope::Values).len() == 1);
        assert_eq!(run_regex(src, "x$", SearchScope::Values).len(), 1);
    }

    /// A pattern reads characters, so it sees the value's characters — escapes
    /// resolved and quotes off. The literal search reads bytes and sees the
    /// bytes. Both are right about their own question.
    #[test]
    fn a_pattern_sees_characters_where_a_literal_sees_bytes() {
        let src = "{\"a\": \"line\\nbreak\", \"b\": \"back\\\\slash\"}";

        // A real newline, which the file does not contain as a byte.
        assert_eq!(run_regex(src, "line\\nbreak", SearchScope::Values).len(), 1);
        // And the two characters a literal would have to look for.
        assert!(run(src, "line\\nbreak", SearchScope::Values, false).len() == 1);

        // A quote is not part of the value under either reading.
        assert!(run_regex(src, "^\"", SearchScope::Values).is_empty());
    }

    /// Keys and values are separate scopes here too, and a hit says which.
    #[test]
    fn the_scope_still_decides_where_to_look() {
        let src = "{\"name\": \"name\", \"other\": \"value\"}";
        let keys = run_regex(src, "^name$", SearchScope::Keys);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].field, SearchField::Key);

        let values = run_regex(src, "^name$", SearchScope::Values);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].field, SearchField::Value);

        assert_eq!(run_regex(src, "^name$", SearchScope::All).len(), 2);
    }

    /// The case toggle keeps working, and a pattern that sets its own wins
    /// inside its own group.
    #[test]
    fn the_case_toggle_reaches_the_pattern() {
        let src = "{\"a\": \"HELLO\", \"b\": \"hello\"}";
        let index = build(src);
        let sensitive = SearchOptions {
            query: "hello".into(),
            case_sensitive: true,
            how: Interpretation::Regex,
            scope: SearchScope::Values,
            seq: 0,
        };
        let found = search(src.as_bytes(), &index, &sensitive, &AtomicBool::new(false), |_, _| {})
            .expect("search");
        assert_eq!(found.hits.len(), 1);

        assert_eq!(run_regex(src, "hello", SearchScope::Values).len(), 2);
    }

    /// A pattern that does not compile is an error with the crate's own words,
    /// not an empty result that looks like "nothing found".
    #[test]
    fn a_broken_pattern_says_what_is_wrong() {
        let index = build("{\"a\": 1}");
        let options = SearchOptions {
            query: "(unclosed".into(),
            case_sensitive: false,
            how: Interpretation::Regex,
            scope: SearchScope::All,
            seq: 0,
        };
        match search(b"{\"a\": 1}", &index, &options, &AtomicBool::new(false), |_, _| {}) {
            Err(Error::BadRegex { detail }) => {
                assert!(detail.contains("unclosed"), "got {detail}");
            }
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => panic!("a pattern that does not compile must not succeed"),
        }
    }

    /// Nothing about the literal reading moved. This is the assertion that the
    /// new axis is an addition rather than a change.
    #[test]
    fn the_literal_reading_is_untouched() {
        let src = "{\"a\": \"^123$\", \"b\": \"123\"}";
        // As a literal, the metacharacters are characters.
        let hits = run(src, "^123$", SearchScope::Values, false);
        assert_eq!(hits.len(), 1);
        // As a pattern, they are anchors.
        let hits = run_regex(src, "^123$", SearchScope::Values);
        assert_eq!(hits.len(), 1);
        assert_ne!(
            run(src, "^123$", SearchScope::Values, false)[0].node,
            run_regex(src, "^123$", SearchScope::Values)[0].node,
            "and they find different nodes, which is the point"
        );
    }
}
