//! What the self-check asks of the backend.
//!
//! Three calls: what to open, how one went, and that there is no more. The
//! frontend does the opening through the ordinary workspace — that is the point
//! of the harness, so none of it is reimplemented here.

use tauri::{Manager, State};

use crate::smoke::{SmokeRun, Step};

/// The documents to open, in order. Empty when this process is listening.
#[tauri::command]
pub fn smoke_plan(run: State<'_, SmokeRun>) -> Vec<Step> {
    run.plan().to_vec()
}

/// Record how one document went.
///
/// The result is whatever the frontend saw, verbatim — `ok` decides the exit
/// code and the rest is for whoever reads the file. Taking it as free-shaped
/// JSON keeps the two ends from having to agree on a schema that will change
/// every time a new kind of step is added.
#[tauri::command]
pub fn smoke_report(run: State<'_, SmokeRun>, result: serde_json::Value, ok: bool) {
    run.record(result, ok);
}

/// Write the summary and end the process.
///
/// The exit code is the verdict; the file says what it was about. Exiting from
/// here rather than letting the window close means the code survives — a window
/// closing normally exits zero however the run went.
#[tauri::command]
pub fn smoke_done(app: tauri::AppHandle, run: State<'_, SmokeRun>) {
    let code = run.finish();
    app.exit(code);
}

/// Close this window, and let its destruction end the run.
///
/// The `--new` check ends here rather than at `smoke_done`, and the difference
/// is the point: `smoke_done` exits while the window is still standing, so the
/// path a closing window takes — its documents being reclaimed — never runs.
/// Closing first and finishing from the destroy handler makes that path part
/// of the check.
#[tauri::command]
pub fn smoke_close_self(window: tauri::Window, run: State<'_, SmokeRun>) {
    // Written before the close, not after: the destroy handler reads it, and
    // on some platforms the window is gone before this function returns.
    run.finish_when_gone(window.label());
    let _ = window.close();
}

/// Whether this process is running a self-check, and which window is asking.
///
/// A command rather than a window property because the frontend already asks
/// the backend what to do on startup, and one more question there is cheaper
/// than a second channel.
///
/// The label is what makes the `--new` half of the round trip observable. A
/// second `dviewer --new` is answered by building a window in *this* process,
/// and the only thing that can say a window was really built is that window's
/// own frontend mounting and asking this.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeStatus {
    pub active: bool,
    pub window: String,
}

#[tauri::command]
pub fn smoke_status(app: tauri::AppHandle, window: tauri::Window) -> SmokeStatus {
    SmokeStatus {
        active: app.try_state::<SmokeRun>().is_some(),
        window: window.label().to_owned(),
    }
}
