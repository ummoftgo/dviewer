//! Listing what an archive holds, and opening one of it.

use std::sync::Arc;

use tauri::{Manager, State, Window};

use crate::archive::{ArchiveDoc, ArchiveListing};
use crate::bytes::DocBytes;
use crate::encoding;
use crate::error::{Error, Result, Subject};
use crate::source;
use crate::state::{AppState, DocId, DocKind, DocMeta, DocSource, Document};

/// How many archives deep a document may be.
///
/// Counted in entries, so `a.zip → b.zip → c.zip → leaf.log` is the longest
/// way in: three steps, of which the last is the document itself. Every step
/// materialises the one before it in memory — an entry is copied out of its
/// archive, not borrowed from it — so the limit is on the stack of buffers as
/// much as on the patience of whoever is clicking.
pub const MAX_DEPTH: usize = 3;

/// Everything in the archive, read from its central directory.
///
/// Opened on the first ask rather than when the document is, for the reason the
/// database connection is: a tab that is created and never looked at should not
/// have paid for a file it was not asked to read. An archive that was unwrapped
/// on the way in has already answered this, and says so for free.
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

/// Open one entry as a document of its own.
///
/// The new code here is "take one entry out". Everything after that is the tail
/// of `open_path`, unchanged and on purpose: an entry named `report.json.gz` is
/// ungzipped, then its format is decided by name and content, then it is
/// decoded — which is what makes an archive a multiplier over the formats
/// rather than a format of its own.
#[tauri::command]
pub async fn open_entry(
    app: tauri::AppHandle,
    window: Window,
    state: State<'_, AppState>,
    doc_id: DocId,
    index: u32,
) -> Result<DocMeta> {
    let doc = state.get(doc_id)?;
    let archive = doc.archive().ok_or(Error::NotReady {
        subject: Subject::Archive,
    })?;
    let name = archive
        .entry(index)
        .ok_or(Error::NoSuchEntry { index })?
        .name
        .clone();
    let source = doc.source.entry(index, name.clone())?;
    // Checked before anything is unpacked. Half a gigabyte is a long way to
    // carry something that is going to be refused for where it sits.
    if source.depth() > MAX_DEPTH {
        return Err(Error::TooDeep {
            subject: Subject::Archive,
            limit: MAX_DEPTH as u32,
        });
    }

    let id = state.next_id();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let body = archive.read_entry(index)?;
        entry_document(id, body, &name, source)
    })
    .await
    .map_err(Error::internal)??;

    grant_assets(&app, &state, &opened);
    Ok(state.insert(window.label(), opened).meta())
}

/// An archive as a document, unwrapped when there is nothing to choose.
///
/// Shared with `open_path`, which is where a `.zip` on disk arrives. Reading
/// the central directory here rather than lazily is the price of the unwrap:
/// there is no way to know an archive holds one document without looking.
pub(crate) fn open_archive(
    id: DocId,
    bytes: Arc<DocBytes>,
    title: String,
    source: DocSource,
) -> Result<Document> {
    let mut archive = ArchiveDoc::open(Arc::clone(&bytes))?;

    // An archive holding one document is a wrapper, not a choice. The same
    // reading XML's single root element and Parquet's single collection get: a
    // list with one row asks for a click that tells the reader nothing they
    // could not already see.
    let single = match archive.listing().entries.as_slice() {
        [only] => Some((only.index, only.name.clone())),
        _ => None,
    };
    if let Some((index, name)) = single {
        match unwrap_single(id, &archive, index, &name, &source) {
            Ok(doc) => return Ok(doc),
            // Locked, oversized, or a format that needs a file. The list is
            // what the reader gets instead, and it carries this so that it does
            // not look like an archive that merely happens to have one row.
            Err(refusal) => archive = archive.refusing(refusal),
        }
    }

    let doc = Document::new(
        id,
        title,
        source,
        // An entry has no directory for a relative image to resolve against,
        // and neither has the archive holding it. See `entry_document`.
        None,
        DocKind::Zip,
        Arc::clone(&bytes),
        encoding::verbatim(bytes),
    );
    doc.set_archive(Arc::new(archive));
    Ok(doc)
}

fn unwrap_single(
    id: DocId,
    archive: &ArchiveDoc,
    index: u32,
    name: &str,
    source: &DocSource,
) -> Result<Document> {
    let body = archive.read_entry(index)?;
    entry_document(id, body, name, source.entry(index, name.to_owned())?)
}

