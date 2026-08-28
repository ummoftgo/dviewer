//! Visibility bookkeeping for the document tree.
//!
//! The virtual list asks "which node is at row N?" on every scroll frame, and
//! collapsing a node can hide millions of rows at once. A Fenwick tree answers
//! the lookup in O(log n) but makes a collapse an expensive range update; the
//! reverse is true for a plain flag array.
//!
//! So: one bit per node plus a visible-count per 4096-node block. Lookup scans
//! a few thousand block counters (microseconds) then popcounts inside one
//! block; collapse is a bit-range clear plus a recount of the blocks it
//! touched. Both are simple enough to be obviously correct.

use super::scanner::{Kind, NO_PARENT, Node};

const BLOCK_BITS: usize = 4096;
const BLOCK_WORDS: usize = BLOCK_BITS / 64;

/// Containers above this depth start expanded. Also the ceiling offered by the
/// depth control — past nine levels the indent is doing the work, not the
/// preset, and expanding further is better done per node.
pub const MAX_EXPAND_DEPTH: u16 = 9;
pub const DEFAULT_EXPAND_DEPTH: u16 = MAX_EXPAND_DEPTH;

#[derive(Clone)]
struct BitSet {
    words: Vec<u64>,
    len: usize,
}

impl BitSet {
    fn new(len: usize, value: bool) -> Self {
        let words = vec![if value { u64::MAX } else { 0 }; len.div_ceil(64)];
        let mut set = Self { words, len };
        if value {
            set.clear_tail();
        }
        set
    }

    /// Bits past `len` in the final word must stay 0 or they corrupt counts.
    fn clear_tail(&mut self) {
        let extra = self.words.len() * 64 - self.len;
        if extra > 0 && !self.words.is_empty() {
            let last = self.words.len() - 1;
            self.words[last] &= u64::MAX >> extra;
        }
    }

    #[inline]
    fn get(&self, i: usize) -> bool {
        self.words[i / 64] >> (i % 64) & 1 == 1
    }

    #[inline]
    fn set(&mut self, i: usize, value: bool) {
        let (word, bit) = (i / 64, i % 64);
        if value {
            self.words[word] |= 1 << bit;
        } else {
            self.words[word] &= !(1 << bit);
        }
    }

    /// Clear `[start, end)`, whole words at a time.
    fn clear_range(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        let (first_word, last_word) = (start / 64, (end - 1) / 64);
        if first_word == last_word {
            let mask = range_mask(start % 64, (end - 1) % 64);
            self.words[first_word] &= !mask;
            return;
        }
        self.words[first_word] &= !range_mask(start % 64, 63);
        for word in &mut self.words[first_word + 1..last_word] {
            *word = 0;
        }
        self.words[last_word] &= !range_mask(0, (end - 1) % 64);
    }

    fn count_block(&self, block: usize) -> u32 {
        let start = block * BLOCK_WORDS;
        let end = (start + BLOCK_WORDS).min(self.words.len());
        self.words[start..end]
            .iter()
            .map(|w| w.count_ones())
            .sum()
    }

    /// Number of set bits in `[block * BLOCK_BITS, upto)`.
    fn count_in_block_upto(&self, block: usize, upto: usize) -> u32 {
        let start = block * BLOCK_WORDS;
        let last_word = upto / 64;
        let mut total = 0;
        for word in start..last_word.min(self.words.len()) {
            total += self.words[word].count_ones();
        }
        if last_word < self.words.len() && upto % 64 != 0 {
            total += (self.words[last_word] & range_mask(0, upto % 64 - 1)).count_ones();
        }
        total
    }
}

/// Mask with bits `lo..=hi` set.
#[inline]
fn range_mask(lo: usize, hi: usize) -> u64 {
    let width = hi - lo + 1;
    if width == 64 {
        u64::MAX
    } else {
        ((1u64 << width) - 1) << lo
    }
}

