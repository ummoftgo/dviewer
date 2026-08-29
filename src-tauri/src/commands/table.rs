//! The grid: CSV and TSV.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{DocError, IndexProgress, IndexSlot};
use crate::error::{Error, Result, Subject};
use crate::state::{AppState, DocId, DocView};
use crate::table::{self, TableDoc, TablePage, TableSearch, TableStats};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableReady {
    doc_id: DocId,
    stats: TableStats,
    header: Vec<String>,
    elapsed_ms: u64,
}

/// Index the record starts in the background, the way `tree_open` does. A
/// 500MB export takes about as long to walk as a 500MB JSON file, and for the
/// same reason it must not be walked on the UI thread.
#[tauri::command]
pub fn table_open(app: AppHandle, state: State<'_, AppState>, doc_id: DocId) -> Result<()> {
    let doc = state.get(doc_id)?;
    if let Some(existing) = doc.table() {
        let _ = app.emit(
            "table:ready",
            TableReady {
                doc_id,
                stats: existing.stats(),
                header: existing.header(),
                elapsed_ms: 0,
            },
        );
        return Ok(());
    }
    if doc.kind().view() != DocView::Table {
        return Err(Error::WrongView {
            subject: Subject::Table,
        });
    }

    // Someone is already reading this document; they will announce it.
    let Some(cancel) = state.start_index_job(doc_id) else {
        return Ok(());
    };
    let bytes = doc.bytes();
    let total = bytes.len();
    let records = table::Records::for_kind(doc.kind(), &bytes);

    std::thread::spawn(move || {
        // Hands the slot back whichever way this thread leaves — success,
        // error, cancellation or panic — so the document can be indexed again
        // after a format or encoding switch.
        let _slot = IndexSlot::new(app.clone(), doc_id, Arc::clone(&cancel));
        let started = std::time::Instant::now();
        let should_stop = || cancel.load(Ordering::Relaxed);
        let emitter = app.clone();
        let progress = move |done: usize| {
            let _ = emitter.emit(
                "table:progress",
                IndexProgress {
                    doc_id,
                    bytes_done: done,
                    bytes_total: total,
                },
            );
        };

        match TableDoc::build(bytes, records, progress, &should_stop) {
            Ok(built) => {
                if should_stop() {
                    return;
                }
                let stats = built.stats();
                let header = built.header();
                doc.set_table(Arc::new(built));
                let _ = app.emit(
                    "table:ready",
                    TableReady {
                        doc_id,
                        stats,
                        header,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            Err(err) => {
                if should_stop() {
                    return;
                }
                let _ = app.emit(
                    "table:error",
                    DocError {
                        doc_id,
                        message: err.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

fn table_doc(state: &State<'_, AppState>, doc_id: DocId) -> Result<Arc<TableDoc>> {
    state
        .get(doc_id)?
        .table()
        .ok_or(Error::NotReady {
            subject: Subject::Table,
        })
}

#[tauri::command]
pub fn table_rows(
    state: State<'_, AppState>,
    doc_id: DocId,
    start: u32,
    count: u32,
) -> Result<TablePage> {
    // A viewport request should never be able to ask for the whole file.
    Ok(table_doc(&state, doc_id)?.page(start, count.min(2000)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableShape {
    pub stats: TableStats,
    pub header: Vec<String>,
}

/// Treat the first record as column names, or as data. Cheap either way: the
/// record index does not change, only where the rows start.
#[tauri::command]
pub fn table_set_has_header(
    state: State<'_, AppState>,
    doc_id: DocId,
    has_header: bool,
) -> Result<TableShape> {
    let table = table_doc(&state, doc_id)?;
    table.set_has_header(has_header);
    Ok(TableShape {
        stats: table.stats(),
        header: table.header(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellText {
    pub text: String,
    pub truncated: bool,
}

/// One cell's real text, for copying — quotes stripped and doubled quotes
/// collapsed, unlike the escaped single line the grid shows.
#[tauri::command]
pub fn table_cell_text(
    state: State<'_, AppState>,
    doc_id: DocId,
    row: u32,
    column: u32,
) -> Result<CellText> {
    let (text, truncated) = table_doc(&state, doc_id)?
        .cell_text(row, column)
        .ok_or(Error::NoSuchCell)?;
    Ok(CellText { text, truncated })
}

/// A whole record, exactly as the file wrote it.
#[tauri::command]
pub fn table_row_text(state: State<'_, AppState>, doc_id: DocId, row: u32) -> Result<CellText> {
    let text = table_doc(&state, doc_id)?
        .row_text(row)
        .ok_or(Error::NoSuchRow)?;
    Ok(CellText {
        truncated: false,
        text,
    })
}

/// Find every cell containing `query`.
///
/// Unlike the tree's search this answers in one call rather than streaming:
/// the hit list is capped low enough to cross the IPC boundary whole, and a
/// grid has nowhere to show partial results anyway.
#[tauri::command]
pub async fn table_search(
    state: State<'_, AppState>,
    doc_id: DocId,
    query: String,
    case_sensitive: bool,
) -> Result<TableSearch> {
    let table = table_doc(&state, doc_id)?;
    let cancel = state.start_search_job(doc_id);
    tauri::async_runtime::spawn_blocking(move || table.search(&query, case_sensitive, &cancel))
        .await
        .map_err(Error::internal)?
}
