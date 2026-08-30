//! Everything the frontend can call, grouped by what it acts on.
//!
//! Split by subject rather than by size: opening a document, reading it as
//! prose, reading it as a tree, and reading it as a grid are four separate
//! concerns that happen to share a state handle. The re-exports below keep
//! `commands::open_path` working as a path, so `lib.rs` does not have to know
//! which file anything lives in.

mod document;
mod markdown;
mod panel;
mod table;
mod tree;

pub use document::*;
pub use markdown::*;
pub use panel::*;
pub use table::*;
pub use tree::*;

use serde::Serialize;

use crate::state::DocId;

/// Progress of a background index, in bytes of the buffer being scanned.
/// Shared because the tree and the grid report it identically.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexProgress {
    pub doc_id: DocId,
    pub bytes_done: usize,
    pub bytes_total: usize,
}

/// A failure that belongs to one document rather than to the call that
/// triggered it — it arrives as an event, long after the command returned.
///
/// Carries the error itself, the same shape a command's `Err` crosses with.
/// It used to carry `err.to_string()`, which put a Rust `Debug` line in front
/// of the reader — untranslated, and with the parameters welded into it. A
/// failure that arrives by a different road is still the same failure.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocError {
    pub doc_id: DocId,
    pub error: crate::error::Error,
}

/// Holds the indexing slot for a document until the job that claimed it ends.
///
/// A slot released only on the happy path is a slot that stays claimed when the
/// scan fails, and the document could then never be re-read.
pub(crate) struct IndexSlot {
    app: tauri::AppHandle,
    doc: crate::state::DocId,
    flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl IndexSlot {
    pub(crate) fn new(
        app: tauri::AppHandle,
        doc: crate::state::DocId,
        flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self { app, doc, flag }
    }
}

impl Drop for IndexSlot {
    fn drop(&mut self) {
        use tauri::Manager;
        self.app
            .state::<crate::state::AppState>()
            .finish_index_job(self.doc, &self.flag);
    }
}
