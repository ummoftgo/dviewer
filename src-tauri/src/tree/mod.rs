//! The tree engine: a flat, pre-order node index and everything built on it.
//!
//! Four formats arrive here by three different routes. JSON is scanned in place
//! (`scanner`), XML gets its own scanner over the same node model
//! (`crate::xml`), and YAML and TOML are converted to JSON first
//! (`crate::convert`) because their parsers materialise a value either way.
//!
//! Past the scan nothing knows or cares which format it came from. Visibility,
//! viewport queries, search, path building and copying are all written against
//! the node array, which is why adding a format costs a scanner rather than a
//! second copy of all of that.
//!
//! The one place the origin still shows is notation: a path is written the way
//! the format's own readers expect (`$.a.b[0]` or `/a/b[1]`), which is what
//! `index::Syntax` selects.

pub mod index;
pub mod jsonpath;
pub mod scanner;
pub mod search;
pub mod text;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use parking_lot::RwLock;
use serde::Serialize;

use crate::bytes::DocBytes;
use crate::error::Result;
use index::{DEFAULT_EXPAND_DEPTH, TreeIndex, Syntax, Visibility};
use scanner::{Dialect, ScanLimits, scan, scan_as};
use search::{SearchOptions, SearchResult};

/// Ceiling on the raw text handed back for "copy value". Anything larger is a
/// file, not something to put on a clipboard.
pub const MAX_NODE_TEXT_BYTES: usize = 8 * 1024 * 1024;

