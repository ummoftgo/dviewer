use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Window};

use crate::encoding;
use crate::error::{Error, Result};
use crate::filewatch::{normalize, FileWatch};
use crate::source;
use crate::state::{AppState, DocId, DocMeta, DocSource, Document};

#[derive(Clone, Serialize)]
struct Changed {
    id: DocId,
}

#[tauri::command]
pub fn watch_doc(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    doc_id: DocId,
) -> Result<()> {
    if !state.docs_owned_by(window.label()).contains(&doc_id) {
        return Err(Error::NoSuchDoc { id: doc_id });
    }
    let doc = state.get(doc_id)?;
    let DocSource::File { path } = &doc.source else {
        return Ok(());
    };
    if Path::new(path).extension().is_some_and(|ext| {
        ext.to_str()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gz"))
    }) {
        return Ok(());
    }
    // Gzip may be identified by its bytes even without a .gz suffix.
    use std::io::Read;
    let mut header = [0; 2];
    let mut file = std::fs::File::open(path)?;
    if file.read(&mut header)? == 2 && header == [0x1f, 0x8b] {
        return Ok(());
    }
    let path = normalize(Path::new(path))?;
    let mut watcher = state.watcher.lock();
    if !state.docs_owned_by(window.label()).contains(&doc_id) {
        return Err(Error::NoSuchDoc { id: doc_id });
    }
    if watcher.is_none() {
        *watcher = Some(
            FileWatch::new(move |id, label| {
                let _ = app.emit_to(label, "doc:changed", Changed { id });
            })
            .map_err(Error::internal)?,
        );
    }
    watcher
        .as_mut()
        .unwrap()
        .register(doc_id, path, window.label().to_owned())
        .map_err(Error::internal)
}

#[tauri::command]
pub fn unwatch_doc(window: Window, state: State<'_, AppState>, doc_id: DocId) {
    if state.docs_owned_by(window.label()).contains(&doc_id) {
        state.unwatch(doc_id);
    }
}

pub(crate) fn reload_document(doc: &Document) -> Result<DocMeta> {
    let DocSource::File { path } = &doc.source else {
        return Err(Error::NotInterchangeable);
    };
    if Path::new(path).extension().is_some_and(|ext| {
        ext.to_str()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gz"))
    }) {
        return Err(Error::NotInterchangeable);
    }
    let snapshot = doc.snapshot();
    let (bytes, title, _) = source::load_file(Path::new(path))?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Err(Error::NotInterchangeable);
    }
    let bytes = Arc::new(bytes);
    let kind = source::detect_kind(&title, &bytes);
    let decoded = if !kind.reads_bytes() {
        encoding::verbatim(bytes.clone())
    } else if let Some(encoding) = snapshot.chosen_encoding {
        encoding::decode_as(bytes.clone(), encoding)
    } else {
        encoding::decode(bytes.clone())
    };
    doc.replace_source(snapshot.generation, bytes, kind, decoded)?;
    Ok(doc.meta())
}

#[tauri::command]
pub async fn reload_doc(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    doc_id: DocId,
) -> Result<DocMeta> {
    if !state.docs_owned_by(window.label()).contains(&doc_id) {
        return Err(Error::NoSuchDoc { id: doc_id });
    }
    let doc = state.get(doc_id)?;
    state.cancel_jobs(doc_id);
    let reloading = doc.clone();
    let meta = tauri::async_runtime::spawn_blocking(move || reload_document(&reloading))
        .await
        .map_err(Error::internal)??;
    // An old view can start another job while the replacement is being mapped.
    state.cancel_jobs(doc_id);
    super::grant_assets(&app, &state, &doc);
    crate::window::close_all(&app, &state.panels_showing(doc_id));
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::DocBytes;
    use crate::state::DocKind;

    #[test]
    fn completed_old_indexes_cannot_enter_a_reloaded_document() {
        use crate::table::{Records, TableDoc};
        use crate::tree::{index::Syntax, scanner::ScanLimits, TreeDoc};
        let old = Arc::new(DocBytes::Owned(b"{\"old\":1}".to_vec()));
        let doc = Document::new(
            1,
            "document".into(),
            DocSource::Text,
            None,
            DocKind::Json,
            old.clone(),
            encoding::decode(old.clone()),
        );
        let snapshot = doc.snapshot();
        let tree = Arc::new(
            TreeDoc::build(
                old.clone(),
                Syntax::Json,
                &ScanLimits::default(),
                |_| {},
                &|| false,
            )
            .unwrap(),
        );
        let table = Arc::new(TableDoc::build(old, Records::Lines, |_| {}, &|| false).unwrap());
        doc.set_tree(snapshot.generation, tree.clone()).unwrap();
        let new = Arc::new(DocBytes::Owned(b"new\n".to_vec()));
        doc.replace_source(
            snapshot.generation,
            new.clone(),
            DocKind::Text,
            encoding::decode(new),
        )
        .unwrap();
        assert!(matches!(
            doc.set_tree(snapshot.generation, tree),
            Err(Error::Cancelled)
        ));
        assert!(matches!(
            doc.set_table(snapshot.generation, table),
            Err(Error::Cancelled)
        ));
        assert!(matches!(
            doc.clear_order_at(snapshot.generation),
            Err(Error::Cancelled)
        ));
        assert!(doc.tree().is_none() && doc.table().is_none());
        assert_eq!(&**snapshot.bytes, b"{\"old\":1}");
        assert_eq!(&**doc.source_bytes(), b"new\n");
    }

    #[test]
    fn reload_redetects_content_increments_generation_and_keeps_chosen_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.data");
        std::fs::write(&path, b"{}").unwrap();
        let bytes = Arc::new(DocBytes::map_file(&path).unwrap());
        let doc = Document::new(
            1,
            "document.data".into(),
            DocSource::File {
                path: path.to_string_lossy().into_owned(),
            },
            Some(dir.path().to_owned()),
            DocKind::Json,
            bytes.clone(),
            encoding::decode(bytes),
        );
        doc.set_encoding(encoding_rs::UTF_8);
        let before = doc.generation();
        let replacement = dir.path().join("replacement");
        std::fs::write(&replacement, b"<root/>").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let meta = reload_document(&doc).unwrap();
        assert_eq!(meta.generation, before + 1);
        assert_eq!(meta.kind, DocKind::Xml);
        assert_eq!(meta.encoding.source, encoding::EncodingSource::Chosen);
        assert_eq!(&**doc.bytes(), b"<root/>");
    }
}
