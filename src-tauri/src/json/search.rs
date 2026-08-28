//! Literal search across a JSON document.
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
use memchr::memmem;
use serde::{Deserialize, Serialize};

use super::index::JsonIndex;
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
    #[serde(default = "default_scope")]
    pub scope: SearchScope,
}

fn default_scope() -> SearchScope {
    SearchScope::All
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
    index: &Arc<JsonIndex>,
    options: &SearchOptions,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(&[SearchHit], usize),
) -> Result<SearchResult> {
    if options.query.is_empty() {
        return Err(Error::rejected("검색어를 입력해 주세요."));
    }

    // Paths are synthesised, so they need a tree walk rather than a byte scan.
    if options.scope == SearchScope::Paths {
        return search_paths(bytes, index, options, cancel, on_batch);
    }

    let automaton = AhoCorasick::builder()
        .match_kind(MatchKind::LeftmostFirst)
        .ascii_case_insensitive(!options.case_sensitive)
        .build([options.query.as_bytes()])
        .map_err(|e| Error::rejected(format!("검색어를 처리할 수 없습니다: {e}")))?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut batch_start = 0usize;
    let mut capped = false;

    for found in automaton.find_iter(bytes) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let offset = found.start() as u32;
        let Some(hit) = classify(index, offset) else {
            continue;
        };
        if !scope_allows(options.scope, hit.field) {
            continue;
        }

        hits.push(hit);
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

const BATCH: usize = 512;

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
fn classify(index: &JsonIndex, offset: u32) -> Option<SearchHit> {
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
    index: &Arc<JsonIndex>,
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
            break;
        }

        let depth = node.depth as usize;
        let base = if depth == 0 { 0 } else { ends[depth - 1] };
        path.truncate(base);

        if depth == 0 {
            path.push(b'$');
        } else if node.key_len > 0 {
            path.push(b'.');
            let key = text::decode_key(bytes, node);
            append(&mut path, key.as_bytes(), options.case_sensitive);
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
    use super::super::scanner::{ScanLimits, scan};
    use super::*;

    fn build(src: &str) -> Arc<JsonIndex> {
        let scanned = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).unwrap();
        Arc::new(JsonIndex::new(scanned.nodes, scanned.synthetic_root))
    }

    fn run(src: &str, query: &str, scope: SearchScope, case_sensitive: bool) -> Vec<SearchHit> {
        let index = build(src);
        let options = SearchOptions {
            query: query.to_owned(),
            case_sensitive,
            scope,
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

    #[test]
    fn path_and_text_scopes_disagree_as_expected() {
        let src = r#"{"needle":1,"other":"needle"}"#;
        // Text search sees the key and the value; path search sees only the key.
        assert_eq!(run(src, "needle", SearchScope::All, true).len(), 2);
        assert_eq!(paths(src, "needle", true), ["$.needle"]);
    }

    #[test]
    fn cancellation_ends_the_scan_early() {
        let index = build(SRC);
        let options = SearchOptions {
            query: "name".to_owned(),
            case_sensitive: false,
            scope: SearchScope::All,
        };
        let cancel = AtomicBool::new(true);
        let result = search(SRC.as_bytes(), &index, &options, &cancel, |_, _| {}).unwrap();
        assert!(result.hits.is_empty());
    }

    #[test]
    fn batches_stream_before_the_scan_completes() {
        let items: Vec<String> = (0..2000).map(|i| format!(r#""needle-{i}""#)).collect();
        let src = format!("[{}]", items.join(","));
        let index = build(&src);
        let options = SearchOptions {
            query: "needle".to_owned(),
            case_sensitive: false,
            scope: SearchScope::All,
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
}