/// One line of the tree, as the virtual list needs it. Values are pre-truncated
/// so a viewport of ~100 rows is a few kilobytes of IPC regardless of the file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRow {
    pub id: u32,
    pub depth: u16,
    /// Object key, or None when the parent is an array.
    pub key: Option<String>,
    /// Array position, or None when the parent is an object.
    pub index: Option<u32>,
    pub kind: &'static str,
    /// Scalar text; None for containers, which the frontend summarises.
    pub value: Option<String>,
    /// The comment written above this value, shortened to what a row can hold.
    ///
    /// Sent with the row rather than fetched on demand because a note is meant
    /// to be read while scanning — that is why its author put it there. The
    /// whole of it is in the key/value table, where there is room.
    pub comment: Option<String>,
    /// What was written after this value on its line. JSONC only.
    ///
    /// Beside `comment` rather than folded into it: one is what the author
    /// said *before* the value and one is what they said *after* it, and a row
    /// that showed them as one string would put words in an order nobody
    /// wrote.
    pub remark: Option<String>,
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
    /// about — see `TreeIndex::table_target`.
    pub target: u32,
    pub target_path: String,
    pub target_kind: &'static str,
    pub total: u32,
    pub start: u32,
    pub rows: Vec<TreeRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeStats {
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

/// Characters of a comment carried with a row.
///
/// Sized for the key/value table, which wraps it and has room, rather than for
/// the tree row, which clips it to one line in CSS. One length and one trip:
/// asking again for the same note when the reader selects the row would cost a
/// round trip to say what was already in hand.
const COMMENT_PREVIEW_CHARS: usize = 300;

pub struct TreeDoc {
    pub index: Arc<TreeIndex>,
    pub bytes: Arc<DocBytes>,
    visibility: RwLock<Visibility>,
    search: RwLock<Option<SearchResult>>,
}

impl TreeDoc {
    /// Build the tree for a document.
    ///
    /// `syntax` picks the scanner. Everything after it — visibility, rows,
    /// search, copying — is shared, which is the whole reason XML is worth
    /// scanning into this shape instead of converting it to JSON first.
    pub fn build(
        bytes: Arc<DocBytes>,
        syntax: Syntax,
        limits: &ScanLimits,
        progress: impl FnMut(usize),
        should_stop: &dyn Fn() -> bool,
    ) -> Result<Self> {
        let scanned = match syntax {
            Syntax::Json => scan(&bytes, limits, progress, should_stop)?,
            Syntax::Jsonc => {
                scan_as(&bytes, Dialect::Jsonc, limits, progress, should_stop)?
            }
            Syntax::Xml => crate::xml::scan(&bytes, limits, progress, should_stop)?,
        };
        let index = Arc::new(TreeIndex::annotated(
            scanned.nodes,
            scanned.comments,
            scanned.remarks,
            scanned.synthetic_root,
            syntax,
        ));
        let visibility = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);
        Ok(Self {
            index,
            bytes,
            visibility: RwLock::new(visibility),
            search: RwLock::new(None),
        })
    }

    pub fn stats(&self) -> TreeStats {
        let visibility = self.visibility.read();
        TreeStats {
            node_count: self.index.nodes.len() as u32,
            max_depth: self.index.max_depth,
            visible_rows: visibility.visible_total(),
            byte_len: self.bytes.len(),
            index_bytes: self.index.heap_bytes(),
            synthetic_root: self.index.synthetic_root,
            filtered: visibility.is_filtered(),
        }
    }

    pub fn rows(&self, start: u32, count: u32) -> Vec<TreeRow> {
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

    fn row(&self, id: u32, visibility: &Visibility) -> TreeRow {
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

        TreeRow {
            id,
            depth: node.depth,
            key: (node.key_len > 0).then(|| text::decode_key(bytes, node)),
            index: parent_is_array.then_some(node.sibling_index),
            kind: node.kind.as_str(),
            value,
            comment: self.comment_of(id, COMMENT_PREVIEW_CHARS),
            remark: self.remark_of(id, COMMENT_PREVIEW_CHARS),
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
    /// The comment above a node, as one line.
    ///
    /// Cut from the document's own bytes, so what comes back is what was
    /// written — only the markers are dropped, because `//` on screen would be
    /// punctuation the reader has to look past on every annotated row.
    pub fn comment_of(&self, id: u32, max_chars: usize) -> Option<String> {
        self.note_text(self.index.comment_of(id)?, max_chars)
    }

    /// The remark written after `id` on its line, read the same way.
    ///
    /// Same treatment as a comment, because it is the same thing in a
    /// different place: the author's words about this value, with the markers
    /// they had to type in order to write them.
    pub fn remark_of(&self, id: u32, max_chars: usize) -> Option<String> {
        self.note_text(self.index.remark_of(id)?, max_chars)
    }

    /// A comment span as the reader should see it: markers dropped, what is
    /// left joined into one line, cut at `max_chars`.
    ///
    /// **Read one comment at a time, not one line at a time.** A span can hold
    /// two of them — `1 /* 앞의 */ /* 뒤의 */` is one remark about one value —
    /// and stripping a `/*` from the front of the span and a `*/` from its end
    /// leaves the pair in the middle on screen. So the span is walked: skip
    /// space, take a `//` to the end of its line or a `/*` to its `*/`, and
    /// that whole thing is one comment whose markers are gone.
    ///
    /// Lines inside one comment are joined the same way they always were,
    /// leading `*` and all, which is what a wrapped block comment looks like.
    fn note_text(&self, (start, len): (u32, u32), max_chars: usize) -> Option<String> {
        let raw = &self.bytes[start as usize..(start + len) as usize];
        let text = String::from_utf8_lossy(raw);
        let mut rest = text.as_ref();
        let mut out = String::new();
        let mut taken = 0usize;

        while !rest.is_empty() {
            let here = rest.trim_start();
            let (body, after) = if let Some(after) = here.strip_prefix("//") {
                match after.find('\n') {
                    // The newline stays behind, for the next turn to skip.
                    Some(end) => (&after[..end], &after[end..]),
                    None => (after, ""),
                }
            } else if let Some(after) = here.strip_prefix("/*") {
                match after.find("*/") {
                    Some(end) => (&after[..end], &after[end + 2..]),
                    // Unterminated, which the scanner does not produce; taking
                    // the rest is better than dropping what was written.
                    None => (after, ""),
                }
            } else {
                // Not a marker. Whatever is here was written by the author,
                // so it is shown rather than dropped.
                (here, "")
            };
            rest = after;

            for line in body.lines() {
                let line = line.trim().trim_start_matches('*').trim();
                if line.is_empty() {
                    continue;
                }
                if !out.is_empty() {
                    out.push(' ');
                    taken += 1;
                }
                for character in line.chars() {
                    if taken >= max_chars {
                        out.push('…');
                        return Some(out);
                    }
                    out.push(character);
                    taken += 1;
                }
            }
        }
        (!out.is_empty()).then_some(out)
    }

    pub fn node_text(&self, id: u32) -> Option<(String, bool)> {
        let node = self.index.node(id)?;
        Some(text::decode_full(&self.bytes, node, MAX_NODE_TEXT_BYTES))
    }

    /// Which row `id` is on, or None when an ancestor is collapsed.
    ///
    /// Unlike `reveal`, this changes nothing. Restoring a selection must not
    /// expand what the reader left folded, nor scroll the view somewhere they
    /// did not ask to be.
    pub fn row_of(&self, id: u32) -> Option<u32> {
        self.visibility.read().row_of(id)
    }

    pub fn path_of(&self, id: u32) -> Option<String> {
        self.index.node(id)?;
        Some(self.index.path_of(&self.bytes, id))
    }

    pub fn toggle(&self, id: u32) {
        self.visibility.write().toggle(&self.index.nodes, id);
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

    fn doc(src: &str) -> TreeDoc {
        TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Json,
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

/// XML reaches the tree through a different scanner but every stage after it is
/// shared, so these check the seam: rows, paths, and copying, on real markup.
#[cfg(test)]
mod xml_tests {
    use super::*;

    const CATALOG: &str = concat!(
        r#"<?xml version="1.0"?>"#,
        "<catalog>",
        r#"<book id="b1"><title>Dune</title><note>a &amp; b</note></book>"#,
        r#"<book id="b2"><title>Emma</title></book>"#,
        "<!-- end -->",
        "</catalog>",
    );

    fn xml_doc(src: &str) -> TreeDoc {
        TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Xml,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("scan failed")
    }

    fn row_for(doc: &TreeDoc, key: &str, nth: usize) -> TreeRow {
        doc.expand_all();
        doc.rows(0, 500)
            .into_iter()
            .filter(|row| row.key.as_deref() == Some(key))
            .nth(nth)
            .unwrap_or_else(|| panic!("no row for {key:?} #{nth}"))
    }

    #[test]
    fn a_text_only_element_shows_its_text_on_the_element_row() {
        let doc = xml_doc(CATALOG);
        let title = row_for(&doc, "title", 0);
        assert_eq!(title.kind, "elementText");
        assert!(!title.container);
        assert_eq!(title.value.as_deref(), Some("Dune"));
    }

    #[test]
    fn attributes_appear_as_their_own_rows() {
        let doc = xml_doc(CATALOG);
        let id = row_for(&doc, "id", 0);
        assert_eq!(id.kind, "attribute");
        assert_eq!(id.value.as_deref(), Some("b1"));
    }

    /// Entities are resolved for display, so the reader sees the character
    /// rather than its spelling.
    #[test]
    fn entities_are_resolved_in_a_row() {
        let doc = xml_doc(CATALOG);
        assert_eq!(row_for(&doc, "note", 0).value.as_deref(), Some("a & b"));
    }


    // --- wide elements ------------------------------------------------------
    //
    // Past 4,096 children the sibling walk behind `[n]` is skipped, because
    // `tree_path` is the hover popover and the walk is linear — 11ms over a
    // million and a half siblings, on every row the pointer crosses. These
    // hold down what the shortcut is allowed to assume.

    /// The nth child of the document's root, attributes included, without
    /// building four thousand rows to find it.
    fn nth_child(doc: &TreeDoc, nth: u32) -> u32 {
        *doc.index
            .children(0, nth, 1)
            .first()
            .unwrap_or_else(|| panic!("no child #{nth}"))
    }

    /// Attributes are children in this index and are always pushed first, so
    /// they used to take positions away from the elements: the first `<item>`
    /// of this list copied as `item[3]`.
    #[test]
    fn attributes_do_not_shift_the_position_of_a_wide_list() {
        let mut src = String::from(r#"<list a="1" b="2">"#);
        for _ in 0..4097 {
            src.push_str("<item/>");
        }
        src.push_str("</list>");
        let doc = xml_doc(&src);

        // Children 0 and 1 are the attributes; the items start at 2.
        assert_eq!(
            doc.path_of(nth_child(&doc, 2)).as_deref(),
            Some("/list/item[1]")
        );
        assert_eq!(
            doc.path_of(nth_child(&doc, 4098)).as_deref(),
            Some("/list/item[4097]")
        );
        // And the attributes themselves are still named, not numbered.
        assert_eq!(doc.path_of(nth_child(&doc, 0)).as_deref(), Some("/list/@a"));
    }

    /// The plain case the shortcut was written for, unchanged.
    #[test]
    fn a_wide_list_without_attributes_counts_from_one() {
        let mut src = String::from("<list>");
        for _ in 0..4097 {
            src.push_str("<item/>");
        }
        src.push_str("</list>");
        let doc = xml_doc(&src);

        assert_eq!(
            doc.path_of(nth_child(&doc, 0)).as_deref(),
            Some("/list/item[1]")
        );
        assert_eq!(
            doc.path_of(nth_child(&doc, 4096)).as_deref(),
            Some("/list/item[4097]")
        );
    }

    /// A wide element need not hold one name, and then the sibling index is
    /// not the position: the first `<b>` here would be numbered as if it were
    /// the four thousand and first `<a>`. The samples catch it and the exact
    /// walk answers instead.
    #[test]
    fn a_wide_element_holding_two_names_is_counted_exactly() {
        let mut src = String::from("<x>");
        for _ in 0..4000 {
            src.push_str("<a/>");
        }
        for _ in 0..200 {
            src.push_str("<b/>");
        }
        src.push_str("</x>");
        let doc = xml_doc(&src);

        // Every `<b>` is caught by the first sample: the first child is an
        // `<a>`, so the element is not a list of `<b>` and the walk answers.
        assert_eq!(doc.path_of(nth_child(&doc, 4000)).as_deref(), Some("/x/b[1]"));
        assert_eq!(doc.path_of(nth_child(&doc, 4199)).as_deref(), Some("/x/b[200]"));

        // The `<a>` run is right at both ends. The last one takes the walk too
        // — its next sibling is a `<b>` — though for an `<a>` the shortcut
        // would have said the same thing: nothing differently named comes
        // before them, so their sibling index *is* their position. Which is
        // why this assertion cannot tell the two paths apart, and the `<b>`
        // ones above are what hold the fallback down.
        assert_eq!(doc.path_of(nth_child(&doc, 0)).as_deref(), Some("/x/a[1]"));
        assert_eq!(doc.path_of(nth_child(&doc, 3999)).as_deref(), Some("/x/a[4000]"));
    }


    /// Two names alternating, which is what a plist `<dict>` is: a `<key>` and
    /// then its value, over and over. The kth `<key>` has sibling index
    /// 2(k-1), so the shortcut would number it 2k-1 — twice what it should be.
    ///
    /// This is the layout the *next sibling* sample is for. The first child is
    /// a `<key>` and so is this node, so that sample passes; what says this is
    /// not a list is that the thing after it is a `<string>`.
    #[test]
    fn a_wide_element_of_alternating_names_is_counted_exactly() {
        let mut src = String::from("<dict>");
        for _ in 0..2100 {
            src.push_str("<key/><string/>");
        }
        src.push_str("</dict>");
        let doc = xml_doc(&src);

        assert_eq!(doc.path_of(nth_child(&doc, 0)).as_deref(), Some("/dict/key[1]"));
        assert_eq!(doc.path_of(nth_child(&doc, 1)).as_deref(), Some("/dict/string[1]"));
        assert_eq!(
            doc.path_of(nth_child(&doc, 4198)).as_deref(),
            Some("/dict/key[2100]")
        );
        assert_eq!(
            doc.path_of(nth_child(&doc, 4199)).as_deref(),
            Some("/dict/string[2100]")
        );
    }

    /// An attribute is a child here but not in XPath, so it never counts
    /// towards a position — not even when it shares the elements' name.
    #[test]
    fn an_attribute_never_counts_as_a_same_named_element() {
        let doc = xml_doc(r#"<list a="1"><a/><a/></list>"#);
        assert_eq!(doc.path_of(nth_child(&doc, 1)).as_deref(), Some("/list/a[1]"));
        assert_eq!(doc.path_of(nth_child(&doc, 2)).as_deref(), Some("/list/a[2]"));
        assert_eq!(doc.path_of(nth_child(&doc, 0)).as_deref(), Some("/list/@a"));
    }

    #[test]
    fn a_path_is_written_as_xpath() {
        let doc = xml_doc(CATALOG);
        let title = row_for(&doc, "title", 0);
        assert_eq!(doc.path_of(title.id).as_deref(), Some("/catalog/book[1]/title"));
        let id = row_for(&doc, "id", 0);
        assert_eq!(doc.path_of(id.id).as_deref(), Some("/catalog/book[1]/@id"));
    }

    /// Two elements with one name need the predicate; a lone one does not, and
    /// `[1]` on it would only be noise.
    #[test]
    fn the_predicate_appears_only_when_the_name_repeats() {
        let doc = xml_doc(CATALOG);
        let second = row_for(&doc, "title", 1);
        assert_eq!(doc.path_of(second.id).as_deref(), Some("/catalog/book[2]/title"));

        let single = xml_doc("<root><only>x</only></root>");
        single.expand_all();
        let only = single.rows(0, 10)[1].id;
        assert_eq!(single.path_of(only).as_deref(), Some("/root/only"));
    }

    #[test]
    fn a_comment_has_a_path_of_its_own_kind() {
        let doc = xml_doc(CATALOG);
        doc.expand_all();
        let comment = doc
            .rows(0, 500)
            .into_iter()
            .find(|row| row.kind == "comment")
            .expect("comment row");
        assert_eq!(comment.value.as_deref(), Some(" end "));
        assert_eq!(doc.path_of(comment.id).as_deref(), Some("/catalog/comment()"));
    }

    /// Copying an element gives the markup, which is what you would paste back
    /// into a file; copying its text gives the text.
    #[test]
    fn copying_an_element_gives_its_markup() {
        let doc = xml_doc(CATALOG);
        let book = row_for(&doc, "book", 1);
        assert_eq!(
            doc.node_text(book.id).expect("book").0,
            r#"<book id="b2"><title>Emma</title></book>"#
        );
        let note = row_for(&doc, "note", 0);
        assert_eq!(doc.node_text(note.id).expect("note").0, "a & b");
    }

    /// The tree draws rows at a fixed height, so this holds no matter which
    /// scanner produced the nodes.
    #[test]
    fn every_row_is_a_single_line() {
        let doc = xml_doc("<a><b>first\nsecond</b><c d=\"x\ty\">z</c></a>");
        doc.expand_all();
        for row in doc.rows(0, 100) {
            for text in [row.key.as_deref(), row.value.as_deref()].into_iter().flatten() {
                assert_eq!(text.lines().count().max(1), 1, "multi-line: {text:?}");
                assert!(!text.contains(['\n', '\r', '\t']));
            }
        }
    }

    #[test]
    fn searching_paths_matches_element_names() {
        let doc = xml_doc(CATALOG);
        let options = search::SearchOptions {
            how: search::Interpretation::Literal,
            query: "/catalog/book/@id".into(),
            case_sensitive: false,
            scope: search::SearchScope::Paths,
            seq: 0,
        };
        let summary = doc
            .run_search(&options, &AtomicBool::new(false), |_, _| {})
            .expect("search");
        // Both books, because a path search matches names without positions.
        assert_eq!(summary.total, 2);
    }
}

/// YAML and TOML do not have a scanner of their own: they are converted to JSON
/// and read by the JSON one. These check that the seam holds end to end.
#[cfg(test)]
mod converted_tests {
    use super::*;

    fn tree(json: String) -> TreeDoc {
        TreeDoc::build(
            Arc::new(DocBytes::from(json.into_bytes())),
            Syntax::Json,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("scan failed")
    }

    #[test]
    fn a_yaml_config_becomes_a_navigable_tree() {
        let src = b"service:\n  name: api\n  ports:\n    - 80\n    - 443\n";
        let doc = tree(crate::convert::yaml_to_json(src).expect("convert"));
        doc.expand_all();
        let rows = doc.rows(0, 100);
        let keys: Vec<&str> = rows.iter().filter_map(|r| r.key.as_deref()).collect();
        assert_eq!(keys, vec!["service", "name", "ports"]);

        let ports = rows.iter().find(|r| r.key.as_deref() == Some("ports")).expect("ports");
        assert_eq!(doc.path_of(ports.id).as_deref(), Some("$.service.ports"));
        assert_eq!(ports.child_count, 2);
        // The tree draws a clickable `[ 2 ]` for anything flagged a container,
        // so a converted document has to arrive flagged the same way a JSON one
        // does or it would show a summary that does nothing.
        assert!(ports.container, "a converted array must still be a container");
        assert!(rows[0].container, "a converted root object must be a container");
    }

    #[test]
    fn a_toml_table_becomes_a_navigable_tree() {
        let src = b"[server]\nhost = \"localhost\"\nport = 8080\n";
        let doc = tree(crate::convert::toml_to_json(src).expect("convert"));
        doc.expand_all();
        let host = doc
            .rows(0, 100)
            .into_iter()
            .find(|r| r.key.as_deref() == Some("host"))
            .expect("host");
        assert_eq!(host.value.as_deref(), Some("localhost"));
        assert_eq!(doc.node_text(host.id).expect("host").0, "localhost");
        assert!(!host.container, "a scalar has no summary to click");

        let server = doc
            .rows(0, 100)
            .into_iter()
            .find(|r| r.key.as_deref() == Some("server"))
            .expect("server");
        assert!(server.container, "a converted table must be a container");
        assert_eq!(server.child_count, 2);
    }

    /// A row carries both of the author's notes: the one above the value and
    /// the one after it, each without the markers that had to be typed.
    #[test]
    fn a_row_carries_the_note_above_and_the_one_after() {
        let src = "{\n  // 어느 포트로 열지\n  \"port\": 8080, // 기본값\n  \"host\": \"a\"\n}";
        let doc = TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Jsonc,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("build");
        doc.expand_all();
        let rows = doc.rows(0, 10);

        let port = rows.iter().find(|r| r.key.as_deref() == Some("port")).expect("port");
        assert_eq!(port.comment.as_deref(), Some("어느 포트로 열지"));
        assert_eq!(port.remark.as_deref(), Some("기본값"), "markers dropped, like a note");

        let host = rows.iter().find(|r| r.key.as_deref() == Some("host")).expect("host");
        assert_eq!(host.comment, None);
        assert_eq!(host.remark, None, "the remark above belongs to `port`");
    }

    /// A span can hold more than one comment, and every one of them loses its
    /// markers.
    ///
    /// The defect this exists for was on screen: the remark on
    /// `1 /* 앞의 */ /* 뒤의 */` read **`앞의 */ /* 뒤의`**, because the markers
    /// came off the ends of the span rather than off each comment inside it.
    /// The two multi-line shapes are here beside it because the fix walks the
    /// span, and a walk that gets those wrong would be a worse bug than the
    /// one it replaced.
    #[test]
    fn every_comment_in_a_span_loses_its_markers() {
        let src = "{\n  /* 여러 줄\n     계속 */\n  \"a\": 1 /* 앞의 */ /* 뒤의 */,\n\
                   \n  // 그리고\n  // 이어서\n  \"b\": 2\n}";
        let doc = TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Jsonc,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("build");
        doc.expand_all();
        let rows = doc.rows(0, 10);
        let row = |key: &str| {
            rows.iter()
                .find(|r| r.key.as_deref() == Some(key))
                .expect("row")
                .clone()
        };

        // Two comments on one line, joined into one remark with no markers
        // left in the middle of it.
        assert_eq!(row("a").remark.as_deref(), Some("앞의 뒤의"));
        // A block comment that wrapped is still one note.
        assert_eq!(row("a").comment.as_deref(), Some("여러 줄 계속"));
        // And so is a run of `//` lines.
        assert_eq!(row("b").comment.as_deref(), Some("그리고 이어서"));
    }

    /// The same ceiling a note has, for the same reason: the key/value table
    /// wraps it and the row clips it, so one length serves both.
    #[test]
    fn a_long_remark_is_cut_like_a_long_note() {
        let long = "가".repeat(COMMENT_PREVIEW_CHARS + 50);
        let src = format!("[1 // {long}\n]");
        let doc = TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Jsonc,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("build");

        let remark = doc.remark_of(1, COMMENT_PREVIEW_CHARS).expect("remark");
        assert_eq!(remark.chars().count(), COMMENT_PREVIEW_CHARS + 1, "cut, plus the ellipsis");
        assert!(remark.ends_with('…'));
    }

    /// Skipping a comment is not losing it.
    ///
    /// A tree document has no raw view — that is the markdown toggle — so the
    /// only way back to what was written is a node's own text. It is cut from
    /// the document's bytes, so the comments inside a container come back with
    /// it. The claim is here rather than in a comment because a comment cannot
    /// notice when it stops being true.
    #[test]
    fn a_copied_container_still_has_its_comments() {
        let src = "{\n  // 어느 포트로 열지\n  \"port\": 8080,\n  \"host\": \"a\", // 뒤에\n}";
        let doc = TreeDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            Syntax::Jsonc,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .expect("build");

        let (root, truncated) = doc.node_text(0).expect("root text");
        assert!(!truncated);
        assert!(root.contains("// 어느 포트로 열지"), "got {root:?}");
        assert!(root.contains("// 뒤에"), "got {root:?}");
        assert!(root.ends_with('}'));

        // And a scalar's text is still just the scalar.
        let (port, _) = doc.node_text(1).expect("port text");
        assert_eq!(port, "8080");
    }
}
