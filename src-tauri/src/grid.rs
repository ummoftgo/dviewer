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
use crate::table::{CellText, TablePage, TableSearch};

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
