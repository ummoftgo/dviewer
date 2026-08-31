use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::bytes::DocBytes;
use flate2::read::GzDecoder;

use crate::error::{Error, Subject, Result};
use crate::state::DocKind;

/// Hard ceiling on remote documents. Local files are memory-mapped so their
/// size is bounded by the JSON indexer instead, but a download has to fit in
/// RAM, so we refuse rather than swap the machine to death.
pub const MAX_URL_BYTES: u64 = 512 * 1024 * 1024;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
const JSON_EXTS: &[&str] = &["json", "geojson", "har", "ipynb"];
/// One record per line, so the table is the reading that matches the format.
/// The tree is one switch away for anyone who wants the records nested.
const JSONL_EXTS: &[&str] = &["jsonl", "ndjson"];
/// Only the extension that says so. `.json` stays strict however common the
/// comments in the wild are — the toolbar switch is one click, and a viewer
/// that reads a malformed file without a word teaches its reader it was fine.
const JSONC_EXTS: &[&str] = &["jsonc"];
const YAML_EXTS: &[&str] = &["yaml", "yml"];
const TOML_EXTS: &[&str] = &["toml"];
const XML_EXTS: &[&str] = &[
    "xml", "xhtml", "svg", "rss", "atom", "xsd", "xsl", "xslt", "plist", "kml", "gpx", "opml",
    "wsdl", "pom",
];
const CSV_EXTS: &[&str] = &["csv"];
const TSV_EXTS: &[&str] = &["tsv", "tab"];
/// `.txt` used to be read as markdown, which meant a plain file was rendered:
/// its asterisks became emphasis and its hashes became headings. Text is what
/// it says it is.
const TEXT_EXTS: &[&str] = &["txt", "log"];
const SQLITE_EXTS: &[&str] = &["db", "sqlite", "sqlite3", "db3"];
/// `.xlsm` is the same format with macros in it, which this never runs.
/// `.xls` is the older binary one and is not read: calamine can, but the value
/// text and the date handling below are written against the modern shapes.
const XLSX_EXTS: &[&str] = &["xlsx", "xlsm"];
const PARQUET_EXTS: &[&str] = &["parquet", "pq"];
/// Only `.zip`. Every other container that happens to be a zip — `.xlsx`,
/// `.docx`, `.jar`, `.epub` — is that other thing, and reading it as an archive
/// would show its plumbing instead of its content.
const ZIP_EXTS: &[&str] = &["zip"];

/// The sixteen bytes every SQLite database begins with.
///
/// A self-declaration in the same sense as JSON's `{` or XML's `<`, and a far
/// stronger one — no text file starts with this by accident.
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// The four bytes a Parquet file opens and closes with.
///
/// A weaker self-declaration than SQLite's sixteen, so it is only trusted at
/// the front *and* the back — a text file starting with `PAR1` is possible, one
/// that also ends with it is not worth worrying about.
const PARQUET_MAGIC: &[u8] = b"PAR1";

/// The two bytes every zip member and every zip directory header begins with.
///
/// The one piece of magic here that is *not* trusted on its own, and the
/// asymmetry is deliberate. `.xlsx` is a zip. So is `.docx`, `.jar`, `.epub`
/// and an Android package. Worse, the magic below is tested before the
/// extension table — a rule that reads `PK` as an archive would therefore
/// swallow xlsx whole, because `detect_kind` never reaches `XLSX_EXTS` to
/// rescue it. So this only ever confirms a name that already said `zip`, and a
/// PK file with no extension is left alone.
const ZIP_MAGIC: &[u8] = b"PK";

/// Every format the viewer knows, paired with the extensions that name it.
const BY_EXTENSION: &[(DocKind, &[&str])] = &[
    (DocKind::Json, JSON_EXTS),
    (DocKind::Jsonl, JSONL_EXTS),
    (DocKind::Jsonc, JSONC_EXTS),
    (DocKind::Markdown, MARKDOWN_EXTS),
    (DocKind::Yaml, YAML_EXTS),
    (DocKind::Toml, TOML_EXTS),
    (DocKind::Xml, XML_EXTS),
    (DocKind::Csv, CSV_EXTS),
    (DocKind::Tsv, TSV_EXTS),
    (DocKind::Text, TEXT_EXTS),
    (DocKind::Sqlite, SQLITE_EXTS),
    (DocKind::Xlsx, XLSX_EXTS),
    (DocKind::Parquet, PARQUET_EXTS),
    (DocKind::Zip, ZIP_EXTS),
];