pub struct Visibility {
    visible: BitSet,
    collapsed: BitSet,
    block_counts: Vec<u32>,
    visible_total: u32,
    /// Set while a search filter overrides the collapse state.
    filtered: bool,
}

impl Visibility {
    pub fn new(nodes: &[Node], expand_depth: u16) -> Self {
        let len = nodes.len();
        let mut vis = Self {
            visible: BitSet::new(len, false),
            collapsed: BitSet::new(len, false),
            block_counts: vec![0; len.div_ceil(BLOCK_BITS)],
            visible_total: 0,
            filtered: false,
        };
        for (i, node) in nodes.iter().enumerate() {
            if node.kind.is_container() && node.depth >= expand_depth {
                vis.collapsed.set(i, true);
            }
        }
        vis.rebuild(nodes);
        vis
    }

    pub fn visible_total(&self) -> u32 {
        self.visible_total
    }

    pub fn is_collapsed(&self, id: u32) -> bool {
        self.collapsed.get(id as usize)
    }

    pub fn is_filtered(&self) -> bool {
        self.filtered
    }

    /// Recompute every visible bit by walking the tree, skipping collapsed
    /// subtrees. Cost is proportional to what is on screen, not to the file.
    fn rebuild(&mut self, nodes: &[Node]) {
        self.visible = BitSet::new(nodes.len(), false);
        let mut i = 0usize;
        while i < nodes.len() {
            self.visible.set(i, true);
            i += if self.collapsed.get(i) {
                nodes[i].subtree_size as usize
            } else {
                1
            };
        }
        self.filtered = false;
        self.recount_all();
    }

    fn recount_all(&mut self) {
        for block in 0..self.block_counts.len() {
            self.block_counts[block] = self.visible.count_block(block);
        }
        self.visible_total = self.block_counts.iter().sum();
    }

    fn recount_range(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        let first = start / BLOCK_BITS;
        let last = (end - 1) / BLOCK_BITS;
        for block in first..=last.min(self.block_counts.len().saturating_sub(1)) {
            let before = self.block_counts[block];
            let now = self.visible.count_block(block);
            self.block_counts[block] = now;
            self.visible_total = self.visible_total - before + now;
        }
    }

    pub fn set_collapsed(&mut self, nodes: &[Node], id: u32, collapsed: bool) {
        let i = id as usize;
        if i >= nodes.len() || !nodes[i].kind.is_container() {
            return;
        }
        if self.collapsed.get(i) == collapsed {
            return;
        }
        self.collapsed.set(i, collapsed);

        // A node hidden behind a collapsed ancestor has no visible descendants
        // to update; its new state applies whenever the ancestor reopens.
        if self.filtered || !self.visible.get(i) {
            return;
        }

        let start = i + 1;
        let end = i + nodes[i].subtree_size as usize;
        if collapsed {
            self.visible.clear_range(start, end);
        } else {
            let mut j = start;
            while j < end {
                self.visible.set(j, true);
                j += if self.collapsed.get(j) {
                    nodes[j].subtree_size as usize
                } else {
                    1
                };
            }
        }
        self.recount_range(start, end);
    }

    pub fn toggle(&mut self, nodes: &[Node], id: u32) {
        let collapsed = self.is_collapsed(id);
        if self.filtered {
            // Leaving the filtered view on the first manual toggle is less
            // surprising than a toggle that appears to do nothing.
            self.collapsed.set(id as usize, !collapsed);
            self.rebuild(nodes);
            return;
        }
        self.set_collapsed(nodes, id, !collapsed);
    }

    pub fn set_expand_depth(&mut self, nodes: &[Node], depth: u16) {
        self.collapsed = BitSet::new(nodes.len(), false);
        for (i, node) in nodes.iter().enumerate() {
            if node.kind.is_container() && node.depth >= depth {
                self.collapsed.set(i, true);
            }
        }
        self.rebuild(nodes);
    }

    pub fn expand_all(&mut self, nodes: &[Node]) {
        self.collapsed = BitSet::new(nodes.len(), false);
        self.rebuild(nodes);
    }

