use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::bytes::DocBytes;
use crate::encoding::{self, DecodeWarning, Decoded, EncodingSource};
use crate::error::{Error, Result};
use crate::tree::TreeDoc;
use crate::table::TableDoc;

pub type DocId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    Markdown,
    Json,
    Yaml,
    Toml,
    Xml,
    Csv,
    Tsv,
}

/// How a document is presented. Seven formats, but only three ways to read
/// one — which is what the frontend routes on, and what stops the view layer
/// from growing a branch per format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocView {
    /// Rendered or raw text.
    Prose,
    /// The collapsible node tree.
    Tree,
    /// The row-and-column grid.
    Table,
}

impl DocKind {
    pub fn view(self) -> DocView {
        match self {
            DocKind::Markdown => DocView::Prose,
            DocKind::Json | DocKind::Yaml | DocKind::Toml | DocKind::Xml => DocView::Tree,
            DocKind::Csv | DocKind::Tsv => DocView::Table,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocSource {
    File { path: String },
    Url { url: String },
    Text,
}

/// The encoding a document is being read as, and how confident that is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInfo {
    /// Canonical name, which is also what the picker sends back.
    pub name: String,
    pub label: String,
    pub source: EncodingSource,
    /// Shown beside the picker when something did not decode cleanly.
    pub warning: Option<DecodeWarning>,
}

/// What the frontend needs to render a tab. Deliberately small — the document
/// body never crosses the IPC boundary as a whole.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub id: DocId,
    pub title: String,
    pub kind: DocKind,
    pub view: DocView,
    pub source: DocSource,
    /// Size on disk, not after decoding — it is the file the reader recognises.
    pub byte_len: usize,
    pub encoding: EncodingInfo,
    /// Directory that relative image paths resolve against (file sources only).
    pub base_dir: Option<String>,
}

pub struct Document {
    pub id: DocId,
    pub title: String,
    pub source: DocSource,
    pub base_dir: Option<PathBuf>,
    /// The file exactly as it is on disk. Kept so another encoding can be
    /// applied later without going back to the disk — and because for a UTF-8
    /// document this is the same allocation the rest of the app reads.
    pub source_bytes: Arc<DocBytes>,
    inner: RwLock<DocInner>,
}

struct DocInner {
    kind: DocKind,
    /// UTF-8, which is what every scanner assumes. Shares its allocation with
    /// `source_bytes` unless the file had to be transcoded.
    bytes: Arc<DocBytes>,
    encoding: &'static encoding_rs::Encoding,
    encoding_source: EncodingSource,
    encoding_warning: Option<DecodeWarning>,
    /// Built lazily and in the background; None until indexing completes.
    /// Only one of the two is ever populated — a document is a tree or a grid,
    /// never both.
    tree: Option<Arc<TreeDoc>>,
    table: Option<Arc<TableDoc>>,
}

impl Document {
    pub fn new(
        id: DocId,
        title: String,
        source: DocSource,
        base_dir: Option<PathBuf>,
        kind: DocKind,
        source_bytes: Arc<DocBytes>,
        decoded: Decoded,
    ) -> Self {
        Self {
            id,
            title,
            source,
            base_dir,
            source_bytes,
            inner: RwLock::new(DocInner {
                kind,
                bytes: decoded.bytes,
                encoding: decoded.encoding,
                encoding_source: decoded.source,
                encoding_warning: decoded.warning,
                tree: None,
                table: None,
            }),
        }
    }

    /// The document's bytes, in UTF-8.
    pub fn bytes(&self) -> Arc<DocBytes> {
        Arc::clone(&self.inner.read().bytes)
    }

    /// Re-read the file as `encoding`. Everything derived from the old reading
    /// is dropped: the byte offsets an index is built from do not survive a
    /// change of encoding.
    pub fn set_encoding(&self, encoding: &'static encoding_rs::Encoding) {
        let decoded = encoding::decode_as(Arc::clone(&self.source_bytes), encoding);
        let mut inner = self.inner.write();
        inner.bytes = decoded.bytes;
        inner.encoding = decoded.encoding;
        inner.encoding_source = decoded.source;
        inner.encoding_warning = decoded.warning;
        inner.tree = None;
        inner.table = None;
    }

    pub fn kind(&self) -> DocKind {
        self.inner.read().kind
    }

    /// Switching the kind drops whatever was built for the old one — an index
    /// is meaningless, and often large, once the document is being read as
    /// something else.
    pub fn set_kind(&self, kind: DocKind) {
        let mut inner = self.inner.write();
        if inner.kind != kind {
            inner.kind = kind;
            inner.tree = None;
            inner.table = None;
        }
    }

    pub fn tree(&self) -> Option<Arc<TreeDoc>> {
        self.inner.read().tree.clone()
    }

    pub fn set_tree(&self, tree: Arc<TreeDoc>) {
        self.inner.write().tree = Some(tree);
    }

    pub fn table(&self) -> Option<Arc<TableDoc>> {
        self.inner.read().table.clone()
    }

    pub fn set_table(&self, table: Arc<TableDoc>) {
        self.inner.write().table = Some(table);
    }

    pub fn meta(&self) -> DocMeta {
        let inner = self.inner.read();
        DocMeta {
            id: self.id,
            title: self.title.clone(),
            kind: inner.kind,
            view: inner.kind.view(),
            source: self.source.clone(),
            byte_len: self.source_bytes.len(),
            encoding: EncodingInfo {
                name: inner.encoding.name().to_owned(),
                label: encoding::label(inner.encoding),
                source: inner.encoding_source,
                warning: inner.encoding_warning.clone(),
            },
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
        self.docs.read().get(&id).cloned().ok_or(Error::NoSuchDoc { id })
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
