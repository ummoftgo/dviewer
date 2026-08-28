use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::bytes::DocBytes;
use crate::error::{Error, Result};
use crate::json::JsonDoc;

pub type DocId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    Markdown,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocSource {
    File { path: String },
    Url { url: String },
    Text,
}

/// What the frontend needs to render a tab. Deliberately small — the document
/// body never crosses the IPC boundary as a whole.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: DocId,
    pub title: String,
    pub kind: DocKind,
    pub source: DocSource,
    pub byte_len: usize,
    /// Directory that relative image paths resolve against (file sources only).
    pub base_dir: Option<String>,
}

pub struct Document {
    pub id: DocId,
    pub title: String,
    pub source: DocSource,
    pub base_dir: Option<PathBuf>,
    pub bytes: Arc<DocBytes>,
    inner: RwLock<DocInner>,
}

struct DocInner {
    kind: DocKind,
    /// Built lazily and in the background; None until indexing completes.
    json: Option<Arc<JsonDoc>>,
}

impl Document {
    pub fn new(
        id: DocId,
        title: String,
        source: DocSource,
        base_dir: Option<PathBuf>,
        kind: DocKind,
        bytes: DocBytes,
    ) -> Self {
        Self {
            id,
            title,
            source,
            base_dir,
            bytes: Arc::new(bytes),
            inner: RwLock::new(DocInner { kind, json: None }),
        }
    }

    pub fn kind(&self) -> DocKind {
        self.inner.read().kind
    }

    /// Switching the kind drops any JSON index — it is meaningless (and large)
    /// once the document is being read as markdown.
    pub fn set_kind(&self, kind: DocKind) {
        let mut inner = self.inner.write();
        if inner.kind != kind {
            inner.kind = kind;
            inner.json = None;
        }
    }

    pub fn json(&self) -> Option<Arc<JsonDoc>> {
        self.inner.read().json.clone()
    }

    pub fn set_json(&self, json: Arc<JsonDoc>) {
        self.inner.write().json = Some(json);
    }

    pub fn meta(&self) -> DocMeta {
        DocMeta {
            id: self.id,
            title: self.title.clone(),
            kind: self.kind(),
            source: self.source.clone(),
            byte_len: self.bytes.len(),
            base_dir: self.base_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// Cancellation flags for the background jobs a document can have in flight.
/// Both are per-document and single-slot: starting a new one supersedes the
/// old, and closing the tab cancels whatever is running.
#[derive(Default)]
struct Jobs {
    index: HashMap<DocId, Arc<AtomicBool>>,
    search: HashMap<DocId, Arc<AtomicBool>>,
}

#[derive(Default)]
pub struct AppState {
    next_id: AtomicU32,
    docs: RwLock<HashMap<DocId, Arc<Document>>>,
    jobs: RwLock<Jobs>,
}

impl AppState {
    pub fn next_id(&self) -> DocId {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn insert(&self, doc: Document) -> Arc<Document> {
        let doc = Arc::new(doc);
        self.docs.write().insert(doc.id, Arc::clone(&doc));
        doc
    }

    pub fn get(&self, id: DocId) -> Result<Arc<Document>> {
        self.docs.read().get(&id).cloned().ok_or(Error::NoSuchDoc(id))
    }

    /// Dropping the Arc releases the mmap and the JSON index immediately,
    /// provided no background job still holds a clone.
    pub fn remove(&self, id: DocId) {
        self.docs.write().remove(&id);
    }

    pub fn start_index_job(&self, id: DocId) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut jobs = self.jobs.write();
        if let Some(previous) = jobs.index.insert(id, Arc::clone(&flag)) {
            previous.store(true, Ordering::Relaxed);
        }
        flag
    }

    pub fn start_search_job(&self, id: DocId) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut jobs = self.jobs.write();
        if let Some(previous) = jobs.search.insert(id, Arc::clone(&flag)) {
            previous.store(true, Ordering::Relaxed);
        }
        flag
    }

    pub fn cancel_search_job(&self, id: DocId) {
        if let Some(flag) = self.jobs.write().search.remove(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_jobs(&self, id: DocId) {
        let mut jobs = self.jobs.write();
        for flag in [jobs.index.remove(&id), jobs.search.remove(&id)]
            .into_iter()
            .flatten()
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