/// Bytes that came out of an archive, as a document.
///
/// The same three steps `open_path` takes on a file, in the same order, and
/// with the two refusals that belong to a buffer rather than a file.
fn entry_document(
    id: DocId,
    body: Vec<u8>,
    name: &str,
    source: DocSource,
) -> Result<Document> {
    // Two layers of compression is not a special case: a `.log.gz` inside a zip
    // is a gzip member once it is out, and this is the same call a `.gz` on
    // disk goes through.
    let (bytes, title) = source::ungzip(DocBytes::from(body), name)?;
    let bytes = Arc::new(bytes);
    let kind = source::detect_kind(&title, &bytes);

    // See `DocKind::needs_file`. A database, a workbook and a columnar file are
    // read through a path, and what came out of an archive has none.
    if kind.needs_file() {
        return Err(Error::NeedsFile);
    }
    // An archive at the limit would be a tab whose every row is refused. Saying
    // so here, where there is still a list to say it on, is better than opening
    // a window onto nothing.
    if kind == DocKind::Zip && source.depth() >= MAX_DEPTH {
        return Err(Error::TooDeep {
            subject: Subject::Archive,
            limit: MAX_DEPTH as u32,
        });
    }

    if kind == DocKind::Zip {
        return open_archive(id, bytes, title, source);
    }

    let decoded = if kind.reads_bytes() {
        encoding::decode(Arc::clone(&bytes))
    } else {
        encoding::verbatim(Arc::clone(&bytes))
    };
    // `base_dir` is None, and there is nowhere it could point. A markdown file
    // inside an archive refers to its images by a path into the archive, which
    // the webview cannot reach — so the images do not render. Documented rather
    // than papered over by unpacking to a temporary directory, which would put
    // a copy of someone's archive somewhere they did not choose.
    Ok(Document::new(id, title, source, None, kind, bytes, decoded))
}