    /// Collapse everything, root included — the view falls back to a single row.
    pub fn collapse_all(&mut self, nodes: &[Node]) {
        self.set_expand_depth(nodes, 0);
    }

    /// Expand every ancestor of `id` so it becomes visible. Outermost first,
    /// because expanding a hidden node is a no-op by design.
    pub fn reveal(&mut self, nodes: &[Node], id: u32) {
        if self.filtered {
            // Search hits are visible by construction in the filtered view;
            // jumping between them must not tear the filter down.
            if self.visible.get(id as usize) {
                return;
            }
            self.rebuild(nodes);
        }
        let mut chain = Vec::new();
        let mut current = nodes.get(id as usize).map(|n| n.parent).unwrap_or(NO_PARENT);
        while current != NO_PARENT {
            chain.push(current);
            current = nodes[current as usize].parent;
        }
        for ancestor in chain.into_iter().rev() {
            self.set_collapsed(nodes, ancestor, false);
        }
    }

    /// Show only `keep` and their ancestors — the search "filter" mode.
    pub fn apply_filter(&mut self, nodes: &[Node], keep: &[u32]) {
        let mut visible = BitSet::new(nodes.len(), false);
        for &id in keep {
            let mut current = id;
            loop {
                if visible.get(current as usize) {
                    break; // this ancestor chain is already marked
                }
                visible.set(current as usize, true);
                let parent = nodes[current as usize].parent;
                if parent == NO_PARENT {
                    break;
                }
                current = parent;
            }
        }
        self.visible = visible;
        self.filtered = true;
        self.recount_all();
    }

    pub fn clear_filter(&mut self, nodes: &[Node]) {
        if self.filtered {
            self.rebuild(nodes);
        }
    }

    /// Node shown at `row`, or None past the end.
    pub fn node_at_row(&self, row: u32) -> Option<u32> {
        if row >= self.visible_total {
            return None;
        }
        let mut remaining = row;
        let mut block = 0;
        while block < self.block_counts.len() && remaining >= self.block_counts[block] {
            remaining -= self.block_counts[block];
            block += 1;
        }
        let start = block * BLOCK_WORDS;
        let end = (start + BLOCK_WORDS).min(self.visible.words.len());
        for word_index in start..end {
            let word = self.visible.words[word_index];
            let ones = word.count_ones();
            if remaining >= ones {
                remaining -= ones;
                continue;
            }
            let mut bits = word;
            for _ in 0..remaining {
                bits &= bits - 1; // drop the lowest set bit
            }
            return Some((word_index * 64 + bits.trailing_zeros() as usize) as u32);
        }
        None
    }

    /// Next visible node after `id`. Walking rows this way costs one word scan
    /// per row instead of a full block search, and stays correct while a search
    /// filter is overriding the collapse state.
    pub fn next_visible(&self, id: u32) -> Option<u32> {
        let start = id as usize + 1;
        if start >= self.visible.len {
            return None;
        }
        let mut word_index = start / 64;
        // Mask off the bits at or before `id` in the first word.
        let mut word = self.visible.words[word_index] & !((1u64 << (start % 64)) - 1);
        loop {
            if word != 0 {
                let bit = word_index * 64 + word.trailing_zeros() as usize;
                return (bit < self.visible.len).then_some(bit as u32);
            }
            word_index += 1;
            if word_index >= self.visible.words.len() {
                return None;
            }
            word = self.visible.words[word_index];
        }
    }

    /// Row `id` is drawn at, or None when it is hidden.
    pub fn row_of(&self, id: u32) -> Option<u32> {
        let i = id as usize;
        if i >= self.visible.len || !self.visible.get(i) {
            return None;
        }
        let block = i / BLOCK_BITS;
        let before: u32 = self.block_counts[..block].iter().sum();
        Some(before + self.visible.count_in_block_upto(block, i))
    }
}

