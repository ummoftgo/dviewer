// Public so `examples/scan.rs` can drive the indexer directly — measuring the
// scanner without a window is the only honest way to check the size claims.
pub mod archive;
pub mod bytes;
pub mod cli;
pub mod convert;
pub mod encoding;
pub mod error;
pub mod fonts;
pub mod highlight;
pub mod grid;
pub mod jsonl;
pub mod log;
pub mod parquet;
pub mod query;
pub mod sqlite;
pub mod tree;
pub mod markdown;
pub mod table;
pub mod xlsx;
pub mod xml;

mod commands;
#[cfg(test)]
mod testing;
mod window;

// Public for the same reason as the modules above: `examples/table.rs` decides
// how to read a file exactly as the app does, and that decision lives here.
pub mod smoke;
pub mod source;
pub mod state;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch = cli::parse(&args);

    // Two plugins are handled specially for a self-check, and both would be
    // found the hard way.
    //
    // `window-state` saves the window geometry on exit, so any smoke run would
    // overwrite where the reader keeps their window. It is left out of both.
    //
    // `single-instance` is the interesting one, because the two smoke modes
    // want opposite things from it. A sweep must *not* have it: with dviewer
    // already open, the run would hand its arguments to that window, exit, and
    // leave the reader's app opening fixtures. The listening half must *have*
    // it — being the single instance is the entire thing it is checking.
    //
    // The decision is made from the parse above, not from a second reading of
    // the arguments — one parser, or the two drift.
    let smoke = launch.smoke.clone();
    let sweeping = matches!(
        smoke.as_ref().map(|s| &s.mode),
        Some(crate::cli::SmokeMode::Run { .. })
    );
    let mut builder = tauri::Builder::default();

    if !sweeping {
        builder = builder
            // First, as the plugin requires: a second `dviewer` must hand over
            // its arguments and exit before anything else in it starts up.
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                let launch = cli::parse(argv.get(1..).unwrap_or_default());
                if launch.new_window {
                    // Off the event-loop thread, for the same reason
                    // `open_panel` is async: building a window here would wait
                    // on the very loop this callback is running inside. The
                    // frame appears, the webview never attaches, and the second
                    // `dviewer` never gets its answer either — so it does not
                    // exit.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = window::open(&app, launch.request);
                    });
                } else {
                    window::deliver(app, launch.request);
                }
            }));
    }

    if smoke.is_none() {
        // Restores size, position and maximised state, and saves them on exit.
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            // A panel outlives neither its opener nor its document. Without
            // this, closing the main window would leave the app running with
            // only detached panels and no way back to the tree.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                let orphans = state.panels_opened_by(window.label());
                state.forget_panel(window.label());
                window::close_all(&window.app_handle().clone(), &orphans);

                // The frontend is what normally closes a document, and a window
                // that is gone never gets to. Its documents would otherwise
                // hold their mmap and index until the app exits.
                for doc in state.docs_owned_by(window.label()) {
                    state.cancel_jobs(doc);
                    state.remove(doc);
                }
            }
        })
        .setup(move |app| {
            if let Some(smoke) = &smoke {
                // A harness that cannot write its results has nothing to say,
                // and saying it by opening a window would be worse than not
                // starting: the runner outside would wait for a file that is
                // never coming.
                match smoke::SmokeRun::start(smoke) {
                    Ok(run) => {
                        app.manage(run);
                    }
                    Err(why) => {
                        eprintln!("smoke: {why}");
                        app.handle().exit(smoke::BROKEN);
                    }
                }
                return Ok(());
            }
            // The window from tauri.conf.json is called "main"; it collects
            // this the moment its frontend mounts.
            app.state::<AppState>().queue("main", launch.request.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_path,
            commands::open_url,
            commands::open_text,
            commands::close_doc,
            commands::set_doc_kind,
            commands::set_doc_encoding,
            commands::encoding_choices,
            commands::startup_request,
            commands::open_panel,
            commands::panel_info,
            commands::doc_source_text,
            commands::render_markdown,
            commands::highlight_css,
            commands::system_fonts,
            commands::tree_open,
            commands::tree_rows,
            commands::tree_toggle,
            commands::tree_expand_all,
            commands::tree_collapse_all,
            commands::tree_set_expand_depth,
            commands::tree_children,
            commands::tree_reveal,
            commands::tree_row_of,
            commands::tree_path,
            commands::tree_node_text,
            commands::tree_search,
            commands::tree_search_cancel,
            commands::tree_filter_matches,
            commands::tree_clear_filter,
            commands::tree_clear_search,
            commands::tree_hit_row,
            commands::table_open,
            commands::grid_rows,
            commands::table_set_has_header,
            commands::table_set_plain,
            commands::table_set_expand,
            commands::sqlite_collections,
            commands::sqlite_select,
            commands::xlsx_sheets,
            commands::xlsx_select,
            commands::xlsx_set_formulas,
            commands::parquet_open,
            commands::parquet_select,
            commands::parquet_schema,
            commands::sqlite_schema,
            commands::grid_cell_text,
            commands::grid_row_text,
            commands::grid_search,
            commands::archive_entries,
            commands::open_entry,
            commands::smoke_status,
            commands::smoke_plan,
            commands::smoke_report,
            commands::smoke_done,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
