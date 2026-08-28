//! Prose: the rendered document, its source, and the pieces the view needs
//! around it.

use tauri::State;

use crate::bytes::decode_utf8;
use crate::error::{Error, Result};
use crate::fonts::{self, FontFamily};
use crate::highlight::{self, HighlightCss};
use crate::markdown::{self, RenderedMarkdown};
use crate::state::{AppState, DocId};

/// Markdown is rendered in one shot, so the whole source has to be a `String`.
/// Past this size it is not a document any more and the raw view handles it.
const MAX_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;

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