/// The webview needs reach into a directory only for a rendered document's
/// images, and only a file on disk has one. Shared with `open_path`.
pub(crate) fn grant_assets(app: &tauri::AppHandle, state: &AppState, doc: &Document) {
    if doc.kind().view() != crate::state::DocView::Prose {
        return;
    }
    if let Some(dir) = &doc.base_dir {
        if state.grant_asset_dir(dir) {
            let _ = app.asset_protocol_scope().allow_directory(dir, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::fixtures::*;

    fn file_source() -> DocSource {
        DocSource::File {
            path: "C:/docs/bundle.zip".to_owned(),
        }
    }

    fn open(entries: Vec<Entry>, source: DocSource) -> Result<Document> {
        open_archive(1, zip_bytes(entries), "bundle.zip".to_owned(), source)
    }

    /// A chain is built by appending, and the root it started from is carried
    /// the whole way down rather than being rediscovered.
    #[test]
    fn the_way_in_is_a_chain_from_the_root() {
        let outer = file_source()
            .entry(2, "inner.zip".to_owned())
            .expect("first step");
        assert_eq!(outer.depth(), 1);

        let inner = outer.entry(7, "logs/app.log".to_owned()).expect("second step");
        assert_eq!(inner.depth(), 2);

        let DocSource::ArchiveEntry { root, entries } = &inner else {
            panic!("expected a chain, got {inner:?}");
        };
        assert!(matches!(**root, DocSource::File { .. }), "the root stays the file");
        assert_eq!(entries[0].index, 2);
        assert_eq!(entries[1].name, "logs/app.log");
    }

    /// Pasted text is a Rust String, so it is UTF-8 and was never an archive.
    #[test]
    fn pasted_text_has_no_entries() {
        assert!(DocSource::Text.entry(0, "a.txt".to_owned()).is_err());
    }

    /// The entry goes through the pipeline a file does, in the same order: a
    /// `.gz` is unpacked and renamed first, and only then does the name decide
    /// the format. Two layers of compression, no special case for either.
    #[test]
    fn a_gzipped_entry_is_unpacked_before_its_format_is_decided() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(br#"{"a":1}"#).expect("compress");
        let packed = encoder.finish().expect("finish");

        let doc = entry_document(
            1,
            packed,
            "report.json.gz",
            file_source().entry(0, "report.json.gz".to_owned()).expect("chain"),
        )
        .expect("open");

        assert_eq!(doc.kind(), DocKind::Json);
        assert_eq!(doc.title, "report.json", "the inner name is what it is called");
    }

    /// A database is queried through a path, and what came out of an archive
    /// has none. The same refusal a downloaded one gets, for the same reason.
    #[test]
    fn a_database_entry_is_refused_rather_than_unpacked_to_disk() {
        let magic = b"SQLite format 3\0and the rest of a header".to_vec();
        let result = entry_document(
            1,
            magic,
            "app.sqlite",
            file_source().entry(0, "app.sqlite".to_owned()).expect("chain"),
        );
        assert!(matches!(result, Err(Error::NeedsFile)));
    }

    /// An archive at the limit would be a tab whose every row is refused, so it
    /// is refused itself — while there is still a list to say so on.
    #[test]
    fn an_archive_too_deep_to_be_useful_is_refused_where_it_is_clicked() {
        let mut source = file_source();
        for step in 0..MAX_DEPTH - 1 {
            source = source.entry(step as u32, format!("step{step}.zip")).expect("chain");
        }
        // One more entry is allowed, and a plain document at that depth opens.
        let leaf = source.entry(9, "logs/app.log".to_owned()).expect("chain");
        assert_eq!(leaf.depth(), MAX_DEPTH);
        assert!(entry_document(1, b"a line\n".to_vec(), "logs/app.log", leaf).is_ok());

        // The same depth reached by an archive is not, because nothing could
        // then be opened out of it.
        let nested = source.entry(9, "inner.zip".to_owned()).expect("chain");
        let bytes = zip_bytes(vec![stored(b"a.txt", b"x", 0), stored(b"b.txt", b"y", 0)]);
        let result = entry_document(1, bytes.to_vec(), "inner.zip", nested);
        assert!(
            matches!(result, Err(Error::TooDeep { limit, .. }) if limit == MAX_DEPTH as u32),
            "expected a depth refusal"
        );
    }

    /// One document in an archive is a wrapper, not a choice — the same reading
    /// XML's single root and Parquet's single collection already get.
    #[test]
    fn an_archive_holding_one_document_opens_it() {
        let doc = open(vec![stored(b"report.json", br#"{"a":1}"#, 0)], file_source())
            .expect("open");

        assert_eq!(doc.kind(), DocKind::Json, "the entry, not the zip");
        assert_eq!(doc.title, "report.json");
        assert_eq!(doc.source.depth(), 1, "and it says where it came from");
    }

    /// Unwrapping is not allowed to swallow the refusal. When the single entry
    /// cannot be opened the list is what the reader gets, and it carries the
    /// reason so it does not read as an archive that merely holds one thing.
    #[test]
    fn a_single_entry_that_cannot_be_opened_falls_back_to_the_list() {
        const ENCRYPTED: u16 = 1;
        let doc = open(
            vec![stored(b"secret.txt", b"x", ENCRYPTED)],
            file_source(),
        )
        .expect("open");

        assert_eq!(doc.kind(), DocKind::Zip, "the archive stays on screen");
        let archive = doc.archive().expect("the list is already read");
        assert_eq!(archive.listing().entries.len(), 1);
        assert!(
            matches!(archive.listing().refused, Some(Error::EntryEncrypted)),
            "and says why it is here"
        );
    }

    /// Two documents is a choice, so the list is the answer and nothing is
    /// unwrapped.
    #[test]
    fn an_archive_holding_two_documents_is_a_list() {
        let doc = open(
            vec![stored(b"a.json", b"{}", 0), stored(b"b.csv", b"x,y\n", 0)],
            file_source(),
        )
        .expect("open");

        assert_eq!(doc.kind(), DocKind::Zip);
        assert!(doc.archive().expect("listed").listing().refused.is_none());
    }

    /// Nesting works because nothing about it is special: an entry that turns
    /// out to be an archive goes back through the same door it came out of, and
    /// the chain grows by one step each time.
    #[test]
    fn an_archive_inside_an_archive_is_read_the_same_way() {
        let inner = zip_bytes(vec![
            stored(b"logs/app.log", b"a line\n", 0),
            stored(b"notes.md", b"# hi", 0),
        ]);
        let outer = open(
            vec![
                stored(b"inner.zip", &inner, 0),
                stored(b"readme.md", b"# outer", 0),
            ],
            file_source(),
        )
        .expect("outer");
        assert_eq!(outer.kind(), DocKind::Zip);

        // Opening the inner archive gives another archive, one step deeper.
        let nested = entry_document(
            2,
            outer.archive().expect("listed").read_entry(0).expect("read"),
            "inner.zip",
            outer.source.entry(0, "inner.zip".to_owned()).expect("chain"),
        )
        .expect("inner");
        assert_eq!(nested.kind(), DocKind::Zip);
        assert_eq!(nested.source.depth(), 1, "the outer zip is the root, not a step");

        // And a document out of that one is two steps in, still rooted at the
        // file the whole thing came from.
        let leaf = entry_document(
            3,
            nested.archive().expect("listed").read_entry(0).expect("read"),
            "logs/app.log",
            nested.source.entry(0, "logs/app.log".to_owned()).expect("chain"),
        )
        .expect("leaf");
        assert_eq!(leaf.kind(), DocKind::Text);
        assert_eq!(leaf.source.depth(), 2);

        let DocSource::ArchiveEntry { root, entries } = &leaf.source else {
            panic!("expected a chain");
        };
        assert!(matches!(**root, DocSource::File { .. }));
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["inner.zip", "logs/app.log"]
        );
    }

    /// An archive whose one document is itself an archive is unwrapped through
    /// both, because each of them was a wrapper rather than a choice.
    #[test]
    fn unwrapping_goes_as_deep_as_the_wrappers_do() {
        let inner = zip_bytes(vec![stored(b"report.json", br#"{"a":1}"#, 0)]);
        let doc = open(vec![stored(b"inner.zip", &inner, 0)], file_source()).expect("open");

        assert_eq!(doc.kind(), DocKind::Json, "through both wrappers");
        assert_eq!(doc.source.depth(), 2);
    }

    /// A zip fetched over HTTP is still a zip, and its entries name the URL as
    /// where they came from.
    #[test]
    fn a_url_can_be_the_root_of_a_chain() {
        let source = DocSource::Url {
            url: "https://example.test/bundle.zip".to_owned(),
        };
        let doc = open(vec![stored(b"report.json", b"{}", 0)], source).expect("open");

        let DocSource::ArchiveEntry { root, .. } = &doc.source else {
            panic!("expected a chain");
        };
        assert!(matches!(**root, DocSource::Url { .. }));
    }
}
