use std::sync::atomic::Ordering;
use tauri::State;
use crate::error::{Error, Result};
use crate::lines::LinePage;
use crate::state::{AppState, DocId};

#[tauri::command]
pub async fn doc_lines(state: State<'_, AppState>, doc_id: DocId, start: u32, count: u32) -> Result<LinePage> {
    let doc = state.get(doc_id)?;
    let generation = doc.generation();
    let cancel = doc.line_token();
    tauri::async_runtime::spawn_blocking(move || {
        let lines = doc.line_index(generation, &cancel)?;
        let stop = || cancel.load(Ordering::Relaxed) || doc.generation() != generation;
        let page = lines.page(start, count, &stop)?;
        if stop() { return Err(Error::Cancelled); }
        Ok(page)
    }).await.map_err(Error::internal)?
}

#[tauri::command]
pub async fn doc_lines_find(state: State<'_, AppState>, doc_id: DocId, query: String, from: u32, backward: bool) -> Result<Option<u32>> {
    let doc = state.get(doc_id)?;
    let generation = doc.generation();
    let cancel = state.start_search_job(doc_id);
    tauri::async_runtime::spawn_blocking(move || {
        let lines = doc.line_index(generation, &cancel)?;
        let stop = || cancel.load(Ordering::Relaxed) || doc.generation() != generation;
        let found = lines.find(&query, from, backward, &stop)?;
        if stop() { return Err(Error::Cancelled); }
        Ok(found)
    }).await.map_err(Error::internal)?
}
