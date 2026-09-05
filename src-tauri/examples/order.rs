//! cargo run --release --example order -- ../fixtures/huge.csv
//! Same grid and Order paths as the app; three page samples before/after are controls.
use std::{path::Path, sync::{Arc, atomic::AtomicBool}, time::Instant};
use dviewer_lib::{bytes::DocBytes, grid::{Grid, array::JsonArrayGrid, order::{Order, Sort}},
    parquet::ParquetDoc, sqlite::{SqliteDoc, SqliteGrid}, table::{Records, TableDoc},
    tree::{TreeDoc, index::Syntax, scanner::ScanLimits}, xlsx::{XlsxDoc, XlsxGrid}};

fn pages(grid: &dyn Grid, order: Option<&Order>, label: &str) {
    let count = order.map_or_else(|| grid.row_count(), |o| o.rows.len() as u32);
    for start in [0, count / 2, count.saturating_sub(100)] {
        let mut times = Vec::new();
        for _ in 0..3 {
            let at = Instant::now();
            let page = match order { Some(o) => o.page(grid, start, 100), None => grid.page(start, 100) }.unwrap();
            std::hint::black_box(page);
            times.push(at.elapsed().as_secs_f64() * 1000.0);
        }
        println!("page,{label},{start},{:.3},{:.3},{:.3}", times[0], times[1], times[2]);
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("fixture path");
    let cancel = AtomicBool::new(false);
    let at = Instant::now();
    let bytes = Arc::new(DocBytes::map_file(Path::new(&path)).unwrap());
    let size = bytes.len();
    let grid: Box<dyn Grid> = match Path::new(&path).extension().and_then(|s| s.to_str()).unwrap() {
        "sqlite" => {
            let doc = Arc::new(SqliteDoc::open(Path::new(&path)).unwrap());
            let name = doc.collections().iter().find(|c| !c.is_view).unwrap().name.clone();
            Box::new(SqliteGrid::open(doc, &name).unwrap())
        }
        "xlsx" => {
            let doc = XlsxDoc::open(bytes).unwrap();
            Box::new(XlsxGrid::open(&doc, &doc.sheets()[0].name).unwrap())
        }
        "parquet" => Box::new(ParquetDoc::open(bytes).unwrap()),
        "json" => {
            let tree = Arc::new(TreeDoc::build(bytes, Syntax::Json, &ScanLimits::default(), |_| {}, &|| false).unwrap());
            let node = tree.children_page(0, 0, 100).unwrap().rows.into_iter().find(|r| r.key.as_deref() == Some("items")).unwrap().id;
            let at = Instant::now();
            let grid = JsonArrayGrid::open(tree, node, &cancel).unwrap();
            println!("array_open_ms,{:.3},index_bytes,{}", at.elapsed().as_secs_f64() * 1000.0, grid.index_bytes());
            Box::new(grid)
        }
        _ => {
            let records = Records::for_kind(dviewer_lib::source::detect_kind(&path, &bytes), &bytes);
            Box::new(TableDoc::build(bytes, records, |_| {}, &|| false).unwrap())
        }
    };
    println!("file,{path},bytes,{size},rows,{},columns,{},open_ms,{:.3}", grid.row_count(), grid.column_count(), at.elapsed().as_secs_f64() * 1000.0);
    pages(grid.as_ref(), None, "control_before");
    for (label, sort, filter) in [
        ("number", Some(Sort { column: 0, descending: true }), ""),
        ("text", Some(Sort { column: 1, descending: false }), ""),
        ("filter_zero", None, "M19-never-matches-8df30"),
    ] {
        let at = Instant::now();
        match Order::build(grid.as_ref(), sort, filter, &cancel, &mut |_, _| {}) {
            Ok(order) => {
                let stats = order.stats();
                println!("order,{label},ms,{:.3},shown,{},index_bytes,{},peak_bytes,{}", at.elapsed().as_secs_f64() * 1000.0, stats.shown, stats.index_bytes, stats.peak_bytes);
                if sort.is_some() { pages(grid.as_ref(), Some(&order), label); }
            }
            Err(error) => println!("order,{label},ms,{:.3},error,{error}", at.elapsed().as_secs_f64() * 1000.0),
        }
    }
    pages(grid.as_ref(), None, "control_after");
}
