//! Measures the CSV/TSV indexer against a real file, with no window involved.
//!
//!   cargo run --release --example table -- ../fixtures/huge.csv [search-term]
//!
//! Prints index time, row and column counts, index size and the cost of one
//! viewport — the numbers that decide whether a 500MB export is actually usable
//! rather than merely openable.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use dviewer_lib::bytes::DocBytes;
use dviewer_lib::table::{self, TableDoc};

fn human(bytes: usize) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1}{}", UNITS[unit])
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("사용법: cargo run --release --example table -- <파일> [검색어]");
        std::process::exit(2);
    };
    let query = args.next();

    let opening = Instant::now();
    let bytes = Arc::new(DocBytes::map_file(path.as_ref()).expect("파일을 열 수 없습니다"));
    let total = bytes.len();
    let map_time = opening.elapsed();
    let delimiter = table::sniff_delimiter(&bytes);

    println!("파일      {path} ({})", human(total));
    println!("열기      {:.1}ms (mmap + 메타데이터)", map_time.as_secs_f64() * 1000.0);
    println!("구분자    {}", table::delimiter_name(delimiter));

    let started = Instant::now();
    let doc = match TableDoc::build(Arc::clone(&bytes), delimiter, |_| {}, &|| false) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("실패: {err}");
            std::process::exit(1);
        }
    };
    let index_time = started.elapsed();
    let stats = doc.stats();

    println!(
        "색인      {:.2}s ({:.0} MB/s)",
        index_time.as_secs_f64(),
        total as f64 / 1024.0 / 1024.0 / index_time.as_secs_f64()
    );
    println!(
        "크기      {}행 × {}열, 색인 {}",
        stats.row_count, stats.column_count, human(stats.index_bytes)
    );

    // What the reader will actually see, which is the only way to tell a
    // structural success from a decoded one.
    println!("머리글    {}", doc.header().join(" | "));
    if let Some(row) = doc.page(0, 1).rows.first() {
        let cells: Vec<&str> = row.cells.iter().map(|c| c.text.as_str()).collect();
        println!("첫 행     {}", cells.join(" | "));
    }

    // What the grid actually asks for when it scrolls: one screenful.
    for start in [0, stats.row_count / 2, stats.row_count.saturating_sub(100)] {
        let at = Instant::now();
        let page = doc.page(start, 100);
        println!(
            "행 조회   {start}번부터 {}행 {:.1}ms",
            page.rows.len(),
            at.elapsed().as_secs_f64() * 1000.0
        );
    }

    let at = Instant::now();
    let cell = doc.cell_text(0, 0);
    println!(
        "칸 복사   {:.1}ms ({})",
        at.elapsed().as_secs_f64() * 1000.0,
        cell.map(|(text, _)| text).unwrap_or_default()
    );

    if let Some(query) = query {
        let at = Instant::now();
        match doc.search(&query, false, &AtomicBool::new(false)) {
            Ok(found) => println!(
                "검색      {:?} {}건{} {:.2}s",
                query,
                found.hits.len(),
                if found.capped { " (상한)" } else { "" },
                at.elapsed().as_secs_f64()
            ),
            Err(err) => eprintln!("검색 실패: {err}"),
        }
    }
}