/// Decide how to read a document: extension first, then a peek at the content.
///
/// Content sniffing is deliberately limited to JSON and XML. Both announce
/// themselves in their first non-space character and cannot be mistaken for
/// prose. The others cannot: a paragraph containing a colon is valid YAML and
/// one containing commas is valid CSV, so guessing at them would silently
/// mangle ordinary text files. Anything unrecognised is text: a file that names
/// no format is far more often a log or a dump than prose, and reading it as
/// markdown renders it — asterisks become emphasis, hashes become headings.
/// Whoever wants that says so in the toolbar.
/// Whether these bytes are a Parquet file.
///
/// The format brackets itself: `PAR1` at both ends, with the footer's length
/// just before the closing one. Both are checked because four bytes at the
/// front alone is a weak promise.
fn is_parquet(bytes: &[u8]) -> bool {
    bytes.len() > PARQUET_MAGIC.len() * 2
        && bytes.starts_with(PARQUET_MAGIC)
        && bytes.ends_with(PARQUET_MAGIC)
}

pub fn detect_kind(name: &str, bytes: &[u8]) -> DocKind {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    // The magic comes first, because it is the one signal that cannot be wrong.
    if bytes.starts_with(SQLITE_MAGIC) {
        return DocKind::Sqlite;
    }
    if is_parquet(bytes) {
        return DocKind::Parquet;
    }

    for (kind, extensions) in BY_EXTENSION {
        if extensions.contains(&ext.as_str()) {
            // `.db` names a dozen unrelated formats, and `.pq` is not much
            // better. Without the magic above, the name alone is not enough to
            // promise either.
            if matches!(kind, DocKind::Sqlite | DocKind::Parquet) {
                break;
            }
            // `.zip` is the other direction: the name is what nominates the
            // format, and the magic is what confirms it. A file called `.zip`
            // that does not begin with `PK` is something else misnamed, and
            // falls through to be read as whatever it actually is.
            if matches!(kind, DocKind::Zip) {
                if bytes.starts_with(ZIP_MAGIC) {
                    return DocKind::Zip;
                }
                break;
            }
            return *kind;
        }
    }
    sniff(bytes).unwrap_or(DocKind::Text)
}

/// What the name alone says a document is.
///
/// For the archive list, where a badge has to be drawn before anything has been
/// unpacked. Weaker than `detect_kind` in exactly two ways, both unavoidable
/// without the bytes: a name that declares nothing is text rather than whatever
/// its first character would have said, and `.db` and `.pq` are text because
/// only their magic can promise otherwise. `.zip` is the reverse case and is
/// taken at its word — the list describes what a click would attempt, and a
/// click on a misnamed `.zip` finds out the way opening one does.
pub fn kind_from_name(name: &str) -> DocKind {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    for (kind, extensions) in BY_EXTENSION {
        if extensions.contains(&ext.as_str()) {
            if matches!(kind, DocKind::Sqlite | DocKind::Parquet) {
                break;
            }
            return *kind;
        }
    }
    DocKind::Text
}

fn sniff(bytes: &[u8]) -> Option<DocKind> {
    let head = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let first = *head.iter().find(|b| !b.is_ascii_whitespace())?;
    match first {
        b'{' | b'[' => Some(DocKind::Json),
        // `<` starts a tag, a comment, a declaration or a doctype — no
        // plain-text document begins with one by accident.
        b'<' => Some(DocKind::Xml),
        _ => None,
    }
}

/// What a compressed document may weigh once opened.
///
/// The limit is on the result, not on the file. gzip reaches a thousand to one,
/// so a one-megabyte `.gz` can ask for gigabytes — and the only moment anyone
/// can refuse is while it is coming out. Checking the file's own size would
/// stop nothing.
pub const MAX_DECOMPRESSED_BYTES: usize = 512 * 1024 * 1024;

/// The two bytes a gzip member begins with.
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Decompress a document if it is gzip, and say what it should be called.
///
/// The name matters as much as the bytes: `report.json.gz` is JSON, and only
/// the inner name says so. A bare `.gz` leaves the content to speak.
///
/// The result is an owned buffer, so a decompressed document gives up the mmap
/// the file had. That is the same trade an encoding conversion already makes,
/// and the limit above is what keeps it finite.
pub fn ungzip(bytes: DocBytes, title: &str) -> Result<(DocBytes, String)> {
    if !bytes.starts_with(&GZIP_MAGIC) {
        return Ok((bytes, title.to_owned()));
    }

    let mut out = Vec::new();
    // One byte past the limit is enough to know, and stops the read there
    // rather than after the whole thing has been built.
    let mut reader = GzDecoder::new(&bytes[..]).take(MAX_DECOMPRESSED_BYTES as u64 + 1);
    reader.read_to_end(&mut out).map_err(|e| Error::ParseFailed {
        subject: Subject::Decompressed,
        detail: e.to_string(),
    })?;

    if out.len() > MAX_DECOMPRESSED_BYTES {
        return Err(Error::TooLarge {
            subject: Subject::Decompressed,
            megabytes: out.len() / 1024 / 1024,
            limit_mb: MAX_DECOMPRESSED_BYTES / 1024 / 1024,
        });
    }

    let inner = title
        .strip_suffix(".gz")
        .or_else(|| title.strip_suffix(".GZ"))
        .unwrap_or(title);
    Ok((DocBytes::Owned(out), inner.to_owned()))
}

