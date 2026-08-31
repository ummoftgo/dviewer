use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::bytes::DocBytes;
use crate::cli::LaunchRequest;
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
    /// One JSON object per line, read as a table. A kind of its own rather
    /// than a view of `Json`, because it is a different reading of the bytes:
    /// records are lines here, and the tree makes them a synthetic array. The
    /// format switch is what moves between the two.
    Jsonl,
    /// JSON with comments and trailing commas. A separate kind rather than a
    /// flag on `Json`, so that `.json` keeps refusing what `.json` may not
    /// contain — a viewer that quietly accepts a malformed file teaches its
    /// reader that the file was fine.
    Jsonc,
    Yaml,
    Toml,
    Xml,
    Csv,
    Tsv,
    /// Plain text and logs: one line, one row, no header.
    Text,
    /// A SQLite database. The first format that is not text at all.
    Sqlite,
    /// A spreadsheet. Not a run of bytes either, but for the other reason: a
    /// library turns it into values in memory rather than the reader querying
    /// a file. What it shares with a database is the shape — several
    /// collections, one on screen.
    Xlsx,
    /// A columnar file. Not a run of bytes for a third reason: it is written in
    /// row groups with an index at the end, so it is read a group at a time and
    /// never as a whole.
    Parquet,
    /// A zip archive. Not one more format so much as the other thirteen
    /// multiplied: what it holds is documents, and picking one opens it the
    /// way a file from disk is opened.
    Zip,
}

/// How a document is presented. Fourteen formats, but only five ways to read
/// one — which is what the frontend routes on, and what stops the view layer
/// from growing a branch per format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocView {
    /// Rendered or raw text.
    Prose,
    /// The collapsible node tree.
    Tree,
    /// The row-and-column grid, read out of the document's own bytes.
    Table,
    /// The same grid, over one of the several collections a file holds.
    ///
    /// A view of its own and not a kind of `Table`, because the two share only
    /// their appearance: nothing that makes a table — the record index, the
    /// byte search, the original text — exists here, and a command that
    /// accepted both would have to say so in every line of its body.
    ///
    /// Named for what the reader does rather than for what the file is: pick a
    /// collection, read it in the grid. A database's tables and a workbook's
    /// sheets are the same choice.
    Collection,
    /// The list of what an archive holds, so one of them can be opened.
    ///
    /// The only view that does not end on screen: the four above are ways of
    /// looking at one document, and this one is a way of reaching another. The
    /// collection view was the near miss — it also picks — but what it picks is
    /// always the same grid, and an archive entry is any of the thirteen.
    Archive,
}

impl DocKind {
    /// Whether this document is a run of bytes someone could read.
    ///
    /// Everything the byte pipeline does — detecting an encoding, offering
    /// another one, offering to read the same bytes as a different format —
    /// assumes it is. A database is queried and a workbook is converted, so for
    /// those the whole pipeline is not wrong so much as inapplicable, and a
    /// control that acts on it would have nothing to act on.
    pub fn reads_bytes(self) -> bool {
        !matches!(
            self,
            DocKind::Sqlite | DocKind::Xlsx | DocKind::Parquet | DocKind::Zip
        )
    }

    /// Whether reading this needs a file on disk rather than a buffer.
    ///
    /// Three of the four formats that are not runs of bytes are read through a
    /// library that opens a path: a database is queried, a workbook converted,
    /// a columnar file seeked. A download or an unpacked entry has no path to
    /// give them, and writing one to a temporary file would leave the reader
    /// with a copy they did not ask to keep, somewhere they did not choose.
    ///
    /// An archive is the one that is not, because its reader takes the bytes.
    /// So a zip can be opened from a URL, and out of another zip.
    pub fn needs_file(self) -> bool {
        matches!(self, DocKind::Sqlite | DocKind::Xlsx | DocKind::Parquet)
    }

    pub fn view(self) -> DocView {
        match self {
            DocKind::Markdown => DocView::Prose,
            DocKind::Json | DocKind::Jsonc | DocKind::Yaml | DocKind::Toml | DocKind::Xml => {
                DocView::Tree
            }
            DocKind::Csv | DocKind::Tsv | DocKind::Text | DocKind::Jsonl => DocView::Table,
            DocKind::Sqlite | DocKind::Xlsx | DocKind::Parquet => DocView::Collection,
            DocKind::Zip => DocView::Archive,
        }
    }
}

