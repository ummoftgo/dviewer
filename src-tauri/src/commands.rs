use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bytes::{DocBytes, decode_utf8};
use crate::error::{Error, Result};
use crate::fonts::{self, FontFamily};
use crate::highlight::{self, HighlightCss};
use crate::convert;
use crate::encoding;
use crate::json::index::Syntax;
use crate::json::search::{SearchHit, SearchOptions, SearchSummary};
use crate::json::{ChildrenPage, JsonDoc, JsonRow, JsonStats, scanner::ScanLimits};
use crate::markdown::{self, RenderedMarkdown};
use crate::source;
use crate::state::{AppState, DocId, DocKind, DocMeta, DocSource, DocView, Document};
use crate::table::{self, TableDoc, TablePage, TableSearch, TableStats};

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
            let bytes = Arc::new(bytes);
            // Decoding comes first: a UTF-16 document does not even begin with
            // the character that would say what format it is.
            let decoded = encoding::decode(Arc::clone(&bytes));
            let kind = source::detect_kind(&title, &decoded.bytes);
            Ok::<_, Error>((bytes, decoded, title, base_dir, kind))
        }
    })
    .await
    .map_err(|e| Error::rejected(e.to_string()))??;
    let (bytes, decoded, title, base_dir, kind) = opened;

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
            decoded,
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

    let bytes = Arc::new(DocBytes::from(fetched.bytes));
    let decoded = encoding::decode(Arc::clone(&bytes));
    let kind = source::kind_from_response(
        &fetched.title,
        fetched.content_type.as_deref(),
        &decoded.bytes,
    );

    Ok(state
        .insert(Document::new(
            state.next_id(),
            fetched.title,
            DocSource::Url { url },
            None,
            kind,
            bytes,
            decoded,
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
    // Pasted text arrived as a Rust String, so it is already UTF-8 and the
    // decode is free; it runs anyway so every document reports an encoding.
    let bytes = Arc::new(DocBytes::from(content.into_bytes()));
    let decoded = encoding::decode(Arc::clone(&bytes));
    let title = title.unwrap_or_else(|| "붙여넣은 문서".to_owned());
    let kind = kind.unwrap_or_else(|| source::detect_kind(&title, &decoded.bytes));

    Ok(state
        .insert(Document::new(
            state.next_id(),
            title,
            DocSource::Text,
            None,
            kind,
            bytes,
            decoded,
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

/// Read the document as a different encoding.
///
/// Detection is a guess and a short file can be valid in several encodings at
/// once, so this is the escape hatch. Everything derived from the old reading
/// is dropped: byte offsets do not survive a change of encoding.
#[tauri::command]
pub fn set_doc_encoding(
    state: State<'_, AppState>,
    doc_id: DocId,
    encoding_name: String,
) -> Result<DocMeta> {
    let target = encoding::by_name(&encoding_name)
        .ok_or_else(|| Error::rejected(format!("모르는 인코딩입니다: {encoding_name}")))?;
    let doc = state.get(doc_id)?;
    state.cancel_jobs(doc_id);
    doc.set_encoding(target);
    Ok(doc.meta())
}

/// The encodings the picker offers, in menu order.
#[tauri::command]
pub fn encoding_choices() -> Vec<(String, String)> {
    encoding::CHOICES
        .iter()
        .map(|(name, label)| ((*name).to_owned(), (*label).to_owned()))
        .collect()
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
    let bytes = doc.bytes();
    if bytes.len() > MAX_MARKDOWN_BYTES {
        return Err(Error::rejected(format!(
            "원문이 너무 큽니다 ({}MB). 최대 {}MB까지 표시합니다.",
            bytes.len() / 1024 / 1024,
            MAX_MARKDOWN_BYTES / 1024 / 1024
        )));
    }
    // Turning megabytes of bytes into a String is not something to do on the
    // UI thread.
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
    let bytes = doc.bytes();
    if bytes.len() > MAX_MARKDOWN_BYTES {
        return Err(Error::rejected(format!(
            "문서가 너무 큽니다 ({}MB). 마크다운 렌더링은 {}MB까지 지원합니다.",
            bytes.len() / 1024 / 1024,
            MAX_MARKDOWN_BYTES / 1024 / 1024
        )));
    }
    let source = decode_utf8(&bytes);
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
///
/// The `json:` prefix on these commands and events names the tree engine, not
/// the format: YAML, TOML and XML come through here too. See `tree_bytes` for
/// what each of them is actually handed to the scanner.
#[tauri::command]
pub fn json_open(app: AppHandle, state: State<'_, AppState>, doc_id: DocId) -> Result<()> {
    let doc = state.get(doc_id)?;
    if doc.tree().is_some() {
        let _ = app.emit(
            "json:ready",
            IndexReady {
                doc_id,
                stats: doc.tree().expect("just checked").stats(),
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
                    "json:progress",
                    IndexProgress {
                        doc_id,
                        bytes_done: done,
                        bytes_total: total,
                    },
                );
            };
            JsonDoc::build(bytes, syntax, &ScanLimits::default(), progress, &should_stop)
        });

        if should_stop() {
            return;
        }
        match built {
            Ok(json) => {
                let stats = json.stats();
                doc.set_tree(Arc::new(json));
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
        _ => Err(Error::rejected("이 형식은 트리로 볼 수 없습니다.")),
    }
}

fn json_doc(state: &State<'_, AppState>, doc_id: DocId) -> Result<Arc<JsonDoc>> {
    state
        .get(doc_id)?
        .tree()
        .ok_or_else(|| Error::rejected("아직 문서 구조를 읽는 중입니다."))
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

// --- CSV and TSV ----------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableReady {
    doc_id: DocId,
    stats: TableStats,
    header: Vec<String>,
    elapsed_ms: u64,
}

/// Index the record starts in the background, the way `json_open` does. A
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
        return Err(Error::rejected("이 형식은 표로 볼 수 없습니다."));
    }

    let cancel = state.start_index_job(doc_id);
    let bytes = doc.bytes();
    let total = bytes.len();
    // `.tsv` names its delimiter and is taken at its word. `.csv` does not:
    // the extension is used loosely, and a European spreadsheet's semicolons
    // would otherwise show up as a single column and look like a failed load.
    let delimiter = match doc.kind() {
        DocKind::Tsv => b'\t',
        _ => table::sniff_delimiter(&bytes),
    };

    std::thread::spawn(move || {
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

        match TableDoc::build(bytes, delimiter, progress, &should_stop) {
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
        .ok_or_else(|| Error::rejected("아직 표를 읽는 중입니다."))
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
        .ok_or_else(|| Error::rejected("해당 칸을 찾을 수 없습니다."))?;
    Ok(CellText { text, truncated })
}

/// A whole record, exactly as the file wrote it.
#[tauri::command]
pub fn table_row_text(state: State<'_, AppState>, doc_id: DocId, row: u32) -> Result<CellText> {
    let text = table_doc(&state, doc_id)?
        .row_text(row)
        .ok_or_else(|| Error::rejected("해당 행을 찾을 수 없습니다."))?;
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
        .map_err(|e| Error::rejected(e.to_string()))?
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
    fn a_conversion_failure_keeps_its_own_message() {
        let Err(err) = tree_bytes(DocKind::Yaml, &bytes("a: [1, 2\nb: 3\n")) else {
            panic!("a malformed document must not convert");
        };
        let message = err.to_string();
        assert!(message.starts_with("YAML"), "{message}");
        assert!(!message.contains("JSON"), "{message}");
    }
}
