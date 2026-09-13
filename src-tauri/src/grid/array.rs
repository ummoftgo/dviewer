//! A tree's direct children, indexed once and read through the shared grid.
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use crate::error::{Error, Result, Subject};
use crate::grid::Grid;
use crate::jsonl::{self, JsonlLayout};
use crate::query::{Interpretation, Matcher};
use crate::table::{CellText, TableCell, TableHit, TablePage, TableRow, TableSearch, MAX_CELL_TEXT_BYTES, MAX_SEARCH_HITS};
use crate::tree::{TreeDoc, index::Syntax, scanner::{Kind, Node}};

pub struct JsonArrayGrid {
    pub tree: Arc<TreeDoc>,
    rows: Vec<u32>,
    layout: Option<JsonlLayout>,
    map: bool,
    columns: Vec<String>,
}

impl JsonArrayGrid {
    pub fn open(tree: Arc<TreeDoc>, root: u32, cancel: &AtomicBool) -> Result<Self> {
        let node = tree.index.node(root).ok_or(Error::NoSuchNode)?;
        if tree.index.syntax == Syntax::Xml || !matches!(node.kind, Kind::Array | Kind::Object) {
            return Err(Error::WrongView { subject: Subject::Tree });
        }
        if node.child_count == 0 { return Err(Error::NoSuchRow); }
        let map = node.kind == Kind::Object;
        let mut rows = Vec::with_capacity(node.child_count as usize);
        let mut next = root + 1;
        let end = root + node.subtree_size;
        while next < end {
            if rows.len() % 4096 == 0 && cancel.load(Ordering::Relaxed) { return Err(Error::Cancelled); }
            rows.push(next);
            next += tree.index.nodes[next as usize].subtree_size;
        }
        let mut columns = Vec::new();
        let sample = &rows[..rows.len().min(jsonl::SAMPLE_LINES)];
        let mut objects = 0;
        for &id in sample {
            if tree.index.nodes[id as usize].kind != Kind::Object { continue; }
            objects += 1;
            for field in jsonl::fields(&tree.index.nodes, id) {
                let key = String::from_utf8_lossy(jsonl::key_of(&tree.bytes, field));
                if columns.len() < jsonl::MAX_COLUMNS && !columns.contains(&key.as_ref().to_owned()) {
                    columns.push(key.into_owned());
                }
            }
        }
        let layout = if objects as f64 >= sample.len() as f64 * jsonl::AGREEMENT && !columns.is_empty() {
            Some(JsonlLayout { columns: columns.clone() })
        } else {
            columns = vec!["value".into()];
            None
        };
        if map { columns.insert(0, "key".into()); }
        Ok(Self { tree, rows, layout, map, columns })
    }

    pub fn columns(&self) -> &[String] { &self.columns }
    pub fn index_bytes(&self) -> usize { self.rows.capacity() * size_of::<u32>() }

    fn element(&self, row: u32) -> Result<u32> {
        self.rows.get(row as usize).copied().ok_or(Error::NoSuchRow)
    }

    fn fields(&self, id: u32) -> Vec<Option<&Node>> {
        match &self.layout {
            Some(layout) if self.tree.index.nodes[id as usize].kind == Kind::Object =>
                jsonl::by_column(&self.tree.bytes, &self.tree.index.nodes, id, layout),
            _ => {
                let mut fields = vec![None; self.column_count() as usize - usize::from(self.map)];
                fields[0] = Some(&self.tree.index.nodes[id as usize]);
                fields
            }
        }
    }

    fn key_node(&self, id: u32) -> Node {
        let node = self.tree.index.nodes[id as usize];
        Node { kind: Kind::String, val_start: node.key_start - 1, val_len: node.key_len + 2, ..node }
    }
}

impl Grid for JsonArrayGrid {
    fn row_count(&self) -> u32 { self.rows.len() as u32 }
    fn column_count(&self) -> u32 { self.columns.len() as u32 }

