//! What a grid can be asked, whoever is answering.
//!
//! Two things in this app are rows and columns: a delimited file, whose rows
//! are spans of its own bytes, and a database table, whose rows come back from
//! a query. Everything the reader does with them is the same — scroll a window,
//! pick a cell, copy one — so the commands behind the grid ask through this
//! rather than branching on which kind of document they were handed.
//!
//! Deliberately narrow. Indexing and the mode switches stay with the table:
//! those are questions only a file of bytes can answer, and putting them here
//! would give every implementor a method it has to refuse. Search is not one of
//! them — "which cells contain this" is a question about a grid, and the two
//! answer it by different means for the same reader.

use std::sync::atomic::AtomicBool;

use crate::error::Result;
use crate::table::{CellText, TablePage, TableSearch, MAX_CELL_TEXT_BYTES};

/// Bytes of a binary value shown as hex in the grid.
const BINARY_PREVIEW_BYTES: usize = 16;

/// A run of bytes that is not text, as a cell shows it.
///
/// Here rather than in either format because a database's BLOB and a
/// spreadsheet's or a Parquet file's binary column are the same thing to the
/// reader, and two renderings of it would be a difference nobody could explain.
///
/// The grid takes a glance and says how big the rest is — the size is the
/// useful fact about a value that cannot be read. Copying takes the whole
/// thing, up to the ceiling every other value has, and no size: what is on the
/// clipboard is the value, not a description of it.
pub fn hex_cell(bytes: &[u8], preview: bool) -> (String, bool) {
    let shown = if preview {
        bytes.len().min(BINARY_PREVIEW_BYTES)
    } else {
        bytes.len().min(MAX_CELL_TEXT_BYTES / 2)
    };
    let mut text = String::with_capacity(shown * 2 + 3);
    text.push_str("x'");
    for byte in &bytes[..shown] {
        text.push_str(&format!("{byte:02X}"));
    }
    text.push('\'');
    let cut = shown < bytes.len();
    if cut && preview {
        text.push_str(&format!(" ({} B)", bytes.len()));
    }
    (text, cut)
}

pub trait Grid: Send + Sync {
    fn row_count(&self) -> u32;
    fn column_count(&self) -> u32;

    /// The rows a viewport is showing. `count` is already capped by the caller.
    fn page(&self, start: u32, count: u32) -> Result<TablePage>;

    /// One cell in full, for copying — not the shortened line the grid draws.
    fn cell_text(&self, row: u32, column: u32) -> Result<CellText>;

    /// A whole row as text.
    fn row_text(&self, row: u32) -> Result<CellText>;

    /// Every cell containing `query`, up to the hit ceiling.
    ///
    /// Long enough to need interrupting, so `cancel` is checked as it goes and
    /// a set flag ends it with `Cancelled` rather than with a stale answer.
    fn search(&self, query: &str, case_sensitive: bool, cancel: &AtomicBool)
        -> Result<TableSearch>;
}
