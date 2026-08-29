//! Detaching the key/value table into a window of its own.

use tauri::{AppHandle, State, Window};

use crate::error::{Error, Result};
use crate::state::{AppState, DocId};
use crate::window;

/// Open a window showing one node's key/value table.
///
/// The title carries the node's path and the document it came from, because
/// that is all a reader has to tell two of these apart on a taskbar.
///
/// `async` is load-bearing, not decoration. A plain command runs on the thread
/// that drives the event loop, and building a window there waits forever for a
/// loop that cannot run: the frame appears, the webview never attaches, and the
/// window is left blank and deaf to its own close button. An async command runs
/// off that thread, so the loop is free to finish the job.
#[tauri::command]
pub async fn open_panel(
    app: AppHandle,
    opener: Window,
    state: State<'_, AppState>,
    doc_id: DocId,
    node_id: u32,
) -> Result<()> {
    let doc = state.get(doc_id)?;
    let tree = doc.tree().ok_or(Error::NotReady {
        subject: crate::error::Subject::Tree,
    })?;
    let path = tree.path_of(node_id).ok_or(Error::NoSuchNode)?;
    let title = format!("{path} — {}", doc.title);

    window::open_panel(&app, opener.label(), doc_id, node_id, &title)
        .map_err(|e| Error::internal(e))
}

/// The document a panel window is showing, for the title bar and for telling
/// the reader which file they are looking at.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelInfo {
    pub title: String,
    pub path: String,
}

#[tauri::command]
pub fn panel_info(state: State<'_, AppState>, doc_id: DocId, node_id: u32) -> Result<PanelInfo> {
    let doc = state.get(doc_id)?;
    let tree = doc.tree().ok_or(Error::NotReady {
        subject: crate::error::Subject::Tree,
    })?;
    Ok(PanelInfo {
        title: doc.title.clone(),
        path: tree.path_of(node_id).ok_or(Error::NoSuchNode)?,
    })
}