pub fn load_file(path: &Path) -> Result<(DocBytes, String, Option<PathBuf>)> {
    let bytes = DocBytes::map_file(path)?;
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let base_dir = path.parent().map(Path::to_path_buf);
    Ok((bytes, title, base_dir))
}

pub struct Fetched {
    pub bytes: Vec<u8>,
    pub title: String,
    pub content_type: Option<String>,
}

/// How long one fetch may take from start to finish.
///
/// ureq's own timeouts are all unset by default except the 100-continue wait,
/// so a server that accepts the connection and then dribbles holds the blocking
/// thread for as long as it likes — and nothing here can take it back, because
/// opening a URL has no cancel. A whole-request ceiling is the one bound that
/// covers connect, response and body together.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Separated so the ceiling can be tested without waiting for the real one.
fn agent_with(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into()
}

pub fn fetch_url(url: &str) -> Result<Fetched> {
    let parsed = url::Url::parse(url).map_err(|_| Error::BadUrl {
        url: url.to_owned(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::UnsupportedScheme);
    }

    let mut response = agent_with(FETCH_TIMEOUT)
        .get(parsed.as_str())
        .header("accept", "text/markdown, application/json, text/plain;q=0.9, */*;q=0.5")
        .call()
        .map_err(|e| Error::FetchFailed {
            detail: e.to_string(),
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::HttpStatus {
            status: status.to_string(),
        });
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned());

    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_URL_BYTES)
        .read_to_vec()
        .map_err(|e| Error::DownloadFailed {
            detail: e.to_string(),
            limit_mb: MAX_URL_BYTES / 1024 / 1024,
        })?;

    Ok(Fetched {
        title: title_from_url(&parsed),
        bytes,
        content_type,
    })
}

fn title_from_url(url: &url::Url) -> String {
    url.path_segments()
        .and_then(|mut segments| segments.next_back().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| url.host_str().unwrap_or("Untitled").to_owned())
}