    fn page(&self, start: u32, count: u32) -> Result<TablePage> {
        let mut rows = Vec::new();
        for index in start..start.saturating_add(count).min(self.row_count()) {
            let id = self.element(index)?;
            let mut cells = Vec::new();
            if self.map { cells.push(jsonl::node_cell(&self.tree.bytes, &self.key_node(id))); }
            cells.extend(self.fields(id).into_iter().map(|node| match node {
                Some(node) => jsonl::node_cell(&self.tree.bytes, node),
                None => TableCell { text: String::new(), truncated: false, null: false, preview_bytes: None },
            }));
            rows.push(TableRow { index, cells });
        }
        Ok(TablePage { start, rows })
    }

    fn cell_text(&self, row: u32, column: u32) -> Result<CellText> {
        if column >= self.column_count() { return Err(Error::NoSuchCell); }
        let id = self.element(row)?;
        let (text, truncated) = if self.map && column == 0 {
            jsonl::node_text(&self.tree.bytes, &self.key_node(id), MAX_CELL_TEXT_BYTES)
        } else {
            match self.fields(id)[column as usize - usize::from(self.map)] {
                Some(node) => jsonl::node_text(&self.tree.bytes, node, MAX_CELL_TEXT_BYTES),
                None => (String::new(), false),
            }
        };
        Ok(CellText { text, truncated })
    }

    fn row_text(&self, row: u32) -> Result<CellText> {
        self.element(row)?;
        let mut text = String::new();
        let mut truncated = false;
        for column in 0..self.column_count() {
            if column > 0 { text.push('\t'); }
            let cell = self.cell_text(row, column)?;
            let remaining = MAX_CELL_TEXT_BYTES.saturating_sub(text.len());
            let mut end = cell.text.len().min(remaining);
            while !cell.text.is_char_boundary(end) { end -= 1; }
            text.push_str(&cell.text[..end]);
            truncated |= cell.truncated || end < cell.text.len();
            if text.len() >= MAX_CELL_TEXT_BYTES { truncated |= column + 1 < self.column_count(); break; }
        }
        Ok(CellText { text, truncated })
    }

