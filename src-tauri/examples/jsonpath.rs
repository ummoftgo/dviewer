//! What a JSONPath expression costs on a file too big to hold in mind.
//!
//!   cargo run --release --example jsonpath -- ../fixtures/huge.json
//!   cargo run --release --example jsonpath -- ../fixtures/huge.json '$[-1]'
//!
//! With no expression it runs the set that matters: one of each selector, so
//! the shapes can be compared against each other. With one, it runs only that.
//!
//! The number to watch is the filter. Every other selector narrows — the work
//! follows the size of the answer — while a filter under `$..` asks its
//! question of every node in the document, which is the one case where a
//! viewer has to stay interruptible.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dviewer_lib::bytes::DocBytes;
use dviewer_lib::encoding;
use dviewer_lib::tree::index::Syntax;
use dviewer_lib::tree::scanner::ScanLimits;
use dviewer_lib::tree::search::{Interpretation, SearchOptions, SearchScope};
use dviewer_lib::tree::TreeDoc;

/// The expressions run when none is named: one of each selector, so the shapes
/// can be read against each other.
const SUITE: [&str; 10] = [
    "$.items[0]",
    "$.items[-1]",
    "$.items[1000000]",
    "$.items[1000000:1000010]",
    "$.items[0,1000000,-1]",
    "$.items[?@.id > 2399990]",
    "$..[?@.id > 2399990]",
    "$..notes",
    // The two functions that do more per node than read one value: a regex
    // over every candidate, and a query resolved inside the question. Both
    // read against the plain comparison above them, which is the point of
    // having them in the same table.
    "$.items[?match(@.slug, 'item-23999[0-9]')]",
    "$.items[?count(@.tags[*]) == 3]",
];

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: jsonpath <path.json> [expression]");
    let only = std::env::args().nth(2);

    let mapped = Arc::new(DocBytes::map_file(std::path::Path::new(&path)).expect("map"));
    let size = mapped.len();
    let bytes = encoding::decode(mapped).bytes;
    println!("파일      {path} ({:.0}MB)", size as f64 / 1048576.0);

    let started = Instant::now();
    let doc = TreeDoc::build(
        Arc::clone(&bytes),
        Syntax::Json,
        &ScanLimits::default(),
        |_| {},
        &|| false,
    )
    .expect("index");
    println!("색인      {:>8.2?}  노드 {}", started.elapsed(), doc.stats().node_count);

    match &only {
        Some(expression) => timed(&doc, expression),
        None => {
            for expression in SUITE {
                timed(&doc, expression);
            }
            // And how long giving up takes, which is the number the cancel
            // flag exists for.
            cancelled(&doc, "$..[?@.id > 0]");
        }
    }
}

fn timed(doc: &TreeDoc, expression: &str) {
    let idle = AtomicBool::new(false);
    let started = Instant::now();
    let result = doc.run_search(&options(expression), &idle, |_, _| {});
    let elapsed = started.elapsed();

    match result {
        Ok(found) => println!(
            "{expression:<42} {:>9.2?}  {}건{}",
            elapsed,
            found.total,
            if found.capped { " (상한)" } else { "" }
        ),
        Err(error) => println!("{expression:<42} {elapsed:>9.2?}  {error}"),
    }
}

/// How long a cancelled filter takes to come back.
///
/// The flag goes up from another thread a moment after the walk starts, so
/// what is measured is the gap between asking it to stop and it stopping —
/// bounded by how often the walk looks, and that is the whole point of
/// looking at all.
fn cancelled(doc: &TreeDoc, expression: &str) {
    let cancel = Arc::new(AtomicBool::new(false));
    let raised = Arc::new(std::sync::Mutex::new(None));

    let flag = Arc::clone(&cancel);
    let when = Arc::clone(&raised);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        *when.lock().expect("lock") = Some(Instant::now());
        flag.store(true, Ordering::Relaxed);
    });

    let result = doc.run_search(&options(expression), &cancel, |_, _| {});
    let stopped = Instant::now();
    let asked = raised.lock().expect("lock").expect("the flag went up");
    println!(
        "{:<42} {:>9.2?}  멈추라는 말에서 멈춤까지 ({})",
        "취소",
        stopped.saturating_duration_since(asked),
        if result.is_err() { "Cancelled" } else { "완주" }
    );
}

fn options(expression: &str) -> SearchOptions {
    SearchOptions {
        query: expression.to_owned(),
        case_sensitive: false,
        how: Interpretation::JsonPath,
        scope: SearchScope::Paths,
        seq: 0,
    }
}
