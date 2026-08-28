use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bytes::{DocBytes, decode_utf8};
use crate::error::{Error, Result};
use crate::fonts::{self, FontFamily};
use crate::highlight::{self, HighlightCss};
use crate::json::search::{SearchHit, SearchOptions, SearchSummary};
use crate::json::{ChildrenPage, JsonDoc, JsonRow, JsonStats, scanner::ScanLimits};
use crate::markdown::{self, RenderedMarkdown};
use crate::source;
use crate::state::{AppState, DocId, DocKind, DocMeta, DocSource, Document};

/// Markdown is rendered in one shot, so the whole source has to be a `String`.
/// Past this size it is not a document any more and the raw view handles it.
const MAX_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;

// --- opening documents ----------------------------------------------------

#[tauri::command]
pub async fn open_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<DocMeta> {
    let path = PathBuf::from(path);
    // Opening touches the disk. On a cold or remote file that blocks for as
    // long as the volume takes to answer, and a sync command would spend that
    // time holding the UI thread.
    let opened = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || {
            let (bytes, title, base_dir) = source::load_file(&path)?;
            let kind = source::detect_kind(&title, &bytes);
            Ok::<_, Error>((bytes, title, base_dir, kind))
        }
    })
    .await
    .map_err(|e| Error::rejected(e.to_string()))??;
    let (bytes, title, base_dir, kind) = opened;

    // Images in a markdown file are relative to it. Widen the asset scope to
    // that one directory rather than granting the webview the whole disk.
    if let Some(dir) = &base_dir {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
    Ok(state
        .insert(Document::new(
            state.next_id(),
            title,
            DocSource::File {
                path: path.to_string_lossy().into_owned(),
            },
            base_dir,
            kind,
            bytes,
        ))
        .meta())
}

#[tauri::command]
pub async fn open_url(state: State<'_, AppState>, url: String) -> Result<DocMeta> {
    // Blocking HTTP on the async runtime's worker would stall other commands.
    let fetched = tauri::async_runtime::spawn_blocking({
        let url = url.clone();
        move || source::fetch_url(&url)
    })
    .await
    .map_err(|e| Error::Fetch(e.to_string()))??;

    let kind = source::kind_from_response(
        &fetched.title,
        fetched.content_type.as_deref(),
        &fetched.bytes,
    );

    Ok(state
        .insert(Document::new(
            state.next_id(),
            fetched.title,
            DocSource::Url { url },
            None,
            kind,
            DocBytes::from(fetched.bytes),
        ))
        .meta())
}

#[tauri::command]
pub fn open_text(
    state: State<'_, AppState>,
    content: String,
    title: Option<String>,
    kind: Option<DocKind>,
) -> Result<DocMeta> {
    if content.trim().is_empty() {
        return Err(Error::rejected("붙여넣은 내용이 비어 있습니다."));
    }
    let bytes = content.into_bytes();
    let title = title.unwrap_or_else(|| "붙여넣은 문서".to_owned());
    let kind = kind.unwrap_or_else(|| source::detect_kind(&title, &bytes));

    Ok(state
        .insert(Document::new(
            state.next_id(),
            title,
            DocSource::Text,
            None,
            kind,
            DocBytes::from(bytes),
        ))
        .meta())
}

#[tauri::command]
pub fn close_doc(state: State<'_, AppState>, doc_id: DocId) {
    state.cancel_jobs(doc_id);
    state.remove(doc_id);
}

#[tauri::command]
pub fn set_doc_kind(state: State<'_, AppState>, doc_id: DocId, kind: DocKind) -> Result<DocMeta> {
    let doc = state.get(doc_id)?;
    state.cancel_jobs(doc_id);
    doc.set_kind(kind);
    Ok(doc.meta())
}

/// Paths passed on the command line, so `dviewer report.md` works.
#[tauri::command]
pub fn startup_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_file())
        .collect()
}

// --- markdown -------------------------------------------------------------

