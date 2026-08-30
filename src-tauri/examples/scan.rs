//! Measures the tree indexer against a real file, with no window involved.
//!
//!   cargo run --release --example scan -- ../fixtures/huge.json [search-term]
//!
//! Prints index time, node count, index size and search time — the numbers that
//! decide whether the 500MB target is actually met.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use dviewer_lib::bytes::DocBytes;
use dviewer_lib::encoding;
use dviewer_lib::source;
use dviewer_lib::tree::TreeDoc;
use dviewer_lib::tree::index::Syntax;
use dviewer_lib::tree::scanner::ScanLimits;
use dviewer_lib::tree::search::{Interpretation, SearchOptions, SearchScope};

fn timed_search(doc: &TreeDoc, query: &str, scope: SearchScope, label: &str) {
    timed_search_as(doc, query, scope, Interpretation::Literal, label)
}

fn timed_search_as(
    doc: &TreeDoc,
    query: &str,
    scope: SearchScope,
    how: Interpretation,
    label: &str,
) {
    let started = Instant::now();
    let summary = doc
        .run_search(
            &SearchOptions {
                query: query.to_owned(),
                case_sensitive: false,
                how,
                scope,
                seq: 0,
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
    // The app opens the archive before anything reads it, so measuring
    // the file as it sits on disk would measure the wrong thing.
    let (source, path) = source::ungzip(DocBytes::map_file(path.as_ref()).expect("파일을 열 수 없습니다"), &path)
        .expect("압축을 풀 수 없습니다");
    let source = Arc::new(source);
    let total = source.len();
    let map_time = opening.elapsed();

    // The same first step the app takes: everything after this assumes UTF-8.
    let decoded = encoding::decode(source);
    let bytes = decoded.bytes;

    println!("파일      {path} ({})", human(total));
    println!("열기      {:.1}ms (mmap + 메타데이터)", map_time.as_secs_f64() * 1000.0);
    println!("인코딩    {}", encoding::label(decoded.encoding));

    let started = Instant::now();
    // An .xml file goes through the XML scanner; everything else is read as
    // JSON, which is what this measurement was written for.
    let syntax = if path.to_ascii_lowercase().ends_with(".xml") {
        Syntax::Xml
    } else {
        Syntax::Json
    };
    let doc = match TreeDoc::build(
        Arc::clone(&bytes),
        syntax,
        &ScanLimits::default(),
        |_| {},
        &|| false,
    ) {
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
        timed_search_as(
            &doc,
            "^needle: .{0,40}$",
            SearchScope::Values,
            Interpretation::Regex,
            "정규식 검색",
        );
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