/// Immutable side of an indexed document.
/// Which notation the nodes came from. The index itself does not care — every
/// operation on it is about shape — but a path has to be written the way the
/// format's readers expect, and `$.a.b[0]` would be nonsense for an XML file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Syntax {
    Json,
    Xml,
}

pub struct TreeIndex {
    pub nodes: Vec<Node>,
    pub synthetic_root: bool,
    /// Computed once at build time. Deriving it per call would put a full scan
    /// of every node behind every collapse — 26ms on a 38M-node document.
    pub max_depth: u16,
    pub syntax: Syntax,
}

impl TreeIndex {
    pub fn new(nodes: Vec<Node>, synthetic_root: bool, syntax: Syntax) -> Self {
        let max_depth = nodes.iter().map(|n| n.depth).max().unwrap_or(0);
        Self {
            nodes,
            synthetic_root,
            max_depth,
            syntax,
        }
    }

    /// Bytes the flat node index occupies, so the UI can be honest about what
    /// a huge document costs.
    pub fn heap_bytes(&self) -> usize {
        self.nodes.len() * std::mem::size_of::<Node>()
    }

    pub fn node(&self, id: u32) -> Option<&Node> {
        self.nodes.get(id as usize)
    }

    /// Byte offset → node id, using the fact that `val_start` is non-decreasing
    /// in node order. A hit inside a key belongs to the node that key
    /// introduces, which is always the next one.
    pub fn node_at_offset(&self, offset: u32) -> Option<u32> {
        let candidate = self
            .nodes
            .partition_point(|n| n.val_start <= offset)
            .checked_sub(1)? as u32;

        if let Some(next) = self.nodes.get(candidate as usize + 1) {
            if next.key_len > 0
                && offset >= next.key_start
                && offset < next.key_start + next.key_len
            {
                return Some(candidate + 1);
            }
        }
        Some(candidate)
    }

    /// Direct children of `id`, skipping `start` of them and taking `count`.
    ///
    /// Children of a container sit at `id + 1` and then every `subtree_size`
    /// after that, so walking them needs no parent lookups — but reaching an
    /// offset does mean stepping over the ones before it, which is why paging
    /// far into a million-element array costs a walk rather than a seek.
    pub fn children(&self, id: u32, start: u32, count: u32) -> Vec<u32> {
        let Some(node) = self.node(id) else {
            return Vec::new();
        };
        if !node.kind.is_container() {
            return Vec::new();
        }

        let end = id + node.subtree_size;
        let mut child = id + 1;
        let mut skipped = 0;
        let mut out = Vec::new();
        while child < end && out.len() < count as usize {
            if skipped >= start {
                out.push(child);
            } else {
                skipped += 1;
            }
            child += self.nodes[child as usize].subtree_size;
        }
        out
    }

    /// The node whose children a key/value table should show for `id`.
    ///
    /// Selecting a scalar means "I am looking at this level", so the table
    /// shows its siblings — the parent's children — rather than nothing.
    pub fn table_target(&self, id: u32) -> Option<u32> {
        let node = self.node(id)?;
        if node.kind.is_container() {
            return Some(id);
        }
        if node.parent == NO_PARENT {
            return None;
        }
        Some(node.parent)
    }

    /// Dotted path of a node, e.g. `root.items[3].name`.
    pub fn path_of(&self, bytes: &[u8], id: u32) -> String {
        match self.syntax {
            Syntax::Json => self.json_path_of(bytes, id),
            Syntax::Xml => self.xml_path_of(bytes, id),
        }
    }