/// One step of the way into an archive: which entry, and what it was called.
///
/// The number is what identifies it. The name is carried for the tab's
/// subtitle, and is frozen at the moment the list was read — an archive that
/// is rewritten under an open tab does not rename what that tab is showing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRef {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocSource {
    File { path: String },
    Url { url: String },
    Text,
    /// A document taken out of an archive, named by the whole way in.
    ///
    /// Complete in itself, and deliberately so: there is no document id here.
    /// An entry outlives the archive tab it was opened from — the bytes were
    /// copied out, not borrowed — so a reference to that tab would be a
    /// reference to something that may not exist. Being a value also means two
    /// tabs showing the same entry can be recognised as such by comparing what
    /// they say, which is what stops a second click opening a second copy.
    ArchiveEntry {
        /// Where the outermost archive came from. A file or a URL — never
        /// another chain, which is what `entries` is for, and never pasted
        /// text, which is a string and was never an archive.
        root: Box<DocSource>,
        /// The way in, one archive per step. The last one is this document.
        entries: Vec<EntryRef>,
    },
}

impl DocSource {
    /// The chain naming an entry of the document this is the source of.
    pub fn entry(&self, index: u32, name: String) -> Result<DocSource> {
        let (root, mut entries) = match self {
            DocSource::File { .. } | DocSource::Url { .. } => {
                (Box::new(self.clone()), Vec::new())
            }
            DocSource::ArchiveEntry { root, entries } => (root.clone(), entries.clone()),
            // Pasted text arrives as a Rust String, so it is UTF-8 and was
            // never an archive. Reachable only if something upstream forgets.
            DocSource::Text => {
                return Err(Error::WrongView {
                    subject: crate::error::Subject::Archive,
                })
            }
        };
        entries.push(EntryRef { index, name });
        Ok(DocSource::ArchiveEntry { root, entries })
    }

    /// How many archives had to be opened to reach this document. Zero for
    /// anything that came from a file, a URL or the clipboard.
    pub fn depth(&self) -> usize {
        match self {
            DocSource::ArchiveEntry { entries, .. } => entries.len(),
            _ => 0,
        }
    }
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
    /// An open database, for the one format that is not bytes.
    database: Option<Arc<crate::sqlite::SqliteDoc>>,
    workbook: Option<Arc<crate::xlsx::XlsxDoc>>,
    columnar: Option<Arc<crate::parquet::ParquetDoc>>,
    sheet: Option<Arc<crate::xlsx::XlsxGrid>>,
    /// The collection whose rows are on screen. Replaced, not added to, when
    /// another is chosen: a checkpoint index describes one collection's rows
    /// and means nothing for the next.
    collection: Option<Arc<crate::sqlite::SqliteGrid>>,
    /// An open archive, held for the same reason the database connection is:
    /// reading the central directory again for every entry someone opens would
    /// re-parse a hundred thousand headers to answer one click.
    archive: Option<Arc<crate::archive::ArchiveDoc>>,
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
                database: None,
                collection: None,
                workbook: None,
                sheet: None,
                columnar: None,
                archive: None,
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

    pub fn database(&self) -> Option<Arc<crate::sqlite::SqliteDoc>> {
        self.inner.read().database.clone()
    }

    pub fn set_database(&self, database: Arc<crate::sqlite::SqliteDoc>) {
        self.inner.write().database = Some(database);
    }

    pub fn set_collection(&self, collection: Arc<crate::sqlite::SqliteGrid>) {
        self.inner.write().collection = Some(collection);
    }

    pub fn workbook(&self) -> Option<Arc<crate::xlsx::XlsxDoc>> {
        self.inner.read().workbook.clone()
    }

    pub fn set_workbook(&self, workbook: Arc<crate::xlsx::XlsxDoc>) {
        self.inner.write().workbook = Some(workbook);
    }

    pub fn set_sheet(&self, sheet: Arc<crate::xlsx::XlsxGrid>) {
        self.inner.write().sheet = Some(sheet);
    }