#[tauri::command]
pub async fn doc_source_text(state: State<'_, AppState>, doc_id: DocId) -> Result<String> {
    let doc = state.get(doc_id)?;
    if doc.bytes.len() > MAX_MARKDOWN_BYTES {
        return Err(Error::rejected(format!(
            "원문이 너무 큽니다 ({}MB). 최대 {}MB까지 표시합니다.",
            doc.bytes.len() / 1024 / 1024,
            MAX_MARKDOWN_BYTES / 1024 / 1024
        )));
    }
    // Decoding megabytes of UTF-8 is not something to do on the UI thread.
    let bytes = Arc::clone(&doc.bytes);
    tauri::async_runtime::spawn_blocking(move || decode_utf8(&bytes))
        .await
        .map_err(|e| Error::rejected(e.to_string()))
}

#[tauri::command]
pub async fn render_markdown(
    state: State<'_, AppState>,
    doc_id: DocId,
) -> Result<RenderedMarkdown> {
    let doc = state.get(doc_id)?;
    if doc.bytes.len() > MAX_MARKDOWN_BYTES {
        return Err(Error::rejected(format!(
            "문서가 너무 큽니다 ({}MB). 마크다운 렌더링은 {}MB까지 지원합니다.",
            doc.bytes.len() / 1024 / 1024,
            MAX_MARKDOWN_BYTES / 1024 / 1024
        )));
    }
    let source = decode_utf8(&doc.bytes);
    // Highlighting a large document takes long enough to drop frames.
    tauri::async_runtime::spawn_blocking(move || markdown::render(&source))
        .await
        .map_err(|e| Error::rejected(e.to_string()))
}

#[tauri::command]
pub fn highlight_css() -> &'static HighlightCss {
    highlight::highlight_css()
}

/// Installed font families, for the settings pickers. The first call walks the
/// system font directories, so it runs off the UI thread.
#[tauri::command]
pub async fn system_fonts() -> Result<&'static [FontFamily]> {
    tauri::async_runtime::spawn_blocking(fonts::families)
        .await
        .map_err(|e| Error::rejected(format!("글꼴 목록을 읽지 못했습니다: {e}")))
}

