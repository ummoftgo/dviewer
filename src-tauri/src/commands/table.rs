//! The grid: CSV and TSV.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{DocError, IndexProgress, IndexSlot};
use crate::error::{Error, Result, Subject};
use crate::state::{AppState, DocId, DocKind, DocSource, DocView};
use crate::grid::Grid;
use crate::table::{self, CellText, TableDoc, TablePage, TableSearch, TableStats};

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


/// The grid behind this document, whichever kind it is.
///
/// A document is one or the other and never both, so there is nothing to
/// choose between: a table has an index or it has not been built yet, and a
/// database has a collection chosen or it has not been chosen yet.
fn grid_of(state: &State<'_, AppState>, doc_id: DocId) -> Result<Arc<dyn Grid>> {
    let doc = state.get(doc_id)?;
    doc.grid().ok_or(Error::NotReady {
        subject: if doc.kind() == DocKind::Sqlite {
            Subject::Database
        } else {
            Subject::Table
        },
    })
}

#[tauri::command]
pub fn grid_rows(
    state: State<'_, AppState>,
    doc_id: DocId,
    start: u32,
    count: u32,
) -> Result<TablePage> {
    // A viewport request should never be able to ask for the whole file.
    grid_of(&state, doc_id)?.page(start, count.min(2000))
}

/// One cell's real text, for copying — for a delimited file that means quotes
/// stripped and doubled quotes collapsed, unlike the escaped single line the
/// grid shows.
#[tauri::command]
pub fn grid_cell_text(
    state: State<'_, AppState>,
    doc_id: DocId,
    row: u32,
    column: u32,
) -> Result<CellText> {
    grid_of(&state, doc_id)?.cell_text(row, column)
}

/// A whole row as text.
#[tauri::command]
pub fn grid_row_text(state: State<'_, AppState>, doc_id: DocId, row: u32) -> Result<CellText> {
    grid_of(&state, doc_id)?.row_text(row)
}

/// What the grid needs to draw a collection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridStats {
    pub row_count: u32,
    pub column_count: u32,
    /// The column names the database itself gives.
    pub columns: Vec<String>,
    /// Memory the checkpoint index occupies.
    pub index_bytes: usize,
    /// The opening scan hit its ceiling, so the row count is that ceiling and
    /// not the collection's real size.
    pub truncated: bool,
}

/// Choose which table or view the grid shows.
///
/// Async because of the scan behind it. Reading one integer per row is cheap
/// per row and not cheap over five million of them, and a synchronous command
/// would spend that time holding the event loop — the same mistake that made
/// the detached panel draw nothing.
#[tauri::command]
pub async fn sqlite_select(
    state: State<'_, AppState>,
    doc_id: DocId,
    name: String,
) -> Result<GridStats> {
    let doc = state.get(doc_id)?;
    let database = doc.database().ok_or(Error::NotReady {
        subject: Subject::Database,
    })?;

    let grid = tauri::async_runtime::spawn_blocking(move || {
        crate::sqlite::SqliteGrid::open(database, &name)
    })
    .await
    .map_err(Error::internal)??;

    let stats = GridStats {
        row_count: grid.row_count(),
        column_count: grid.column_count(),
        columns: grid.columns().to_vec(),
        index_bytes: grid.index_bytes(),
        truncated: grid.truncated(),
    };
    doc.set_collection(Arc::new(grid));
    Ok(stats)
}

/// What a database offers to look at.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collections {
    pub items: Vec<crate::sqlite::Collection>,
}

/// The tables and views in a database.
///
/// Opening the connection is the whole cost here; nothing is scanned. A
/// database with two hundred tables must not read two hundred tables to show
/// their names — the rows come later, and only for the one that is chosen.
#[tauri::command]
pub fn sqlite_collections(
    state: State<'_, AppState>,
    doc_id: DocId,
) -> Result<Collections> {
    let doc = state.get(doc_id)?;
    if doc.kind() != DocKind::Sqlite {
        return Err(Error::WrongView {
            subject: Subject::Database,
        });
    }
    if let Some(database) = doc.database() {
        return Ok(Collections {
            items: database.collections().to_vec(),
        });
    }

    let DocSource::File { path } = &doc.meta().source else {
        // A database is a file on disk. There is nothing to connect to in a
        // downloaded buffer or a pasted string.
        return Err(Error::UnsupportedScheme);
    };
    let database = Arc::new(crate::sqlite::SqliteDoc::open(std::path::Path::new(path))?);
    let items = database.collections().to_vec();
    doc.set_database(database);
    Ok(Collections { items })
}

/// The statement that created a table or view.
#[tauri::command]
pub fn sqlite_schema(
    state: State<'_, AppState>,
    doc_id: DocId,
    name: String,
) -> Result<Option<String>> {
    state
        .get(doc_id)?
        .database()
        .ok_or(Error::NotReady {
            subject: Subject::Database,
        })?
        .schema_of(&name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableShape {
    pub stats: TableStats,
    pub header: Vec<String>,
}

/// Show a log's trailing `key=value` pairs as columns, or fold them back.
///
/// A display switch like `table_set_plain`: same records, wider split.
#[tauri::command]
pub fn table_set_expand(
    state: State<'_, AppState>,
    doc_id: DocId,
    expand: bool,
) -> Result<TableShape> {
    let table = table_doc(&state, doc_id)?;
    table.set_expand(expand);
    Ok(TableShape {
        stats: table.stats(),
        header: table.header(),
    })
}

/// Show a recognised log as one column, or as its fields again.
///
/// A display switch, not a re-read: the record index is the same either way,
/// so this returns the new shape immediately rather than re-indexing.
#[tauri::command]
pub fn table_set_plain(
    state: State<'_, AppState>,
    doc_id: DocId,
    plain: bool,
) -> Result<TableShape> {
    let table = table_doc(&state, doc_id)?;
    table.set_plain(plain);
    Ok(TableShape {
        stats: table.stats(),
        header: table.header(),
    })
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
