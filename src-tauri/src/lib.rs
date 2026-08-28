// Public so `examples/scan.rs` can drive the indexer directly — measuring the
// scanner without a window is the only honest way to check the size claims.
pub mod bytes;
pub mod error;
pub mod fonts;
pub mod highlight;
pub mod json;
pub mod markdown;

mod commands;
mod source;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_path,
            commands::open_url,
            commands::open_text,
            commands::close_doc,
            commands::set_doc_kind,
            commands::startup_paths,
            commands::doc_source_text,
            commands::render_markdown,
            commands::highlight_css,
            commands::system_fonts,
            commands::json_open,
            commands::json_rows,
            commands::json_toggle,
            commands::json_set_collapsed,
            commands::json_expand_all,
            commands::json_collapse_all,
            commands::json_set_expand_depth,
            commands::json_children,
            commands::json_reveal,
            commands::json_path,
            commands::json_node_text,
            commands::json_search,
            commands::json_search_cancel,
            commands::json_filter_matches,
            commands::json_clear_filter,
            commands::json_clear_search,
            commands::json_hit_row,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