    pub fn sheet(&self) -> Option<Arc<crate::xlsx::XlsxGrid>> {
        self.inner.read().sheet.clone()
    }

    pub fn archive(&self) -> Option<Arc<crate::archive::ArchiveDoc>> {
        self.inner.read().archive.clone()
    }

    pub fn set_archive(&self, archive: Arc<crate::archive::ArchiveDoc>) {
        self.inner.write().archive = Some(archive);
    }

    pub fn columnar(&self) -> Option<Arc<crate::parquet::ParquetDoc>> {
        self.inner.read().columnar.clone()
    }

    pub fn set_columnar(&self, columnar: Arc<crate::parquet::ParquetDoc>) {
        self.inner.write().columnar = Some(columnar);
    }

    /// The rows and columns on screen, whichever kind of document made them.
    ///
    /// One or the other, never both: a document is a file of bytes with a
    /// record index or a database with a collection chosen.
    pub fn grid(&self) -> Option<Arc<dyn crate::grid::Grid>> {
        let inner = self.inner.read();
        if let Some(table) = &inner.table {
            return Some(Arc::clone(table) as Arc<dyn crate::grid::Grid>);
        }
        if let Some(collection) = &inner.collection {
            return Some(Arc::clone(collection) as Arc<dyn crate::grid::Grid>);
        }
        if let Some(sheet) = &inner.sheet {
            return Some(Arc::clone(sheet) as Arc<dyn crate::grid::Grid>);
        }
        inner
            .columnar
            .clone()
            .map(|columnar| columnar as Arc<dyn crate::grid::Grid>)
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

#[derive(Debug, Clone)]
struct PanelOwner {
    window: String,
    doc: DocId,
}

#[derive(Default)]
pub struct AppState {
    next_id: AtomicU32,
    docs: RwLock<HashMap<DocId, Arc<Document>>>,
    jobs: RwLock<Jobs>,
    /// Detached key/value windows: which window opened each, and which
    /// document it is looking at.
    ///
    /// Both are needed to know when one has outlived its reason to exist — a
    /// panel pointing at a closed document shows nothing, and one whose opener
    /// is gone would keep the app alive with no way back to it.
    panels: RwLock<HashMap<String, PanelOwner>>,
    /// Directories already added to the asset scope. See `grant_asset_dir`.
    asset_dirs: RwLock<HashSet<PathBuf>>,
    /// Which window opened each document.
    ///
    /// Plain ownership is enough because documents are never shared: each
    /// window's frontend dedupes against its own tabs, so two windows opening
    /// the same file end up with two documents. A panel does not open any — it
    /// reads the one its opener already has, and dies with that window.
    owners: RwLock<HashMap<DocId, String>>,
    /// What each window should open as soon as it is ready, keyed by label.
    ///
    /// A window cannot be told what to open until its frontend exists, and a
    /// window created for a second `dviewer` invocation does not exist yet when
    /// the arguments arrive. So the request waits here and the window collects
    /// it — see `commands::startup_request`.
    pending: RwLock<HashMap<String, LaunchRequest>>,
}

impl AppState {
    pub fn register_panel(&self, panel: &str, opener: &str, doc: DocId) {
        self.panels.write().insert(
            panel.to_owned(),
            PanelOwner {
                window: opener.to_owned(),
                doc,
            },
        );
    }

    /// Panels that should close because the window that opened them did.
    pub fn panels_opened_by(&self, window: &str) -> Vec<String> {
        self.drain_panels(|owner| owner.window == window)
    }

    /// Panels that should close because their document did.
    pub fn panels_showing(&self, doc: DocId) -> Vec<String> {
        self.drain_panels(|owner| owner.doc == doc)
    }

    fn drain_panels(&self, matches: impl Fn(&PanelOwner) -> bool) -> Vec<String> {
        let mut panels = self.panels.write();
        let doomed: Vec<String> = panels
            .iter()
            .filter(|(_, owner)| matches(owner))
            .map(|(label, _)| label.clone())
            .collect();
        for label in &doomed {
            panels.remove(label);
        }
        doomed
    }

    pub fn forget_panel(&self, panel: &str) {
        self.panels.write().remove(panel);
    }

    /// Leave a request for `window` to collect when it mounts.
    pub fn queue(&self, window: &str, request: LaunchRequest) {
        if request.is_empty() {
            return;
        }
        self.pending.write().insert(window.to_owned(), request);
    }

    /// Take whatever was left for `window`. Empty on every call but the first.
    pub fn take_pending(&self, window: &str) -> LaunchRequest {
        self.pending.write().remove(window).unwrap_or_default()
    }

    pub fn next_id(&self) -> DocId {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Store a document and record which window it belongs to.
    ///
    /// The window matters because the frontend is what normally closes a
    /// document, and a window that is destroyed never gets to. Without an
    /// owner recorded, killing a second window leaves its mmap and index held
    /// until the app exits.
    pub fn insert(&self, window: &str, doc: Document) -> Arc<Document> {
        let doc = Arc::new(doc);
        self.owners.write().insert(doc.id, window.to_owned());
        self.docs.write().insert(doc.id, Arc::clone(&doc));
        doc
    }

    pub fn get(&self, id: DocId) -> Result<Arc<Document>> {
        self.docs.read().get(&id).cloned().ok_or(Error::NoSuchDoc { id })
    }

    /// Dropping the Arc releases the mmap and the JSON index immediately,
    /// provided no background job still holds a clone.
    pub fn remove(&self, id: DocId) {
        self.owners.write().remove(&id);
        self.docs.write().remove(&id);
    }

    /// Every document opened by `window`, so a destroyed window can take its
    /// own with it.
    pub fn docs_owned_by(&self, window: &str) -> Vec<DocId> {
        self.owners
            .read()
            .iter()
            .filter(|(_, owner)| owner.as_str() == window)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Claim the indexing slot for `id`, or None when a job already holds it.
    ///
    /// Two views asking for the same document at once used to start two scans
    /// of it. The second cancelled the first, so nothing was corrupted, but a
    /// 500MB file was read twice for one answer. Whoever holds the slot will
    /// announce the result, so the loser has nothing to do.
    pub fn start_index_job(&self, id: DocId) -> Option<Arc<AtomicBool>> {
        let mut jobs = self.jobs.write();
        if jobs.index.contains_key(&id) {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.index.insert(id, Arc::clone(&flag));
        Some(flag)
    }

    /// Release the slot, unless a newer job has already taken it.
    ///
    /// Without this the slot stayed claimed for the life of the document, and
    /// re-indexing it — a format switch, a change of encoding — would find the
    /// door shut. `cancel_jobs` clears it too, which is why a switch works at
    /// all; this covers the ordinary ending.
    pub fn finish_index_job(&self, id: DocId, flag: &Arc<AtomicBool>) {
        let mut jobs = self.jobs.write();
        if jobs.index.get(&id).is_some_and(|held| Arc::ptr_eq(held, flag)) {
            jobs.index.remove(&id);
        }
    }

    /// Record that `dir` has been added to the asset scope.
    ///
    /// Returns false when it was already there. Tauri's scope has no way back
    /// — `forbid_*` is permanent and outranks every allow, so a directory
    /// granted once can only be granted again, and re-adding it on every open
    /// would grow the pattern list a viewer walks on every asset request.
    pub fn grant_asset_dir(&self, dir: &std::path::Path) -> bool {
        self.asset_dirs.write().insert(dir.to_path_buf())
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

#[cfg(test)]
mod tests {
    /// One document is indexed once, and can be indexed again afterwards.
    #[test]
    fn the_index_slot_is_claimed_once_and_handed_back() {
        let state = AppState::default();
        let id = state.next_id();

        let first = state.start_index_job(id).expect("slot is free");
        assert!(state.start_index_job(id).is_none(), "a second job must not start");

        state.finish_index_job(id, &first);
        let second = state.start_index_job(id).expect("slot is free again");

        // An older job ending must not release the slot a newer one holds.
        state.finish_index_job(id, &first);
        assert!(state.start_index_job(id).is_none(), "the newer job still holds it");
        state.finish_index_job(id, &second);
        assert!(state.start_index_job(id).is_some());
    }

    /// Cancelling frees the slot, which is what lets a format switch re-read.
    #[test]
    fn cancelling_frees_the_index_slot() {
        let state = AppState::default();
        let id = state.next_id();
        let flag = state.start_index_job(id).expect("slot is free");
        state.cancel_jobs(id);
        assert!(flag.load(Ordering::Relaxed), "the running job is told to stop");
        assert!(state.start_index_job(id).is_some(), "and the slot is free");
    }

    use super::*;

    /// The smallest document the store will hold. Nothing here reads its
    /// contents; what is under test is who it belongs to.
    fn stub(id: DocId) -> Document {
        let bytes = Arc::new(crate::bytes::DocBytes::Owned(Vec::new()));
        Document::new(
            id,
            format!("doc-{id}"),
            DocSource::Text,
            None,
            DocKind::Json,
            Arc::clone(&bytes),
            crate::encoding::Decoded {
                bytes,
                encoding: encoding_rs::UTF_8,
                source: crate::encoding::EncodingSource::Utf8,
                warning: None,
            },
        )
    }

    /// The rules that decide when a detached panel has outlived its reason to
    /// exist. Getting these wrong leaves a window pointing at nothing, or an
    /// app running with no way back to it — neither of which a type checker
    /// notices.
    #[test]
    fn a_panel_closes_with_the_document_it_shows() {
        let state = AppState::default();
        state.register_panel("panel-1", "main", 7);
        state.register_panel("panel-2", "main", 7);
        state.register_panel("panel-3", "main", 9);

        let mut doomed = state.panels_showing(7);
        doomed.sort();
        assert_eq!(doomed, ["panel-1", "panel-2"]);

        // Taken, not copied: closing the same document twice must not try to
        // close windows that are already gone.
        assert!(state.panels_showing(7).is_empty());
        assert_eq!(state.panels_showing(9), ["panel-3"]);
    }

    #[test]
    fn a_panel_closes_with_the_window_that_opened_it() {
        let state = AppState::default();
        state.register_panel("panel-1", "main", 1);
        state.register_panel("panel-2", "doc-1", 2);

        assert_eq!(state.panels_opened_by("main"), ["panel-1"]);
        assert_eq!(state.panels_opened_by("doc-1"), ["panel-2"]);
        assert!(state.panels_opened_by("main").is_empty());
    }

    /// A panel closed by hand must not be closed again when its document goes.
    #[test]
    fn forgetting_a_panel_takes_it_out_of_both_answers() {
        let state = AppState::default();
        state.register_panel("panel-1", "main", 3);
        state.forget_panel("panel-1");

        assert!(state.panels_showing(3).is_empty());
        assert!(state.panels_opened_by("main").is_empty());
    }

    /// A window that is destroyed takes its own documents with it, and only
    /// its own.
    #[test]
    fn documents_go_with_the_window_that_opened_them() {
        let state = AppState::default();
        let a = state.next_id();
        let b = state.next_id();
        state.insert("main", stub(a));
        state.insert("doc-1", stub(b));

        assert_eq!(state.docs_owned_by("main"), [a]);
        assert_eq!(state.docs_owned_by("doc-1"), [b]);

        for id in state.docs_owned_by("doc-1") {
            state.remove(id);
        }
        assert!(state.get(b).is_err());
        assert!(state.get(a).is_ok(), "the other window keeps its own");
        assert!(state.docs_owned_by("doc-1").is_empty());
        assert_eq!(state.docs_owned_by("main"), [a]);
    }

    /// Panels do not open panels, but if one ever did, closing it should take
    /// its children rather than orphaning them.
    #[test]
    fn a_panel_can_be_an_opener_too() {
        let state = AppState::default();
        state.register_panel("panel-1", "main", 1);
        state.register_panel("panel-2", "panel-1", 1);

        assert_eq!(state.panels_opened_by("panel-1"), ["panel-2"]);
    }

    #[test]
    fn a_window_that_opened_nothing_has_nothing_to_close() {
        let state = AppState::default();
        assert!(state.panels_opened_by("main").is_empty());
        assert!(state.panels_showing(1).is_empty());
    }
}
