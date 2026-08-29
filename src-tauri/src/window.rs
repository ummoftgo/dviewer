//! Where a launch request ends up: a tab in the window already open, or a
//! window of its own.
//!
//! A second `dviewer` never gets to draw anything — the single-instance plugin
//! hands its arguments to the process that is already running and exits. So
//! everything here happens in the first process, on behalf of a second one that
//! is already gone.
//!
//! Windows share one `AppState`, which is what makes a document opened in one
//! window cost nothing in the other: the index lives in Rust and only the rows
//! on screen cross the boundary. Events are broadcast to every window; each
//! frontend routes by document id and ignores ids it does not have.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::cli::LaunchRequest;
use crate::state::AppState;

/// Event carrying a request to a window that already exists.
pub const OPEN_REQUEST: &str = "open-request";

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// A new window is offset from the one it came from, because two windows drawn
/// at exactly the same place look like one window that failed to open.
const CASCADE: f64 = 32.0;

/// Hand `request` to the window the reader is looking at, and raise it.
pub fn deliver(app: &AppHandle, request: LaunchRequest) {
    let Some(window) = focused(app) else {
        // No window at all is not a state this app reaches, but queuing the
        // request costs nothing and losing it would be silent.
        app.state::<AppState>().queue("main", request);
        return;
    };
    let _ = window.set_focus();
    let _ = window.unminimize();
    let _ = app.emit_to(window.label(), OPEN_REQUEST, request);
}

/// Open a window of its own for `request`.
pub fn open(app: &AppHandle, request: LaunchRequest) -> tauri::Result<()> {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));

    // Queued before the window is built: the frontend asks for its request as
    // soon as it mounts, and the window may well be up by then.
    app.state::<AppState>().queue(&label, request);

    let source = focused(app);
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("dviewer")
        .min_inner_size(640.0, 420.0);

    if let Some(source) = &source {
        if let (Ok(size), Ok(position), Ok(scale)) = (
            source.inner_size(),
            source.outer_position(),
            source.scale_factor(),
        ) {
            builder = builder
                .inner_size(size.width as f64 / scale, size.height as f64 / scale)
                .position(
                    position.x as f64 / scale + CASCADE,
                    position.y as f64 / scale + CASCADE,
                );
        }
    } else {
        builder = builder.inner_size(1180.0, 800.0);
    }

    builder.build()?;
    Ok(())
}

/// The window a request should go to: the focused one, else the main one, else
/// whichever exists.
fn focused(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned()
}
