pub mod index;
pub mod scanner;
pub mod search;
pub mod text;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use parking_lot::RwLock;
use serde::Serialize;

use crate::bytes::DocBytes;
use crate::error::Result;
use index::{DEFAULT_EXPAND_DEPTH, JsonIndex, Visibility};
use scanner::{ScanLimits, scan};
use search::{SearchOptions, SearchResult};

/// Ceiling on the raw text handed back for "copy value". Anything larger is a
/// file, not something to put on a clipboard.
pub const MAX_NODE_TEXT_BYTES: usize = 8 * 1024 * 1024;

/// One line of the tree, as the virtual list needs it. Values are pre-truncated
/// so a viewport of ~100 rows is a few kilobytes of IPC regardless of the file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRow {
    pub id: u32,
    pub depth: u16,
    /// Object key, or None when the parent is an array.
    pub key: Option<String>,
    /// Array position, or None when the parent is an object.
    pub index: Option<u32>,
    pub kind: &'static str,
    /// Scalar text; None for containers, which the frontend summarises.
    pub value: Option<String>,
    pub truncated: bool,
    pub child_count: u32,
    pub container: bool,
    pub collapsed: bool,
}

/// A page of one node's children, for the key/value table beside the tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenPage {
    /// The node these children belong to, which is not always the node asked
    /// about — see `JsonIndex::table_target`.
    pub target: u32,
    pub target_path: String,
    pub target_kind: &'static str,
    pub total: u32,
    pub start: u32,
    pub rows: Vec<JsonRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonStats {
    pub node_count: u32,
    pub max_depth: u16,
    pub visible_rows: u32,
    pub byte_len: usize,
    /// Memory the node index itself occupies — worth surfacing on a file where
    /// it can run to a gigabyte.
    pub index_bytes: usize,
    pub synthetic_root: bool,
    pub filtered: bool,
}

pub struct JsonDoc {
    pub index: Arc<JsonIndex>,
    pub bytes: Arc<DocBytes>,
    visibility: RwLock<Visibility>,
    search: RwLock<Option<SearchResult>>,
}

