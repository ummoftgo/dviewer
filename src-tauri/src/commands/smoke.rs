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
    // `ok` is folded into the line rather than kept beside it. Whoever reads
    // this file later has only the file, and a result that does not say whether
    // it passed makes them reconstruct the verdict from the fields — which is
    // exactly the kind of guessing that reads a banner as a failure.
    let mut line = result;
    if let Some(object) = line.as_object_mut() {
        object.insert("ok".into(), ok.into());
    }
    run.record(&line, ok);
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