    fn json_path_of(&self, bytes: &[u8], id: u32) -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut current = id;
        loop {
            let Some(node) = self.node(current) else { break };
            if node.parent == NO_PARENT {
                break;
            }
            let parent = &self.nodes[node.parent as usize];
            if parent.kind == Kind::Array {
                parts.push(format!("[{}]", node.sibling_index));
            } else {
                let key = super::text::decode_key(bytes, node);
                parts.push(format!(".{key}"));
            }
            current = node.parent;
        }
        parts.reverse();
        format!("${}", parts.concat())
    }

    /// An XPath-shaped location: `/catalog/book[2]/@id`.
    ///
    /// The positional predicate counts elements of the *same name*, which is
    /// what XPath means by `[2]`, so the result can be pasted into any XPath
    /// tool. It is omitted when the name is unique among its siblings, because
    /// `[1]` on a lone element is noise.
    fn xml_path_of(&self, bytes: &[u8], id: u32) -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut current = id;
        loop {
            let Some(node) = self.node(current) else { break };
            let is_root = node.parent == NO_PARENT;
            // A synthetic root is a wrapper this code invented; it is not part
            // of the document and has no place in a path.
            if is_root && self.synthetic_root {
                break;
            }
            let key = super::text::decode_key(bytes, node);
            parts.push(match node.kind {
                Kind::Attribute => format!("/@{key}"),
                Kind::Text | Kind::CData => "/text()".to_owned(),
                Kind::Comment => "/comment()".to_owned(),
                Kind::Directive => "/processing-instruction()".to_owned(),
                _ => match self.same_name_position(bytes, current, &key) {
                    Some(n) => format!("/{key}[{n}]"),
                    None => format!("/{key}"),
                },
            });
            if is_root {
                break;
            }
            current = node.parent;
        }
        parts.reverse();
        let path = parts.concat();
        if path.is_empty() { "/".to_owned() } else { path }
    }

    /// One-based position among same-named sibling elements, or None when the
    /// name occurs only once and no predicate is needed.
    ///
    /// Walking siblings is linear, which is fine for the handful of nodes a
    /// person hovers or copies. Past `WIDE` children it is not, so the sibling
    /// position stands in: a parent that wide is a list, and a list's children
    /// share one name, which makes the two counts identical anyway.
    fn same_name_position(&self, bytes: &[u8], id: u32, key: &str) -> Option<u32> {
        const WIDE: u32 = 4096;

        let node = self.node(id)?;
        let parent = self.node(node.parent)?;
        if parent.child_count <= 1 {
            return None;
        }
        if parent.child_count > WIDE {
            return Some(node.sibling_index + 1);
        }

        let mut position = 1;
        let mut total = 0;
        let mut child = node.parent + 1;
        let end = node.parent + parent.subtree_size;
        while child < end {
            let Some(sibling) = self.node(child) else { break };
            if sibling.kind != Kind::Text
                && sibling.kind != Kind::Comment
                && sibling.kind != Kind::CData
                && sibling.kind != Kind::Directive
                && super::text::decode_key(bytes, sibling) == key
            {
                total += 1;
                if child < id {
                    position += 1;
                }
            }
            child += sibling.subtree_size.max(1);
        }
        (total > 1).then_some(position)
    }
}

#[cfg(test)]
mod tests {
    use super::super::scanner::{ScanLimits, scan};
    use super::*;