impl JsonDoc {
    pub fn build(
        bytes: Arc<DocBytes>,
        limits: &ScanLimits,
        progress: impl FnMut(usize),
        should_stop: &dyn Fn() -> bool,
    ) -> Result<Self> {
        let scanned = scan(&bytes, limits, progress, should_stop)?;
        let index = Arc::new(JsonIndex::new(scanned.nodes, scanned.synthetic_root));
        let visibility = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);
        Ok(Self {
            index,
            bytes,
            visibility: RwLock::new(visibility),
            search: RwLock::new(None),
        })
    }

    pub fn stats(&self) -> JsonStats {
        let visibility = self.visibility.read();
        JsonStats {
            node_count: self.index.nodes.len() as u32,
            max_depth: self.index.max_depth,
            visible_rows: visibility.visible_total(),
            byte_len: self.bytes.len(),
            index_bytes: self.index.heap_bytes(),
            synthetic_root: self.index.synthetic_root,
            filtered: visibility.is_filtered(),
        }
    }

    pub fn rows(&self, start: u32, count: u32) -> Vec<JsonRow> {
        let visibility = self.visibility.read();
        let mut rows = Vec::with_capacity(count as usize);
        let mut current = visibility.node_at_row(start);

        while rows.len() < count as usize {
            let Some(id) = current else { break };
            rows.push(self.row(id, &visibility));
            current = visibility.next_visible(id);
        }
        rows
    }

    fn row(&self, id: u32, visibility: &Visibility) -> JsonRow {
        let node = &self.index.nodes[id as usize];
        let bytes: &[u8] = &self.bytes;
        let parent_is_array = self
            .index
            .node(node.parent)
            .is_some_and(|p| p.kind == scanner::Kind::Array);

        let (value, truncated) = if node.kind.is_container() {
            (None, false)
        } else {
            let (text, cut) = text::decode_scalar(bytes, node);
            (Some(text), cut)
        };

        JsonRow {
            id,
            depth: node.depth,
            key: (node.key_len > 0).then(|| text::decode_key(bytes, node)),
            index: parent_is_array.then_some(node.sibling_index),
            kind: node.kind.as_str(),
            value,
            truncated,
            child_count: node.child_count,
            container: node.kind.is_container(),
            collapsed: visibility.is_collapsed(id),
        }
    }

    /// Children of the node a key/value table should show for `id`.
    pub fn children_page(&self, id: u32, start: u32, count: u32) -> Option<ChildrenPage> {
        let target = self.index.table_target(id)?;
        let node = self.index.node(target)?;
        let visibility = self.visibility.read();
        let rows = self
            .index
            .children(target, start, count)
            .into_iter()
            .map(|child| self.row(child, &visibility))
            .collect();

        Some(ChildrenPage {
            target,
            target_path: self.index.path_of(&self.bytes, target),
            target_kind: node.kind.as_str(),
            total: node.child_count,
            start,
            rows,
        })
    }

    /// A node's value for copying, plus a flag when it hit the transfer
    /// ceiling. Strings come back as their actual text — see `text::decode_full`
    /// for why that differs from what the row shows.
    pub fn node_text(&self, id: u32) -> Option<(String, bool)> {
        let node = self.index.node(id)?;
        Some(text::decode_full(&self.bytes, node, MAX_NODE_TEXT_BYTES))
    }

    pub fn path_of(&self, id: u32) -> Option<String> {
        self.index.node(id)?;
        Some(self.index.path_of(&self.bytes, id))
    }

    pub fn toggle(&self, id: u32) {
        self.visibility.write().toggle(&self.index.nodes, id);
    }

    pub fn set_collapsed(&self, id: u32, collapsed: bool) {
        self.visibility
            .write()
            .set_collapsed(&self.index.nodes, id, collapsed);
    }

    pub fn expand_all(&self) {
        self.visibility.write().expand_all(&self.index.nodes);
    }

    pub fn collapse_all(&self) {
        self.visibility.write().collapse_all(&self.index.nodes);
    }

    pub fn set_expand_depth(&self, depth: u16) {
        self.visibility
            .write()
            .set_expand_depth(&self.index.nodes, depth);
    }

    /// Open every ancestor of `id` and report the row it landed on.
    pub fn reveal(&self, id: u32) -> Option<u32> {
        let mut visibility = self.visibility.write();
        visibility.reveal(&self.index.nodes, id);
        visibility.row_of(id)
    }

    pub fn run_search(
        &self,
        options: &SearchOptions,
        cancel: &AtomicBool,
        on_batch: impl FnMut(&[search::SearchHit], usize),
    ) -> Result<search::SearchSummary> {
        let result = search::search(&self.bytes, &self.index, options, cancel, on_batch)?;
        let summary = result.summary.clone();
        *self.search.write() = Some(result);
        Ok(summary)
    }

    pub fn clear_search(&self) {
        *self.search.write() = None;
        self.visibility.write().clear_filter(&self.index.nodes);
    }

    /// Collapse the view down to search hits and their ancestors.
    pub fn filter_to_matches(&self) -> u32 {
        let guard = self.search.read();
        let Some(result) = guard.as_ref() else {
            return 0;
        };
        let nodes = result.nodes();
        let mut visibility = self.visibility.write();
        visibility.apply_filter(&self.index.nodes, &nodes);
        visibility.visible_total()
    }

    /// Drop the filter but keep the hit list — turning the filter off should
    /// not cost the user their search.
    pub fn clear_filter(&self) {
        self.visibility.write().clear_filter(&self.index.nodes);
    }

    pub fn hit_node(&self, ordinal: usize) -> Option<u32> {
        self.search.read().as_ref()?.hits.get(ordinal).map(|h| h.node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(src: &str) -> JsonDoc {
        JsonDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("scan failed")
    }

    /// The virtual list positions rows by index at a fixed height, so a value
    /// carrying a newline would draw over the rows beneath it. Nothing that
    /// reaches a row may contain one.
    #[test]
    fn every_row_is_a_single_line() {
        let src = concat!(
            r#"{"multi":"first\nsecond\nthird","#,
            r#""tabbed":"a\tb","#,
            r#""carriage":"a\r\nb","#,
            r#""line\nbreak\nin\nkey":1,"#,
            r#""nested":{"deep":"x\ny"}}"#
        );
        let doc = doc(src);
        doc.expand_all();
        let rows = doc.rows(0, 100);
        assert!(rows.len() >= 6);

        for row in &rows {
            if let Some(key) = &row.key {
                assert_eq!(key.lines().count().max(1), 1, "multi-line key: {key:?}");
                assert!(!key.contains(['\n', '\r', '\t']));
            }
            if let Some(value) = &row.value {
                assert_eq!(value.lines().count().max(1), 1, "multi-line value: {value:?}");
                assert!(!value.contains(['\n', '\r', '\t']));
            }
        }
    }

    #[test]
    fn a_multi_line_value_shows_its_escapes() {
        let doc = doc(r#"{"a":"first\nsecond"}"#);
        doc.expand_all();
        let rows = doc.rows(0, 10);
        let value = rows[1].value.as_deref().expect("scalar row");
        assert_eq!(value, r#"first\nsecond"#);
    }

    /// Copying is a different job from previewing: the row shows `first\nsecond`
    /// so it stays on one line, but the clipboard gets the value itself.
    #[test]
    fn copying_a_string_gives_its_actual_text() {
        let doc = doc(r#"{"a":"first\nsecond"}"#);
        let (text, truncated) = doc.node_text(1).expect("node");
        assert_eq!(text, "first\nsecond");
        assert!(!truncated);
        assert!(!text.starts_with('"'), "surrounding quotes must be dropped");
    }

    #[test]
    fn copying_resolves_every_escape() {
        let doc = doc(r#"{"a":"tab:\there\u0021 quote:\" slash:\/ \uD55C\uAE00"}"#);
        let (text, _) = doc.node_text(1).expect("node");
        assert_eq!(text, "tab:\there! quote:\" slash:/ 한글");
    }

    /// A container's source *is* the value, so it copies verbatim and stays
    /// valid JSON to paste elsewhere.
    #[test]
    fn copying_a_container_gives_the_source_json() {
        let src = r#"{"a":"x\ny","b":[1,2]}"#;
        let doc = doc(src);
        assert_eq!(doc.node_text(0).expect("root").0, src);
        let array = doc.index.children(0, 1, 1)[0];
        assert_eq!(doc.node_text(array).expect("array").0, "[1,2]");
    }

    #[test]
    fn copying_a_number_gives_the_literal() {
        let doc = doc(r#"{"a":-2.5e3}"#);
        assert_eq!(doc.node_text(1).expect("node").0, "-2.5e3");
    }

    #[test]
    fn an_oversized_value_is_cut_and_flagged() {
        let long = "x".repeat(MAX_NODE_TEXT_BYTES + 100);
        let doc = doc(&format!(r#"{{"a":"{long}"}}"#));
        let (text, truncated) = doc.node_text(1).expect("node");
        assert!(truncated);
        assert!(text.len() <= MAX_NODE_TEXT_BYTES);
        assert!(text.starts_with("xxx"));
    }

    #[test]
    fn the_key_value_table_is_single_line_too() {
        let doc = doc(r#"{"outer":{"a":"x\ny","b":"p\tq"}}"#);
        let page = doc.children_page(1, 0, 10).expect("children");
        assert_eq!(page.rows.len(), 2);
        for row in &page.rows {
            let value = row.value.as_deref().unwrap_or_default();
            assert_eq!(value.lines().count().max(1), 1);
        }
        assert_eq!(page.rows[0].value.as_deref(), Some(r#"x\ny"#));
    }
}
