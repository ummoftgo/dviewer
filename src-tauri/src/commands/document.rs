//! Opening, closing, and re-reading a document as something else.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::bytes::DocBytes;
use crate::cli::LaunchRequest;
use crate::encoding;
use crate::error::{Error, Result};
use crate::source;
use crate::state::{AppState, DocId, DocKind, DocMeta, DocSource, Document};

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
    .map_err(Error::internal)??;
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
    .map_err(Error::internal)??;

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
        return Err(Error::EmptyPaste);
    }
    // Pasted text arrived as a Rust String, so it is already UTF-8 and the
    // decode is free; it runs anyway so every document reports an encoding.
    let bytes = Arc::new(DocBytes::from(content.into_bytes()));
    let decoded = encoding::decode(Arc::clone(&bytes));
    // The frontend names pasted text, because naming is presentation. This
    // fallback is only reachable if it forgets to.
    let title = title.unwrap_or_else(|| "Untitled".to_owned());
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
        .ok_or_else(|| Error::UnknownEncoding {
            name: encoding_name.clone(),
        })?;
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

/// What this window was asked to open, if anything.
///
/// Answers once per window: the request is taken, not copied, so a reload does
/// not open the same file twice.
#[tauri::command]
pub fn startup_request(window: tauri::Window, state: State<'_, AppState>) -> LaunchRequest {
    state.take_pending(window.label())
}
