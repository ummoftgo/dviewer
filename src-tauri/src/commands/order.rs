use std::sync::Arc;
use serde::Serialize;
use tauri::{Emitter, State};
use crate::error::{Error, Result, Subject};
use crate::state::{AppState, DocId};
use crate::grid::order::{Order, OrderStats, Sort};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { doc_id: DocId, request: u32, done: u32, total: u32 }

#[tauri::command]
pub async fn grid_order(app: tauri::AppHandle, state: State<'_, AppState>, doc_id: DocId,
    sort: Option<Sort>, filter: Option<String>, request: u32) -> Result<OrderStats> {
    let doc = state.get(doc_id)?;
    let grid = doc.grid().ok_or(Error::NotReady { subject: Subject::Table })?;
    let (generation, cancel) = doc.start_order();
    let filter = filter.unwrap_or_default();
    if sort.is_none() && filter.is_empty() {
        doc.finish_order(generation, None)?;
        return Ok(OrderStats { shown: grid.row_count(), total: grid.row_count(), index_bytes: 0, peak_bytes: 0 });
    }
    let built = tauri::async_runtime::spawn_blocking(move || {
        Order::build(grid.as_ref(), sort, &filter, &cancel, &mut |done, total| {
            let _ = app.emit("grid:progress", Progress { doc_id, request, done, total });
        })
    }).await.map_err(Error::internal)??;
    let stats = built.stats();
    doc.finish_order(generation, Some(Arc::new(built)))?;
    Ok(stats)
}

#[tauri::command]
pub fn grid_order_cancel(state: State<'_, AppState>, doc_id: DocId) -> Result<()> {
    state.get(doc_id)?.start_order();
    Ok(())
}

#[tauri::command]
pub fn grid_order_stats(state: State<'_, AppState>, doc_id: DocId) -> Result<Option<OrderStats>> {
    Ok(state.get(doc_id)?.order().map(|o| o.stats()))
}
