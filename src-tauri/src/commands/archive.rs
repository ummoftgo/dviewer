//! Listing what an archive holds, so one of them can be picked.

use std::sync::Arc;

use tauri::State;

use crate::archive::{ArchiveDoc, ArchiveListing};
use crate::error::{Error, Result, Subject};
use crate::state::{AppState, DocId, DocKind};

/// Everything in the archive, read from its central directory.
///
/// Opened on the first ask rather than when the document is, for the reason the
/// database connection is: a tab that is created and never looked at should not
/// have paid for a file it was not asked to read.
#[tauri::command]
pub async fn archive_entries(
    state: State<'_, AppState>,
    doc_id: DocId,
) -> Result<ArchiveListing> {
    let doc = state.get(doc_id)?;
    if doc.kind() != DocKind::Zip {
        return Err(Error::WrongView {
            subject: Subject::Archive,
        });
    }
    if let Some(archive) = doc.archive() {
        return Ok(archive.listing().clone());
    }

    // The central directory is at the end of the file, but what each entry
    // weighs and whether it is locked is beside its data — so building the list
    // touches a header per entry. For a hundred thousand of them that is a
    // tenth of a second, which is long enough to be felt if the UI thread spent
    // it. A cold file makes it disk-bound on top of that.
    let bytes = Arc::clone(&doc.source_bytes);
    let archive = tauri::async_runtime::spawn_blocking(move || ArchiveDoc::open(bytes))
        .await
        .map_err(Error::internal)??;

    let archive = Arc::new(archive);
    let listing = archive.listing().clone();
    doc.set_archive(archive);
    Ok(listing)
}