    fn index(src: &str) -> TreeIndex {
        let scanned = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).unwrap();
        TreeIndex::new(scanned.nodes, scanned.synthetic_root, Syntax::Json)
    }

    /// The property everything else depends on: walking rows 0..total must
    /// reproduce exactly the nodes a manual tree walk would show, in order.
    fn expected_visible(index: &TreeIndex, vis: &Visibility) -> Vec<u32> {
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < index.nodes.len() {
            out.push(i as u32);
            i += if vis.is_collapsed(i as u32) {
                index.nodes[i].subtree_size as usize
            } else {
                1
            };
        }
        out
    }

    fn assert_rows_match(index: &TreeIndex, vis: &Visibility) {
        let expected = expected_visible(index, vis);
        assert_eq!(vis.visible_total() as usize, expected.len(), "visible_total");
        let actual: Vec<u32> = (0..vis.visible_total())
            .map(|row| vis.node_at_row(row).expect("row must resolve"))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(vis.node_at_row(vis.visible_total()), None);
        for (row, &id) in expected.iter().enumerate() {
            assert_eq!(vis.row_of(id), Some(row as u32), "row_of({id})");
        }
    }

    fn wide_deep_source() -> String {
        // Wide enough to cross several 4096-node blocks, deep enough to nest.
        let items: Vec<String> = (0..2000)
            .map(|i| format!(r#"{{"id":{i},"tags":["a","b"],"meta":{{"ok":true,"n":{i}}}}}"#))
            .collect();
        format!(r#"{{"items":[{}]}}"#, items.join(","))
    }

    #[test]
    fn a_shallow_expand_depth_collapses_everything_below_it() {
        let index = index(&wide_deep_source());
        let vis = Visibility::new(&index.nodes, 2);
        assert_rows_match(&index, &vis);
        // root + "items" + 2000 elements, each element collapsed.
        assert_eq!(vis.visible_total(), 2002);
    }

    #[test]
    fn the_default_depth_reaches_every_level_of_a_typical_document() {
        let index = index(&wide_deep_source());
        assert!(index.max_depth < DEFAULT_EXPAND_DEPTH);
        let vis = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);
        assert_eq!(vis.visible_total() as usize, index.nodes.len());
        assert_rows_match(&index, &vis);
    }

    #[test]
    fn toggling_matches_a_tree_walk_after_every_step() {
        let index = index(&wide_deep_source());
        let mut vis = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);

        // A deterministic but irregular sequence of container toggles.
        let containers: Vec<u32> = index
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.kind.is_container())
            .map(|(i, _)| i as u32)
            .collect();

        for step in [1usize, 7, 3, 11, 5] {
            for &id in containers.iter().step_by(step).take(60) {
                vis.toggle(&index.nodes, id);
                assert_rows_match(&index, &vis);
            }
        }
    }

    #[test]
    fn expand_all_then_collapse_all_are_exact() {
        let index = index(&wide_deep_source());
        let mut vis = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);

        vis.expand_all(&index.nodes);
        assert_eq!(vis.visible_total() as usize, index.nodes.len());
        assert_rows_match(&index, &vis);

        vis.collapse_all(&index.nodes);
        assert_eq!(vis.visible_total(), 1);
        assert_rows_match(&index, &vis);
    }

    #[test]
    fn reveal_opens_every_ancestor() {
        let index = index(&wide_deep_source());
        // Pinned shallow: the default depth would already show everything here,
        // and there would be nothing left for reveal to do.
        let mut vis = Visibility::new(&index.nodes, 1);
        let deepest = index
            .nodes
            .iter()
            .enumerate()
            .max_by_key(|(_, n)| n.depth)
            .map(|(i, _)| i as u32)
            .unwrap();
        assert_eq!(vis.row_of(deepest), None);

        vis.reveal(&index.nodes, deepest);
        assert!(vis.row_of(deepest).is_some());
        assert_rows_match(&index, &vis);
    }

    #[test]
    fn collapsing_a_hidden_node_takes_effect_when_it_reappears() {
        let index = index(r#"{"a":{"b":{"c":[1,2,3]}}}"#);
        let mut vis = Visibility::new(&index.nodes, 10);
        let c_array = index
            .nodes
            .iter()
            .position(|n| n.kind == Kind::Array)
            .unwrap() as u32;
        let b = index.nodes[c_array as usize].parent;

        vis.set_collapsed(&index.nodes, b, true);
        assert_eq!(vis.row_of(c_array), None);
        // Recorded while hidden, honoured on reopen.
        vis.set_collapsed(&index.nodes, c_array, true);
        vis.set_collapsed(&index.nodes, b, false);
        assert!(vis.row_of(c_array).is_some());
        assert_rows_match(&index, &vis);
    }

    #[test]
    fn filter_keeps_matches_and_their_ancestors() {
        let index = index(&wide_deep_source());
        let mut vis = Visibility::new(&index.nodes, DEFAULT_EXPAND_DEPTH);
        let target = index.nodes.len() as u32 - 1;

        vis.apply_filter(&index.nodes, &[target]);
        assert!(vis.is_filtered());
        let rows: Vec<u32> = (0..vis.visible_total())
            .map(|r| vis.node_at_row(r).unwrap())
            .collect();
        assert_eq!(*rows.last().unwrap(), target);
        // Exactly the ancestor chain plus the match.
        assert_eq!(rows.len() as u16, index.nodes[target as usize].depth + 1);

        vis.clear_filter(&index.nodes);
        assert!(!vis.is_filtered());
        assert_rows_match(&index, &vis);
    }

    #[test]
    fn children_lists_direct_descendants_only() {
        let src = r#"{"a":1,"b":{"c":2,"d":[3,4]},"e":"x"}"#;
        let index = index(src);
        let key_of = |id: u32| super::super::text::decode_key(src.as_bytes(), &index.nodes[id as usize]);

        let ids = index.children(0, 0, 100);
        assert_eq!(
            ids.iter().map(|&id| key_of(id)).collect::<Vec<_>>(),
            ["a", "b", "e"],
            "grandchildren must not appear"
        );

        let b = ids[1];
        assert_eq!(
            index.children(b, 0, 100).iter().map(|&id| key_of(id)).collect::<Vec<_>>(),
            ["c", "d"]
        );
    }

    #[test]
    fn children_pages_through_a_wide_array() {
        let src = format!("[{}]", (0..500).map(|i| i.to_string()).collect::<Vec<_>>().join(","));
        let index = index(&src);
        assert_eq!(index.children(0, 0, 3), [1, 2, 3]);
        assert_eq!(index.children(0, 497, 10).len(), 3, "a short final page");
        assert_eq!(index.children(0, 500, 10), Vec::<u32>::new());
        // Paging must land on the same nodes a full listing would.
        let all = index.children(0, 0, 500);
        assert_eq!(index.children(0, 250, 5), all[250..255]);
    }

    #[test]
    fn children_of_a_scalar_or_empty_container_is_empty() {
        let index = index(r#"{"a":1,"b":{},"c":[]}"#);
        for id in index.children(0, 0, 10) {
            assert!(index.children(id, 0, 10).is_empty());
        }
    }

    #[test]
    fn the_table_target_of_a_scalar_is_its_parent() {
        let index = index(r#"{"a":{"b":1,"c":2}}"#);
        let a = index.children(0, 0, 1)[0];
        let b = index.children(a, 0, 1)[0];

        // A container shows its own children.
        assert_eq!(index.table_target(a), Some(a));
        // A scalar shows the level it sits on: its parent's children.
        assert_eq!(index.table_target(b), Some(a));
        assert_eq!(index.table_target(0), Some(0));
    }

    #[test]
    fn a_scalar_root_has_no_table_target() {
        let index = index("42");
        assert_eq!(index.table_target(0), None);
    }

    #[test]
    fn offset_lookup_finds_keys_and_values() {
        let src = r#"{"alpha":123,"beta":"xyz"}"#;
        let index = index(src);
        let beta = index.nodes.len() as u32 - 1;
        let key_offset = src.find("beta").unwrap() as u32;
        let value_offset = src.find("xyz").unwrap() as u32;
        assert_eq!(index.node_at_offset(key_offset), Some(beta));
        assert_eq!(index.node_at_offset(value_offset), Some(beta));
        // An offset inside the root's opening brace belongs to the root.
        assert_eq!(index.node_at_offset(0), Some(0));
    }

    #[test]
    fn bitset_range_clear_respects_word_boundaries() {
        let mut set = BitSet::new(200, true);
        assert_eq!(set.count_block(0), 200);
        set.clear_range(63, 130);
        assert_eq!(set.count_block(0), 200 - (130 - 63));
        assert!(set.get(62));
        assert!(!set.get(63));
        assert!(!set.get(129));
        assert!(set.get(130));
    }
}
