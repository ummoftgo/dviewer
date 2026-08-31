//! Opening, closing, and re-reading a document as something else.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State, Window};

use crate::bytes::DocBytes;
use crate::cli::LaunchRequest;
use crate::encoding;
use crate::error::{Error, Result};
use crate::source;
use crate::state::{AppState, DocId, DocKind, DocMeta, DocSource, Document};

#[tauri::command]
pub async fn open_path(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<DocMeta> {
    let path = PathBuf::from(path);
    let id = state.next_id();
    // Opening touches the disk. On a cold or remote file that blocks for as
    // long as the volume takes to answer, and a sync command would spend that
    // time holding the UI thread.
    let opened = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || {
            let (bytes, title, base_dir) = source::load_file(&path)?;
            // Before anything reads it: a compressed file says nothing about
            // its encoding or its format until it is open.
            let (bytes, title) = source::ungzip(bytes, &title)?;
            let bytes = Arc::new(bytes);
            let kind = source::detect_kind(&title, &bytes);
            let source = DocSource::File {
                path: path.to_string_lossy().into_owned(),
            };
            // An archive is a list of other documents, and one that holds a
            // single document is unwrapped into it — so what comes back from
            // here may be the entry rather than the zip. See `open_archive`.
            if kind == DocKind::Zip {
                return super::open_archive(id, bytes, title, source);
            }
            // A database and a workbook do not go through the detector. Their
            // bytes are not text in any encoding, so it would only produce a
            // confident wrong answer — and the pages it would guess from are
            // not what the reader is going to be shown anyway.
            let decoded = if kind.reads_bytes() {
                encoding::decode(Arc::clone(&bytes))
            } else {
                encoding::verbatim(Arc::clone(&bytes))
            };
            Ok::<_, Error>(Document::new(
                id, title, source, base_dir, kind, bytes, decoded,
            ))
        }
    })
    .await
    .map_err(Error::internal)??;

    // Images in a markdown file are relative to it, so the webview needs to
    // reach that directory. Nothing else does: a tree or a table never resolves
    // a local asset, and granting for those widened the scope for the rest of
    // the session with nothing asking for it — opening one file at the root of
    // a drive handed the webview the whole drive.
    //
    // The grant is one-way. Tauri's `forbid_*` outranks every allow and cannot
    // be undone, so revoking on close would make that directory unopenable for
    // the rest of the session; keeping the grant narrow is the part that can
    // actually be controlled.
    super::grant_assets(&app, &state, &opened);
    Ok(state.insert(window.label(), opened).meta())
}

#[tauri::command]
pub async fn open_url(
    window: Window,
    state: State<'_, AppState>,
    url: String,
) -> Result<DocMeta> {
    // Blocking HTTP on the async runtime's worker would stall other commands.
    let fetched = tauri::async_runtime::spawn_blocking({
        let url = url.clone();
        move || source::fetch_url(&url)
    })
    .await
    .map_err(Error::internal)??;

    // A `.gz` served as bytes arrives compressed; `Content-Encoding: gzip` is
    // already undone by the HTTP client, so this only sees the former.
    let (bytes, title) = source::ungzip(DocBytes::from(fetched.bytes), &fetched.title)?;
    let bytes = Arc::new(bytes);
    let id = state.next_id();

    // The formats that are not text at all are recognised before the detector
    // runs, by name and magic, which is all they need. For everything else the
    // order is the other way round — a UTF-16 document does not begin with the
    // character that says what format it is — so those are decoded first and
    // the server's content type is consulted over the result.
    let kind = source::detect_kind(&title, &bytes);
    let (kind, decoded) = if kind.reads_bytes() {
        let decoded = encoding::decode(Arc::clone(&bytes));
        let kind =
            source::kind_from_response(&title, fetched.content_type.as_deref(), &decoded.bytes);
        (kind, decoded)
    } else {
        (kind, encoding::verbatim(Arc::clone(&bytes)))
    };

    // See `Error::NeedsFile`. Writing the download to a temporary file would
    // make this work, and would leave the reader with a copy of a database they
    // did not ask to keep, in a place they did not choose. An archive is not
    // among them — its reader takes the bytes — so a zip at a URL opens, and
    // the entries under it name that URL as their root.
    if kind.needs_file() {
        return Err(Error::NeedsFile);
    }
    if kind == DocKind::Zip {
        let opened = super::open_archive(id, bytes, title, DocSource::Url { url })?;
        return Ok(state.insert(window.label(), opened).meta());
    }

    Ok(state
        .insert(window.label(), Document::new(
            id,
            title,
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
    window: Window,
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
        .insert(window.label(), Document::new(
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
pub fn close_doc(app: AppHandle, state: State<'_, AppState>, doc_id: DocId) {
    state.cancel_jobs(doc_id);
    // A detached panel showing a document that no longer exists can only draw
    // an error, so it goes with it.
    crate::window::close_all(&app, &state.panels_showing(doc_id));
    state.remove(doc_id);
}

#[tauri::command]
pub fn set_doc_kind(
    app: AppHandle,
    state: State<'_, AppState>,
    doc_id: DocId,
    kind: DocKind,
) -> Result<DocMeta> {
    let doc = state.get(doc_id)?;
    // See `Error::NotInterchangeable`: the switcher reinterprets bytes, and a
    // document that is not read as bytes has no reading to change.
    if !kind.reads_bytes() || !doc.kind().reads_bytes() {
        return Err(Error::NotInterchangeable);
    }
    state.cancel_jobs(doc_id);
    doc.set_kind(kind);
    // A document read as something else can become markdown here, and only
    // then does it need its directory. See `open_path` for why the grant is
    // withheld until something asks for it.
    if kind.view() == crate::state::DocView::Prose {
        if let Some(dir) = doc.base_dir.clone() {
            if state.grant_asset_dir(&dir) {
                let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            }
        }
    }
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
