use super::*;
use crate::{bytes::DocBytes, grid::array::JsonArrayGrid, tree::{TreeDoc, index::Syntax, scanner::ScanLimits}};
use std::sync::Arc;

fn grid(source: &str) -> JsonArrayGrid {
    let tree = TreeDoc::build(Arc::new(DocBytes::from(source.as_bytes().to_vec())), Syntax::Json,
        &ScanLimits::default(), |_| {}, &|| false).unwrap();
    JsonArrayGrid::open(Arc::new(tree), 0, &AtomicBool::new(false)).unwrap()
}

#[test]
fn column_filter_does_not_match_values_in_other_columns() {
    let grid = grid(r#"[{"n":3,"tag":"KEEP"},{"n":"keep","tag":"drop"},{"n":2,"tag":"keep"}]"#);
    let make = |column| Order::build(&grid, None, "keep", column, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(make(None).rows, [0, 1, 2]);
    assert_eq!(make(Some(1)).rows, [0, 2]);
    assert_eq!(make(Some(0)).rows, [1]);
}

#[test]
fn column_filter_reads_sort_keys_without_matching_them() {
    let grid = grid(r#"[{"n":3,"tag":"keep"},{"n":"keep","tag":"drop"},{"n":2,"tag":"keep"}]"#);
    let make = |sort_column, filter_column| Order::build(&grid, Some(Sort { column: sort_column, descending: false }),
        "keep", Some(filter_column), &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(make(0, 1).rows, [2, 0]);
    assert_eq!(make(1, 0).rows, [1]);
    assert_eq!(make(1, 1).rows, [0, 2]);
}

#[test]
fn invalid_filter_column_is_rejected_even_for_an_empty_filter() {
    let grid = grid("[1,2]");
    for filter in ["", "1"] {
        assert!(matches!(Order::build(&grid, None, filter, Some(1), &AtomicBool::new(false), &mut |_, _| {}), Err(Error::NoSuchCell)));
    }
}
fn ordered(source: &str, descending: bool, filter: &str) -> Order {
    Order::build(&grid(source), Some(Sort { column: 0, descending }), filter, None, &AtomicBool::new(false), &mut |_, _| {}).unwrap()
}

#[test]
fn numbers_text_and_empty_have_a_defined_order() {
    assert_eq!(ordered(r#"["x","",3,"1e3"," -2.5 ","NaN"]"#, false, "").rows, [4,2,3,5,0,1]);
}
#[test]
fn empty_stays_last_descending_too() {
    assert_eq!(ordered(r#"["x","",3,"1e3"," -2.5 ","NaN"]"#, true, "").rows, [0,5,3,2,4,1]);
}
#[test]
fn ties_keep_original_order_ascending() {
    assert_eq!(ordered(r#"[2,1,2,1,2]"#, false, "").rows, [1,3,0,2,4]);
}
#[test]
fn ties_keep_original_order_descending() {
    assert_eq!(ordered(r#"[2,1,2,1,2]"#, true, "").rows, [0,2,4,1,3]);
}
#[test]
fn neighbouring_large_integers_never_become_equal() {
    assert_eq!(ordered("[9007199254740993,9007199254740992,9223372036854775807,-9223372036854775808]", false, "").rows, [3,1,0,2]);
    assert_eq!(int_float(9007199254740993, 9007199254740992.0), Ordering::Greater);
    assert_eq!(int_float(i64::MAX, 9223372036854775808.0), Ordering::Less);
    assert_eq!(int_float(-2, -2.5), Ordering::Greater);
}
#[test]
fn integer_overflow_is_text_and_nan_is_text() {
    assert!(number("9223372036854775808").is_none());
    assert!(number("NaN").is_none());
    assert!(matches!(number("1e3"), Some(Key::Float(1000.0))));
    assert!(matches!(number(" 12 "), Some(Key::Int(12))));
}
#[test]
fn text_prefixes_end_at_a_utf8_boundary_and_ties_remain_stable() {
    let prefix = "가".repeat(43);
    assert_eq!(super::prefix(&prefix, 128).len(), 126);
    let source = format!("[\"{}z\",\"{}a\"]", "x".repeat(128), "x".repeat(128));
    assert_eq!(ordered(&source, false, "").rows, [0,1]);
}
#[test]
fn arena_refuses_the_next_key_before_exceeding_the_budget() {
    let mut arena = Vec::new();
    store_text(&mut arena, "12345", 8).unwrap();
    assert!(matches!(store_text(&mut arena, "6789", 8), Err(Error::SortTooLarge)));
    assert_eq!(arena.len(), 5);
    assert!(arena.capacity() <= 8);
}
#[test]
fn filter_is_case_insensitive_and_does_not_match_json_keys() {
    let grid = grid(r#"[{"secret":"VALUE"},{"secret":"other"}]"#);
    let make = |filter| Order::build(&grid, None, filter, None, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(make("value").rows, [0]);
    assert!(make("secret").rows.is_empty());
}
#[test]
fn filter_checks_beyond_the_preview_and_resolves_string_escapes() {
    let source = format!("[\"{}needle\\nend\",\"other\"]", "x".repeat(600));
    assert_eq!(ordered(&source, false, "NEEDLE\nEND").rows, [0]);
}
#[test]
fn filtering_and_sorting_compose() {
    let grid = grid(r#"[{"n":3,"tag":"keep"},{"n":1,"tag":"drop"},{"n":2,"tag":"keep"}]"#);
    let order = Order::build(&grid, Some(Sort { column:0, descending:false }), "keep", None, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(order.rows, [2,0]);
    assert_eq!(order.inverse(&AtomicBool::new(false)).unwrap(), [1,u32::MAX,0]);
}
#[test]
fn reading_and_sorting_can_both_be_cancelled() {
    let grid = grid("[4,3,2,1]");
    let cancel = AtomicBool::new(true);
    assert!(matches!(Order::build(&grid, None, "", None, &cancel, &mut |_,_|{}), Err(Error::Cancelled)));
    let order = ordered("[4,3,2,1]", false, "");
    assert!(matches!(order.search(&grid, "4", false, Interpretation::Literal, &cancel), Err(Error::Cancelled)));
    assert!(order.inverse.get().is_none());
    cancel.store(false, AtomicOrdering::Relaxed);
    let result = Order::build(&grid, Some(Sort {column:0,descending:false}), "", None, &cancel,
        &mut |done,total| { if done == total { cancel.store(true, AtomicOrdering::Relaxed); } });
    assert!(matches!(result, Err(Error::Cancelled)));
}
#[test]
fn page_reorders_original_rows_and_keeps_their_numbers() {
    struct Trace(JsonArrayGrid, std::sync::Mutex<Vec<(u32, u32)>>);
    impl Grid for Trace {
        fn row_count(&self) -> u32 { self.0.row_count() }
        fn column_count(&self) -> u32 { self.0.column_count() }
        fn page(&self, start: u32, count: u32) -> Result<TablePage> {
            self.1.lock().unwrap().push((start, count));
            self.0.page(start, count)
        }
        fn cell_text(&self, row: u32, column: u32) -> Result<crate::table::CellText> { self.0.cell_text(row, column) }
        fn row_text(&self, row: u32) -> Result<crate::table::CellText> { self.0.row_text(row) }
        fn search(&self, query: &str, case: bool, how: Interpretation, cancel: &AtomicBool) -> Result<TableSearch> {
            self.0.search(query, case, how, cancel)
        }
    }
    let grid = Trace(grid("[4,1,3,2]"), std::sync::Mutex::new(Vec::new()));
    let order = ordered("[4,1,3,2]", false, "");
    let page = order.page(&grid, 1, 3).unwrap();
    assert_eq!(page.start, 1);
    assert_eq!(page.rows.iter().map(|r|r.index).collect::<Vec<_>>(), [3,2,0]);
    assert_eq!(*grid.1.lock().unwrap(), [(0, 1), (2, 2)]);
    assert!(order.page(&grid, 99, 3).unwrap().rows.is_empty());
}
#[test]
fn visible_hits_are_capped_after_filter_membership() {
    let mut source = String::from("[");
    for _ in 0..MAX_SEARCH_HITS + 1 { source.push_str(r#"{"a":"needle","b":"hide"},"#); }
    source.push_str(r#"{"a":"needle","b":"keep"}]"#);
    let grid = grid(&source);
    let order = Order::build(&grid, None, "keep", None, &AtomicBool::new(false), &mut |_,_|{}).unwrap();
    let result = order.search(&grid, "needle", false, Interpretation::Literal, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].row, 0);
    assert!(!result.capped);
}
#[test]
fn sorting_maps_search_hits_to_display_positions() {
    let grid = grid(r#"["z","a","b"]"#);
    let order = ordered(r#"["z","a","b"]"#, false, "");
    let result = order.search(&grid, "z", false, Interpretation::Literal, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.hits[0].row, 2);
    assert!(order.stats().index_bytes >= 24);
}
