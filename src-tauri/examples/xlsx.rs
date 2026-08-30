//! What reading a workbook costs.
//!
//!   cargo run --release --example xlsx -- ../fixtures/huge.xlsx [검색어]
//!
//! The number that matters is what a sheet costs once chosen: that is where the
//! file becomes values in memory, and it is the bargain the 64MB ceiling exists
//! for. Opening is cheaper but not free — unlike Parquet, it grows with the
//! file, so it is worth printing beside the other.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use dviewer_lib::grid::Grid;
use dviewer_lib::query::Interpretation;
use dviewer_lib::xlsx::{XlsxDoc, XlsxGrid};

fn main() {
    let path = std::env::args().nth(1).expect("usage: xlsx <path.xlsx> [query]");
    let query = std::env::args().nth(2);
    let path = Path::new(&path);
    let size = std::fs::metadata(path).expect("size").len();

    let started = Instant::now();
    let book = XlsxDoc::open(path).expect("open");
    println!(
        "파일      {} ({:.1}MB)",
        path.display(),
        size as f64 / 1048576.0
    );
    println!(
        "열기      {:>8.2?}  시트 {}개: {:?}",
        started.elapsed(),
        book.sheets().len(),
        book.sheets().iter().map(|s| s.name.as_str()).collect::<Vec<_>>()
    );

    let name = book.sheets().first().expect("a sheet").name.clone();
    let started = Instant::now();
    let sheet = XlsxGrid::open(&book, &name).expect("sheet");
    println!(
        "시트 선택 {:>8.2?}  {}행 × {}열, 값 {:.0}MB",
        started.elapsed(),
        sheet.row_count(),
        sheet.column_count(),
        sheet.heap_bytes() as f64 / 1048576.0
    );

    for row in [0u32, sheet.row_count() / 2, sheet.row_count().saturating_sub(100)] {
        let started = Instant::now();
        let page = sheet.page(row, 100).expect("page");
        let first = page.rows.first().map(|r| {
            r.cells
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join(" | ")
        });
        println!(
            "행 조회   {:>8.2?}  {row:>8}번부터 100행  {}",
            started.elapsed(),
            first.unwrap_or_default()
        );
    }

    let started = Instant::now();
    sheet.set_formulas(true).expect("formulas");
    println!(
        "수식 켜기 {:>8.2?}  (시트를 한 번 더 읽습니다)  {}",
        started.elapsed(),
        sheet.page(1, 1).expect("page").rows[0].cells[3].text
    );
    sheet.set_formulas(false).expect("values");

    let started = Instant::now();
    sheet.set_formulas(true).expect("formulas");
    println!("수식 다시 {:>8.2?}  (이미 읽어 둔 것)", started.elapsed());
    sheet.set_formulas(false).expect("values");

    if let Some(query) = query {
        let idle = AtomicBool::new(false);
        for (how, label) in [
            (Interpretation::Literal, "검색"),
            (Interpretation::Regex, "정규식"),
        ] {
            let expression = match how {
                Interpretation::Regex => format!("^{}$", regex::escape(&query)),
                _ => query.clone(),
            };
            let started = Instant::now();
            let found = sheet.search(&expression, false, how, &idle).expect("search");
            println!(
                "{label:<9} {:>8.2?}  {expression:?} {}건{}",
                started.elapsed(),
                found.hits.len(),
                if found.capped { " (상한)" } else { "" }
            );
        }
    }
}
