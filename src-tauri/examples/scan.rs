//! Measures the JSON indexer against a real file, with no window involved.
//!
//!   cargo run --release --example scan -- ../fixtures/huge.json [search-term]
//!
//! Prints index time, node count, index size and search time — the numbers that
//! decide whether the 500MB target is actually met.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use dviewer_lib::bytes::DocBytes;
use dviewer_lib::json::JsonDoc;
use dviewer_lib::json::scanner::ScanLimits;
use dviewer_lib::json::search::{SearchOptions, SearchScope};

fn timed_search(doc: &JsonDoc, query: &str, scope: SearchScope, label: &str) {
    let started = Instant::now();
    let summary = doc
        .run_search(
            &SearchOptions {
                query: query.to_owned(),
                case_sensitive: false,
                scope,
            },
            &AtomicBool::new(false),
            |_, _| {},
        )
        .expect("검색 실패");
    println!(
        "{label} \"{query}\" {:.2}초, {}건{}",
        started.elapsed().as_secs_f64(),
        summary.total,
        if summary.capped { " (상한 도달)" } else { "" }
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("사용법: cargo run --release --example scan -- <파일> [검색어]");
        std::process::exit(2);
    };
    let needle = args.next();

    // What `open_path` does before a tab can exist — the window the UI spends
    // with no feedback at all.
    let opening = Instant::now();
    let bytes = Arc::new(DocBytes::map_file(path.as_ref()).expect("파일을 열 수 없습니다"));
    let total = bytes.len();
    let map_time = opening.elapsed();
    println!("파일      {path} ({})", human(total));
    println!("열기      {:.1}ms (mmap + 메타데이터)", map_time.as_secs_f64() * 1000.0);

    let started = Instant::now();
    let doc = match JsonDoc::build(Arc::clone(&bytes), &ScanLimits::default(), |_| {}, &|| false) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("실패: {err}");
            std::process::exit(1);
        }
    };
    let index_time = started.elapsed();

    let stats = doc.stats();
    println!(
        "인덱싱    {:.2}초 ({:.0} MB/s)",
        index_time.as_secs_f64(),
        total as f64 / 1024.0 / 1024.0 / index_time.as_secs_f64()
    );
    println!(
        "노드      {}개, 최대 깊이 {}, 인덱스 {}",
        stats.node_count,
        stats.max_depth,
        human(stats.index_bytes)
    );
    println!("기본 표시 {}행", stats.visible_rows);

    // The two interactions that must stay instant on a huge file.
    let started = Instant::now();
    doc.expand_all();
    println!(
        "전체 펼침 {:.0}ms → {}행",
        started.elapsed().as_secs_f64() * 1000.0,
        doc.stats().visible_rows
    );

    let middle = doc.stats().visible_rows / 2;
    let started = Instant::now();
    let rows = doc.rows(middle, 100);
    println!(
        "중간 100행 {:.1}ms (첫 행: {:?})",
        started.elapsed().as_secs_f64() * 1000.0,
        rows.first().map(|r| r.kind)
    );

    if let Some(query) = needle {
        timed_search(&doc, &query, SearchScope::All, "본문 검색");
        timed_search(&doc, &query, SearchScope::Paths, "경로 검색");
        timed_search(&doc, "items[999]", SearchScope::Paths, "경로 검색");
    }
}

fn human(bytes: usize) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}
