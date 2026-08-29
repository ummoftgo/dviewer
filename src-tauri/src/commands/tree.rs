//! The collapsible tree: JSON, YAML, TOML and XML.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{DocError, IndexProgress};
use crate::bytes::DocBytes;
use crate::convert;
use crate::error::{Error, Result, Subject};
use crate::state::{AppState, DocId, DocKind};
use crate::tree::index::Syntax;
use crate::tree::search::{SearchHit, SearchOptions, SearchSummary};
use crate::tree::{ChildrenPage, TreeDoc, TreeRow, TreeStats, scanner::ScanLimits};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexReady {
    doc_id: DocId,
    stats: TreeStats,
    elapsed_ms: u64,
}

/// Kick off indexing in the background. Progress, completion and failure all
/// arrive as events so a 500MB file never blocks the UI thread.
///
/// Four formats come through here; `tree_bytes` decides what each of them is
/// actually handed to the scanner.
#[tauri::command]
pub fn tree_open(app: AppHandle, state: State<'_, AppState>, doc_id: DocId) -> Result<()> {
    let doc = state.get(doc_id)?;
    // Taken once, not asked-then-taken: those are two separate locks, and a
    // format switch between them clears the tree the second one expects.
    if let Some(tree) = doc.tree() {
        let _ = app.emit(
            "tree:ready",
            IndexReady {
                doc_id,
                stats: tree.stats(),
                elapsed_ms: 0,
            },
        );
        return Ok(());
    }

    let cancel = state.start_index_job(doc_id);
    let source = doc.bytes();
    let kind = doc.kind();

    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let should_stop = || cancel.load(Ordering::Relaxed);

        let built = tree_bytes(kind, &source).and_then(|(bytes, syntax)| {
            // Reported against the buffer actually being scanned: a converted
            // document is a different size from the file it came from, and a
            // progress bar that runs past its own end is worse than none.
            let total = bytes.len();
            let emitter = app.clone();
            let progress = move |done: usize| {
                let _ = emitter.emit(
                    "tree:progress",
                    IndexProgress {
                        doc_id,
                        bytes_done: done,
                        bytes_total: total,
                    },
                );
            };
            TreeDoc::build(bytes, syntax, &ScanLimits::default(), progress, &should_stop)
        });

        if should_stop() {
            return;
        }
        match built {
            Ok(json) => {
                let stats = json.stats();
                doc.set_tree(Arc::new(json));
                let _ = app.emit(
                    "tree:ready",
                    IndexReady {
                        doc_id,
                        stats,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "tree:error",
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

/// The bytes the tree is built over, and how to read them.
///
/// JSON and XML are scanned in place — no copy, no parse tree, mmap straight
/// through. YAML and TOML cannot be: their parsers materialise a value, so
/// they are converted to JSON first and the tree is built over that. The
/// document keeps its original bytes either way, which is what the raw view
/// and "copy source" still show.
fn tree_bytes(kind: DocKind, source: &Arc<DocBytes>) -> Result<(Arc<DocBytes>, Syntax)> {
    match kind {
        DocKind::Json => Ok((Arc::clone(source), Syntax::Json)),
        DocKind::Xml => Ok((Arc::clone(source), Syntax::Xml)),
        DocKind::Yaml => Ok((
            Arc::new(DocBytes::from(convert::yaml_to_json(source)?.into_bytes())),
            Syntax::Json,
        )),
        DocKind::Toml => Ok((
            Arc::new(DocBytes::from(convert::toml_to_json(source)?.into_bytes())),
            Syntax::Json,
        )),
        _ => Err(Error::WrongView {
            subject: Subject::Tree,
        }),
    }
}

fn tree_doc(state: &State<'_, AppState>, doc_id: DocId) -> Result<Arc<TreeDoc>> {
    state
        .get(doc_id)?
        .tree()
        .ok_or(Error::NotReady {
            subject: Subject::Tree,
        })
}

#[tauri::command]
pub fn tree_rows(
    state: State<'_, AppState>,
    doc_id: DocId,
    start: u32,
    count: u32,
) -> Result<Vec<TreeRow>> {
    // A viewport request should never be able to ask for the whole file.
    let count = count.min(2000);
    Ok(tree_doc(&state, doc_id)?.rows(start, count))
}

#[tauri::command]
pub fn tree_toggle(state: State<'_, AppState>, doc_id: DocId, node_id: u32) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.toggle(node_id);
    Ok(json.stats())
}

#[tauri::command]
pub fn tree_expand_all(state: State<'_, AppState>, doc_id: DocId) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.expand_all();
    Ok(json.stats())
}

#[tauri::command]
pub fn tree_collapse_all(state: State<'_, AppState>, doc_id: DocId) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.collapse_all();
    Ok(json.stats())
}

#[tauri::command]
pub fn tree_set_expand_depth(
    state: State<'_, AppState>,
    doc_id: DocId,
    depth: u16,
) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.set_expand_depth(depth);
    Ok(json.stats())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealResult {
    pub row: Option<u32>,
    pub stats: TreeStats,
}

/// Children of the node the key/value table should show for `node_id`.
#[tauri::command]
pub fn tree_children(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
    start: u32,
    count: u32,
) -> Result<Option<ChildrenPage>> {
    Ok(tree_doc(&state, doc_id)?.children_page(node_id, start, count.min(500)))
}

/// Open every ancestor of a node so it becomes visible, and report its row.
#[tauri::command]
pub fn tree_reveal(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<RevealResult> {
    let json = tree_doc(&state, doc_id)?;
    let row = json.reveal(node_id);
    Ok(RevealResult {
        row,
        stats: json.stats(),
    })
}

/// Just the path, for the hover popover. Deliberately separate from
/// `tree_node_text` so hovering a key never drags a multi-megabyte value
/// across the IPC boundary.
#[tauri::command]
pub fn tree_path(state: State<'_, AppState>, doc_id: DocId, node_id: u32) -> Result<String> {
    tree_doc(&state, doc_id)?
        .path_of(node_id)
        .ok_or(Error::NoSuchNode)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeText {
    pub text: String,
    pub truncated: bool,
    pub path: String,
}

#[tauri::command]
pub fn tree_node_text(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<NodeText> {
    let json = tree_doc(&state, doc_id)?;
    let (text, truncated) = json
        .node_text(node_id)
        .ok_or(Error::NoSuchNode)?;
    Ok(NodeText {
        text,
        truncated,
        path: json.path_of(node_id).unwrap_or_default(),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchBatch {
    doc_id: DocId,
    /// The search that produced this, echoed back so a view can tell the tail
    /// of an abandoned query from the head of the current one.
    seq: u64,
    hits: Vec<SearchHit>,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDone {
    doc_id: DocId,
    seq: u64,
    summary: SearchSummary,
    elapsed_ms: u64,
}

/// Search in the background, streaming hits as they are found. Starting a new
/// search cancels the previous one for this document.
#[tauri::command]
pub fn tree_search(
    app: AppHandle,
    state: State<'_, AppState>,
    doc_id: DocId,
    options: SearchOptions,
) -> Result<()> {
    let json = tree_doc(&state, doc_id)?;
    let cancel = state.start_search_job(doc_id);
    let seq = options.seq;

    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let on_batch = |hits: &[SearchHit], total: usize| {
            let _ = app.emit(
                "tree:search-batch",
                SearchBatch {
                    doc_id,
                    seq,
                    hits: hits.to_vec(),
                    total,
                },
            );
        };

        match json.run_search(&options, &cancel, on_batch) {
            Ok(summary) => {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let _ = app.emit(
                    "tree:search-done",
                    SearchDone {
                        doc_id,
                        seq,
                        summary,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            // Cancellation is not a failure the reader needs told about: it
            // happens because they asked for something else.
            Err(Error::Cancelled) => {}
            Err(err) => {
                let _ = app.emit(
                    "tree:search-error",
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

#[tauri::command]
pub fn tree_search_cancel(state: State<'_, AppState>, doc_id: DocId) {
    state.cancel_search_job(doc_id);
}

#[tauri::command]
pub fn tree_filter_matches(state: State<'_, AppState>, doc_id: DocId) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.filter_to_matches();
    Ok(json.stats())
}

/// Leave the filtered view without discarding the search results.
#[tauri::command]
pub fn tree_clear_filter(state: State<'_, AppState>, doc_id: DocId) -> Result<TreeStats> {
    let json = tree_doc(&state, doc_id)?;
    json.clear_filter();
    Ok(json.stats())
}

#[tauri::command]
pub fn tree_clear_search(state: State<'_, AppState>, doc_id: DocId) -> Result<TreeStats> {
    state.cancel_search_job(doc_id);
    let json = tree_doc(&state, doc_id)?;
    json.clear_search();
    Ok(json.stats())
}

/// Where a node is on screen right now. Used to put a selection back after the
/// view has been rebuilt — switching tabs tears it down and builds it again.
#[tauri::command]
pub fn tree_row_of(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<Option<u32>> {
    Ok(tree_doc(&state, doc_id)?.row_of(node_id))
}

#[tauri::command]
pub fn tree_hit_row(
    state: State<'_, AppState>,
    doc_id: DocId,
    ordinal: usize,
) -> Result<RevealResult> {
    let json = tree_doc(&state, doc_id)?;
    let row = match json.hit_node(ordinal) {
        Some(node) => json.reveal(node),
        None => None,
    };
    Ok(RevealResult {
        row,
        stats: json.stats(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(src: &str) -> Arc<DocBytes> {
        Arc::new(DocBytes::from(src.as_bytes().to_vec()))
    }

    /// The one place a format decides which scanner reads it. Getting this
    /// wrong shows up as a document that opens but is empty, which is a much
    /// harder failure to trace than one that errors.
    #[test]
    fn every_tree_format_reaches_a_scanner() {
        let json = bytes(r#"{"a":1}"#);
        let (out, syntax) = tree_bytes(DocKind::Json, &json).expect("json");
        assert_eq!(syntax, Syntax::Json);
        assert_eq!(&out[..], json.as_ref() as &[u8], "JSON must not be copied");

        let xml = bytes("<a>1</a>");
        let (out, syntax) = tree_bytes(DocKind::Xml, &xml).expect("xml");
        assert_eq!(syntax, Syntax::Xml);
        assert_eq!(&out[..], xml.as_ref() as &[u8], "XML must not be copied");

        let (out, syntax) = tree_bytes(DocKind::Yaml, &bytes("a: 1\n")).expect("yaml");
        assert_eq!(syntax, Syntax::Json);
        assert_eq!(std::str::from_utf8(&out).expect("utf8"), r#"{"a":1}"#);

        let (out, syntax) = tree_bytes(DocKind::Toml, &bytes("a = 1\n")).expect("toml");
        assert_eq!(syntax, Syntax::Json);
        assert_eq!(std::str::from_utf8(&out).expect("utf8"), r#"{"a":1}"#);
    }

    #[test]
    fn a_grid_format_is_refused_by_the_tree() {
        for kind in [DocKind::Csv, DocKind::Tsv, DocKind::Markdown] {
            assert!(tree_bytes(kind, &bytes("a,b")).is_err(), "{kind:?}");
        }
    }

    /// A broken document has to say what is wrong with *it*, not be dressed up
    /// as a JSON problem by the error type it travels in.
    #[test]
    fn a_conversion_failure_names_the_format_it_came_from() {
        let Err(error) = tree_bytes(DocKind::Yaml, &bytes("a: [1, 2
b: 3
")) else {
            panic!("a malformed document must not convert");
        };
        assert!(
            matches!(
                error,
                Error::ParseFailed {
                    subject: Subject::Yaml,
                    ..
                }
            ),
            "{error:?}"
        );
    }
}
