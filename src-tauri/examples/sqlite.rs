//! Timing the checkpoint index against a database too big to walk.
//!
//!   cargo run --release --example sqlite -- ../fixtures/huge.sqlite events
//!
//! Reports what opening a collection costs, what reaching a row deep in it
//! costs — the two numbers the checkpoint index claims to have bought — and
//! what a search over the whole thing costs.

use std::sync::Arc;
use std::time::Instant;

use std::sync::atomic::AtomicBool;

use dviewer_lib::grid::Grid;
use dviewer_lib::query::Interpretation;
use dviewer_lib::sqlite::{SqliteDoc, SqliteGrid};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: sqlite <path.sqlite> <table>");
    let name = args.next().expect("usage: sqlite <path.sqlite> <table>");

    let started = Instant::now();
    let database = Arc::new(SqliteDoc::open(std::path::Path::new(&path)).expect("open"));
    println!("connect            {:>8.0?}", started.elapsed());

    let started = Instant::now();
    let grid = SqliteGrid::open(database, &name).expect("grid");
    println!(
        "scan {} rows  {:>8.0?}   index {} KB",
        grid.row_count(),
        started.elapsed(),
        grid.index_bytes() / 1024
    );

    // The counterfactual: what the same row costs with no index to seek by,
    // which is the path a view and a WITHOUT ROWID table are on.
    {
        let database = Arc::new(SqliteDoc::open(std::path::Path::new(&path)).expect("open"));
        let deep = grid.row_count().saturating_sub(60) as i64;
        let started = Instant::now();
        let connection = database.connection();
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {name} LIMIT 60 OFFSET {deep}"))
            .expect("prepare");
        let count = statement.query_map([], |_| Ok(())).expect("query").count();
        println!("offset at {deep:>7}  {:>8.0?}   ({count} rows, no index)", started.elapsed());
    }

    for row in [0u32, 1_000, grid.row_count() / 2, grid.row_count().saturating_sub(60)] {
        let started = Instant::now();
        let page = grid.page(row, 60).expect("page");
        println!(
            "page at {row:>9}  {:>8.0?}   first cell {:?}",
            started.elapsed(),
            page.rows.first().map(|r| r.cells[0].text.as_str())
        );
    }

    for query in ["event number 2999999", "ERROR"] {
        let idle = AtomicBool::new(false);
        let started = Instant::now();
        let found = grid.search(query, false, Interpretation::Literal, &idle).expect("search");
        println!(
            "search {query:?}  {:>8.0?}   {} hits{}",
            started.elapsed(),
            found.hits.len(),
            if found.capped { " (capped)" } else { "" }
        );
    }
}