// --- JSON -----------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    doc_id: DocId,
    bytes_done: usize,
    bytes_total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocError {
    doc_id: DocId,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexReady {
    doc_id: DocId,
    stats: JsonStats,
    elapsed_ms: u64,
}

/// Kick off indexing in the background. Progress, completion and failure all
/// arrive as events so a 500MB file never blocks the UI thread.
#[tauri::command]
pub fn json_open(app: AppHandle, state: State<'_, AppState>, doc_id: DocId) -> Result<()> {
    let doc = state.get(doc_id)?;
    if doc.json().is_some() {
        let _ = app.emit(
            "json:ready",
            IndexReady {
                doc_id,
                stats: doc.json().expect("just checked").stats(),
                elapsed_ms: 0,
            },
        );
        return Ok(());
    }

    let cancel = state.start_index_job(doc_id);
    let bytes = Arc::clone(&doc.bytes);
    let total = bytes.len();

    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let should_stop = || cancel.load(Ordering::Relaxed);
        let progress = |done: usize| {
            let _ = app.emit(
                "json:progress",
                IndexProgress {
                    doc_id,
                    bytes_done: done,
                    bytes_total: total,
                },
            );
        };

        match JsonDoc::build(bytes, &ScanLimits::default(), progress, &should_stop) {
            Ok(json) => {
                if should_stop() {
                    return;
                }
                let stats = json.stats();
                doc.set_json(Arc::new(json));
                let _ = app.emit(
                    "json:ready",
                    IndexReady {
                        doc_id,
                        stats,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            Err(err) => {
                if should_stop() {
                    return;
                }
                let _ = app.emit(
                    "json:error",
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

fn json_doc(state: &State<'_, AppState>, doc_id: DocId) -> Result<Arc<JsonDoc>> {
    state
        .get(doc_id)?
        .json()
        .ok_or_else(|| Error::rejected("아직 JSON 구조를 읽는 중입니다."))
}

#[tauri::command]
pub fn json_rows(
    state: State<'_, AppState>,
    doc_id: DocId,
    start: u32,
    count: u32,
) -> Result<Vec<JsonRow>> {
    // A viewport request should never be able to ask for the whole file.
    let count = count.min(2000);
    Ok(json_doc(&state, doc_id)?.rows(start, count))
}

#[tauri::command]
pub fn json_toggle(state: State<'_, AppState>, doc_id: DocId, node_id: u32) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.toggle(node_id);
    Ok(json.stats())
}

#[tauri::command]
pub fn json_set_collapsed(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
    collapsed: bool,
) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.set_collapsed(node_id, collapsed);
    Ok(json.stats())
}

#[tauri::command]
pub fn json_expand_all(state: State<'_, AppState>, doc_id: DocId) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.expand_all();
    Ok(json.stats())
}

#[tauri::command]
pub fn json_collapse_all(state: State<'_, AppState>, doc_id: DocId) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.collapse_all();
    Ok(json.stats())
}

#[tauri::command]
pub fn json_set_expand_depth(
    state: State<'_, AppState>,
    doc_id: DocId,
    depth: u16,
) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.set_expand_depth(depth);
    Ok(json.stats())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealResult {
    pub row: Option<u32>,
    pub stats: JsonStats,
}

/// Children of the node the key/value table should show for `node_id`.
#[tauri::command]
pub fn json_children(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
    start: u32,
    count: u32,
) -> Result<Option<ChildrenPage>> {
    Ok(json_doc(&state, doc_id)?.children_page(node_id, start, count.min(500)))
}

/// Open every ancestor of a node so it becomes visible, and report its row.
#[tauri::command]
pub fn json_reveal(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<RevealResult> {
    let json = json_doc(&state, doc_id)?;
    let row = json.reveal(node_id);
    Ok(RevealResult {
        row,
        stats: json.stats(),
    })
}

/// Just the path, for the hover popover. Deliberately separate from
/// `json_node_text` so hovering a key never drags a multi-megabyte value
/// across the IPC boundary.
#[tauri::command]
pub fn json_path(state: State<'_, AppState>, doc_id: DocId, node_id: u32) -> Result<String> {
    json_doc(&state, doc_id)?
        .path_of(node_id)
        .ok_or_else(|| Error::rejected("해당 노드를 찾을 수 없습니다."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeText {
    pub text: String,
    pub truncated: bool,
    pub path: String,
}

#[tauri::command]
pub fn json_node_text(
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<NodeText> {
    let json = json_doc(&state, doc_id)?;
    let (text, truncated) = json
        .node_text(node_id)
        .ok_or_else(|| Error::rejected("해당 노드를 찾을 수 없습니다."))?;
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
    hits: Vec<SearchHit>,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDone {
    doc_id: DocId,
    summary: SearchSummary,
    elapsed_ms: u64,
}

/// Search in the background, streaming hits as they are found. Starting a new
/// search cancels the previous one for this document.
#[tauri::command]
pub fn json_search(
    app: AppHandle,
    state: State<'_, AppState>,
    doc_id: DocId,
    options: SearchOptions,
) -> Result<()> {
    let json = json_doc(&state, doc_id)?;
    let cancel = state.start_search_job(doc_id);

    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let on_batch = |hits: &[SearchHit], total: usize| {
            let _ = app.emit(
                "json:search-batch",
                SearchBatch {
                    doc_id,
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
                    "json:search-done",
                    SearchDone {
                        doc_id,
                        summary,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "json:search-error",
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
pub fn json_search_cancel(state: State<'_, AppState>, doc_id: DocId) {
    state.cancel_search_job(doc_id);
}

#[tauri::command]
pub fn json_filter_matches(state: State<'_, AppState>, doc_id: DocId) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.filter_to_matches();
    Ok(json.stats())
}

/// Leave the filtered view without discarding the search results.
#[tauri::command]
pub fn json_clear_filter(state: State<'_, AppState>, doc_id: DocId) -> Result<JsonStats> {
    let json = json_doc(&state, doc_id)?;
    json.clear_filter();
    Ok(json.stats())
}

#[tauri::command]
pub fn json_clear_search(state: State<'_, AppState>, doc_id: DocId) -> Result<JsonStats> {
    state.cancel_search_job(doc_id);
    let json = json_doc(&state, doc_id)?;
    json.clear_search();
    Ok(json.stats())
}

#[tauri::command]
pub fn json_hit_row(
    state: State<'_, AppState>,
    doc_id: DocId,
    ordinal: usize,
) -> Result<RevealResult> {
    let json = json_doc(&state, doc_id)?;
    let row = match json.hit_node(ordinal) {
        Some(node) => json.reveal(node),
        None => None,
    };
    Ok(RevealResult {
        row,
        stats: json.stats(),
    })
}