/// Content-Type is a hint only: many servers send `text/plain` for .md files
/// and `application/octet-stream` for everything. Trust it when it is specific,
/// otherwise fall back to sniffing.
pub fn kind_from_response(title: &str, content_type: Option<&str>, bytes: &[u8]) -> DocKind {
    let mime = content_type
        .map(|ct| ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();

    match mime.as_str() {
        "application/json" | "application/ld+json" | "text/json" | "application/x-ndjson"
        | "application/geo+json" => DocKind::Json,
        "text/markdown" | "text/x-markdown" => DocKind::Markdown,
        "application/yaml" | "text/yaml" | "application/x-yaml" | "text/x-yaml" => DocKind::Yaml,
        "application/toml" | "text/x-toml" => DocKind::Toml,
        "text/csv" | "application/csv" => DocKind::Csv,
        "text/tab-separated-values" => DocKind::Tsv,
        "application/xml" | "text/xml" => DocKind::Xml,
        // `+xml` covers svg, rss, atom, xhtml and every other dialect at once.
        other if other.ends_with("+xml") => DocKind::Xml,
        _ => detect_kind(title, bytes),
    }
}

#[cfg(test)]
mod tests {
    /// The magic decides, not the name.
    ///
    /// `.db` names a dozen unrelated formats, so an extension alone must not
    /// promise a database — and a database with no extension at all is still
    /// one, because its first sixteen bytes say so.
    #[test]
    fn a_database_is_known_by_its_first_bytes() {
        let magic = b"SQLite format 3\0rest of the header";
        assert_eq!(detect_kind("app.sqlite", magic), DocKind::Sqlite);
        assert_eq!(detect_kind("dump", magic), DocKind::Sqlite);
        assert_eq!(detect_kind("notes.txt", magic), DocKind::Sqlite);

        // The same names without the magic are whatever they otherwise are.
        assert_eq!(detect_kind("app.db", b"id,name\n1,a\n"), DocKind::Text);
        assert_eq!(detect_kind("app.sqlite", b"{\"a\":1}"), DocKind::Json);
        assert_eq!(detect_kind("app.db3", "# 제목".as_bytes()), DocKind::Text);
    }

    fn gzipped(bytes: &[u8]) -> Vec<u8> {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).expect("compress");
        encoder.finish().expect("finish")
    }

    /// A file that is not gzip comes back untouched, name and all.
    #[test]
    fn plain_bytes_pass_through() {
        let (bytes, title) = ungzip(DocBytes::Owned(b"plain".to_vec()), "notes.txt").expect("ok");
        assert_eq!(&bytes[..], b"plain");
        assert_eq!(title, "notes.txt");
    }

    /// The inner name decides the format — the outer one only says "compressed".
    #[test]
    fn the_inner_name_is_what_the_document_is_called() {
        let packed = gzipped(br#"{"a":1}"#);
        let (bytes, title) = ungzip(DocBytes::Owned(packed.clone()), "report.json.gz").expect("ok");
        assert_eq!(&bytes[..], br#"{"a":1}"#);
        assert_eq!(title, "report.json");
        assert_eq!(detect_kind(&title, &bytes), DocKind::Json);

        // A bare `.gz` has no inner name, so the content has to speak.
        let (bytes, title) = ungzip(DocBytes::Owned(packed), "dump.gz").expect("ok");
        assert_eq!(title, "dump");
        assert_eq!(detect_kind(&title, &bytes), DocKind::Json);
    }

    /// A small file that expands enormously is refused, not swallowed.
    ///
    /// This is why the limit is on the result and not on the file: the archive
    /// below is a few kilobytes and would ask for more than half a gigabyte.
    #[test]
    fn a_compression_bomb_is_refused() {
        let packed = gzipped(&vec![b'0'; MAX_DECOMPRESSED_BYTES + 1024]);
        assert!(
            packed.len() < 1024 * 1024,
            "the archive itself is small — {} bytes",
            packed.len()
        );
        match ungzip(DocBytes::Owned(packed), "bomb.gz").map(|(_, title)| title) {
            Err(Error::TooLarge { subject, limit_mb, .. }) => {
                assert_eq!(subject, Subject::Decompressed);
                assert_eq!(limit_mb, MAX_DECOMPRESSED_BYTES / 1024 / 1024);
            }
            other => panic!("expected a size refusal, got {other:?}"),
        }
    }

    /// Truncated gzip is reported, not shown as whatever came out first.
    #[test]
    fn a_broken_archive_is_an_error() {
        let mut packed = gzipped(b"some content that was cut short");
        packed.truncate(packed.len() / 2);
        assert!(matches!(
            ungzip(DocBytes::Owned(packed), "cut.gz").map(|(_, title)| title),
            Err(Error::ParseFailed { subject: Subject::Decompressed, .. })
        ));
    }

    /// A server that accepts and then says nothing must not hold the thread.
    ///
    /// Opening a URL runs on a blocking thread with no way to cancel it, and
    /// every one of ureq's timeouts is unset by default — so without a ceiling
    /// this call never returns and the thread is gone for the session.
    #[test]
    fn a_stalled_server_gives_the_thread_back() {
        use std::net::TcpListener;
        use std::time::Instant;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            // Accept, then hold the connection open without answering.
            let held = listener.accept();
            std::thread::sleep(Duration::from_secs(20));
            drop(held);
        });

        let started = Instant::now();
        let result = agent_with(Duration::from_millis(400))
            .get(format!("http://{addr}/"))
            .call();
        let waited = started.elapsed();

        assert!(result.is_err(), "a stalled request must not succeed");
        assert!(waited < Duration::from_secs(5), "gave up after {waited:?}");
    }

    use super::*;

    #[test]
    fn the_extension_decides_when_there_is_one() {
        let cases: &[(&str, DocKind)] = &[
            ("a.json", DocKind::Json),
            ("a.jsonl", DocKind::Jsonl),
            ("a.ndjson", DocKind::Jsonl),
            ("a.jsonc", DocKind::Jsonc),
            ("a.md", DocKind::Markdown),
            ("a.yaml", DocKind::Yaml),
            ("a.YML", DocKind::Yaml),
            ("a.toml", DocKind::Toml),
            ("a.xml", DocKind::Xml),
            ("a.svg", DocKind::Xml),
            ("a.csv", DocKind::Csv),
            ("a.tsv", DocKind::Tsv),
            ("a.txt", DocKind::Text),
            ("app.log", DocKind::Text),
        ];
        for (name, expected) in cases {
            assert_eq!(detect_kind(name, b""), *expected, "{name}");
        }
    }

    /// The extension wins even when the content says otherwise: the name is a
    /// deliberate statement by whoever wrote the file.
    #[test]
    fn content_only_speaks_when_the_name_says_nothing() {
        assert_eq!(detect_kind("notes.md", b"{}"), DocKind::Markdown);
        assert_eq!(detect_kind("data", b"  {\"a\":1}"), DocKind::Json);
        assert_eq!(detect_kind("data", b"[1,2]"), DocKind::Json);
        assert_eq!(detect_kind("feed", b"<?xml?><rss/>"), DocKind::Xml);
        assert_eq!(detect_kind("page", b"<html></html>"), DocKind::Xml);
    }

    /// Guessing at these would turn ordinary prose into a broken grid.
    #[test]
    /// A file that names no format is read as text, not as prose.
    ///
    /// It used to fall back to markdown, which rendered a plain file: asterisks
    /// became emphasis and hashes became headings. Far more of these are logs
    /// and dumps than documents, and the toolbar can still say otherwise.
    fn prose_is_never_mistaken_for_a_data_format() {
        let prose: &[&[u8]] = &[
            b"Title: a report",
            b"one, two, three",
            b"key = value",
            b"- a list item",
            b"",
        ];
        for text in prose {
            assert_eq!(detect_kind("untitled", text), DocKind::Text);
        }
    }


    /// The one magic that only ever confirms, never nominates.
    ///
    /// `PK` starts a zip, and it also starts every xlsx, docx, jar and epub in
    /// existence. The magic tests above run before the extension table, so a
    /// rule that read `PK` as an archive would swallow those whole — the loop
    /// that rescues `.xlsx` would never be reached. So the name has to say
    /// `zip` first, and the magic only agrees.
    #[test]
    fn pk_confirms_a_zip_and_never_nominates_one() {
        let pk = b"PK\x03\x04rest of the archive";
        assert_eq!(detect_kind("bundle.zip", pk), DocKind::Zip);

        // The formats that are zips underneath stay themselves.
        assert_eq!(detect_kind("book.xlsx", pk), DocKind::Xlsx);
        // And one with no extension at all is not an archive on the strength
        // of two bytes.
        assert_eq!(detect_kind("bundle", pk), DocKind::Text);
    }

    /// A `.zip` that does not begin with `PK` is something else misnamed, and
    /// is read as whatever it actually is.
    #[test]
    fn a_zip_without_the_magic_falls_through() {
        assert_eq!(detect_kind("notes.zip", b"{\"a\":1}"), DocKind::Json);
        assert_eq!(detect_kind("notes.zip", b"plain text"), DocKind::Text);
    }

    /// The badge in an archive list is drawn before anything is unpacked, so it
    /// has only the name to go on — and says so where the name says nothing.
    #[test]
    fn the_name_alone_answers_for_an_entry() {
        assert_eq!(kind_from_name("logs/app.log"), DocKind::Text);
        assert_eq!(kind_from_name("data/report.json"), DocKind::Json);
        assert_eq!(kind_from_name("inner.zip"), DocKind::Zip);
        // Only their magic can promise these, and there is none to read yet.
        assert_eq!(kind_from_name("app.db"), DocKind::Text);
        assert_eq!(kind_from_name("part.parquet"), DocKind::Text);
        // A name that declares nothing cannot borrow the content's voice here.
        assert_eq!(kind_from_name("LICENSE"), DocKind::Text);
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_first_character() {
        assert_eq!(detect_kind("data", "\u{feff}{}".as_bytes()), DocKind::Json);
    }

    #[test]
    fn the_content_type_is_used_when_it_is_specific() {
        let cases: &[(&str, DocKind)] = &[
            ("application/json", DocKind::Json),
            ("text/csv; charset=utf-8", DocKind::Csv),
            ("text/tab-separated-values", DocKind::Tsv),
            ("application/yaml", DocKind::Yaml),
            ("image/svg+xml", DocKind::Xml),
            ("application/rss+xml", DocKind::Xml),
            ("text/markdown", DocKind::Markdown),
        ];
        for (mime, expected) in cases {
            assert_eq!(kind_from_response("f", Some(mime), b""), *expected, "{mime}");
        }
    }

    /// Servers send `text/plain` for markdown and `octet-stream` for anything
    /// they have no opinion about, so a vague type has to defer to the name.
    #[test]
    fn a_vague_content_type_defers_to_the_name() {
        assert_eq!(
            kind_from_response("data.csv", Some("application/octet-stream"), b""),
            DocKind::Csv
        );
        assert_eq!(
            kind_from_response("readme.md", Some("text/plain"), b""),
            DocKind::Markdown
        );
    }
}