    fn search(&self, query: &str, case_sensitive: bool, how: Interpretation, cancel: &AtomicBool) -> Result<TableSearch> {
        let matcher = Matcher::new(query, case_sensitive, how)?;
        let mut hits = Vec::new();
        if query.is_empty() { return Ok(TableSearch { hits, capped: false }); }
        for row in 0..self.row_count() {
            if row % 4096 == 0 && cancel.load(Ordering::Relaxed) { return Err(Error::Cancelled); }
            for column in 0..self.column_count() {
                if matcher.matches(&self.cell_text(row, column)?.text) {
                    if hits.len() == MAX_SEARCH_HITS { return Ok(TableSearch { hits, capped: true }); }
                    hits.push(TableHit { row, column });
                }
            }
        }
        Ok(TableSearch { hits, capped: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bytes::DocBytes, tree::scanner::ScanLimits};

    fn tree(source: &str) -> Arc<TreeDoc> {
        Arc::new(TreeDoc::build(Arc::new(DocBytes::from(source.as_bytes().to_vec())), Syntax::Json,
            &ScanLimits::default(), |_| {}, &|| false).unwrap())
    }
    fn grid(source: &str) -> JsonArrayGrid { JsonArrayGrid::open(tree(source), 0, &AtomicBool::new(false)).unwrap() }

    #[test]
    fn columns_follow_first_appearance_and_missing_values_stay_empty() {
        let grid = grid(r#"[{"b":2,"a":1},{"c":3}]"#);
        assert_eq!(grid.columns(), ["b", "a", "c"]);
        assert_eq!(grid.cell_text(1, 0).unwrap().text, "");
        assert_eq!(grid.cell_text(1, 2).unwrap().text, "3");
    }
    #[test]
    fn scalar_array_has_one_value_column() {
        let grid = grid(r#"["hello",42,true,null]"#);
        assert_eq!(grid.columns(), ["value"]);
        assert_eq!(grid.cell_text(0, 0).unwrap().text, "hello");
        assert_eq!(grid.cell_text(3, 0).unwrap().text, "null");
    }
    #[test]
    fn mixed_array_keeps_the_odd_element_in_its_first_column() {
        let grid = grid(r#"[{"a":1},{"a":2},{"a":3},[4]]"#);
        assert_eq!(grid.columns(), ["a"]);
        assert_eq!(grid.cell_text(3, 0).unwrap().text, "[4]");
    }
    #[test]
    fn map_keys_are_a_separate_column() {
        let grid = grid(r#"{"a":{"n":1},"b":{"n":2}}"#);
        assert_eq!(grid.columns(), ["key", "n"]);
        assert_eq!(grid.cell_text(1, 0).unwrap().text, "b");
        assert_eq!(grid.page(1, 1).unwrap().rows[0].index, 1);
    }
    #[test]
    fn nested_values_and_escapes_agree_with_jsonl() {
        let record = r#"{"s":"a\nb\"c","nested":["x",{"a":1}]}"#;
        let grid = grid(&format!("[{record}]"));
        let layout = jsonl::detect(record.as_bytes()).unwrap();
        let line = jsonl::cells(record.as_bytes(), 0, record.len() as u32, &layout);
        let page = grid.page(0, 1).unwrap();
        for (column, cell) in line.iter().enumerate() {
            assert_eq!(page.rows[0].cells[column].text, cell.text);
            assert_eq!(grid.cell_text(0, column as u32).unwrap().text,
                jsonl::value_text(record.as_bytes(), 0, record.len() as u32, &layout, column, MAX_CELL_TEXT_BYTES).unwrap().0);
        }
        assert_eq!(page.rows[0].cells[1].text, r#"["x",{"a":1}]"#);
        assert_eq!(grid.cell_text(0, 0).unwrap().text, "a\nb\"c");
    }
    #[test]
    fn nested_array_uses_its_own_children_only() {
        let tree = tree(r#"{"before":[],"items":[{"x":{"deep":1}},{"y":2}],"after":3}"#);
        let grid = JsonArrayGrid::open(tree, 2, &AtomicBool::new(false)).unwrap();
        assert_eq!(grid.columns(), ["x", "y"]);
        assert_eq!(grid.row_count(), 2);
    }
    #[test]
    fn columns_are_capped() {
        let fields = (0..80).map(|i| format!("\"c{i}\":{i}")).collect::<Vec<_>>().join(",");
        assert_eq!(grid(&format!("[{{{fields}}}]")).column_count(), 64);
    }
    #[test]
    fn empty_containers_and_scalars_are_refused() {
        for source in ["[]", "{}", "1"] {
            assert!(JsonArrayGrid::open(tree(source), 0, &AtomicBool::new(false)).is_err());
        }
        assert_eq!(grid("[{},{}]").columns(), ["value"]);
    }
    #[test]
    fn collecting_rows_can_be_cancelled() {
        assert!(matches!(JsonArrayGrid::open(tree("[1]"), 0, &AtomicBool::new(true)), Err(Error::Cancelled)));
    }
    #[test]
    fn grid_holds_the_tree_after_the_parent_drops_it() {
        let parent = tree("[1,2]");
        let grid = JsonArrayGrid::open(parent.clone(), 0, &AtomicBool::new(false)).unwrap();
        assert!(Arc::ptr_eq(&parent, &grid.tree));
        drop(parent);
        assert_eq!(grid.cell_text(1, 0).unwrap().text, "2");
    }
    #[test]
    fn search_uses_full_values_and_original_row_numbers() {
        let grid = grid(r#"["a\nb","else"]"#);
        let hits = grid.search("^a\\nb$", false, Interpretation::Regex, &AtomicBool::new(false)).unwrap().hits;
        assert_eq!((hits[0].row, hits[0].column), (0, 0));
    }

    #[test]
    fn derived_grid_values_use_the_larger_cell_preview() {
        for size in [999, 1_000, 1_001] {
            let value = "😀".repeat(size);
            let raw = serde_json::json!([value]).to_string();
            let grid = grid(&raw);
            let page = grid.page(0, 1).unwrap();
            assert_eq!(page.rows[0].cells[0].text.chars().count(), size.min(1_000));
            assert_eq!(page.rows[0].cells[0].truncated, size > 1_000);
            assert_eq!(grid.cell_text(0, 0).unwrap().text, value);
        }
    }

}
