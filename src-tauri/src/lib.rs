// Public so `examples/scan.rs` can drive the indexer directly — measuring the
// scanner without a window is the only honest way to check the size claims.
pub mod bytes;
pub mod cli;
pub mod convert;
pub mod encoding;
pub mod error;
pub mod fonts;
pub mod highlight;
pub mod tree;
pub mod markdown;
pub mod table;
pub mod xml;

mod commands;
mod window;

// Public for the same reason as the modules above: `examples/table.rs` decides
// how to read a file exactly as the app does, and that decision lives here.
pub mod source;
pub mod state;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, as the plugin requires: a second `dviewer` must hand over its
        // arguments and exit before anything else in it starts up.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let launch = cli::parse(argv.get(1..).unwrap_or_default());
            if launch.new_window {
                // Off the event-loop thread, for the same reason `open_panel`
                // is async: building a window here would wait on the very loop
                // this callback is running inside. The frame appears, the
                // webview never attaches, and the second `dviewer` never gets
                // its answer either — so it does not exit.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = window::open(&app, launch.request);
                });
            } else {
                window::deliver(app, launch.request);
            }
        }))
        // Restores size, position and maximised state, and saves them on exit.
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
        .setup(|app| {
            // The window from tauri.conf.json is called "main"; it collects
            // this the moment its frontend mounts.
            let args: Vec<String> = std::env::args().skip(1).collect();
            app.state::<AppState>()
                .queue("main", cli::parse(&args).request);
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
            commands::table_rows,
            commands::table_set_has_header,
            commands::table_cell_text,
            commands::table_row_text,
            commands::table_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
