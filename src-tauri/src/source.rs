use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::bytes::DocBytes;
use crate::error::{Error, Result};
use crate::state::DocKind;

/// Hard ceiling on remote documents. Local files are memory-mapped so their
/// size is bounded by the JSON indexer instead, but a download has to fit in
/// RAM, so we refuse rather than swap the machine to death.
pub const MAX_URL_BYTES: u64 = 512 * 1024 * 1024;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
const JSON_EXTS: &[&str] = &["json", "jsonc", "jsonl", "ndjson", "geojson", "har", "ipynb"];
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

/// Every format the viewer knows, paired with the extensions that name it.
const BY_EXTENSION: &[(DocKind, &[&str])] = &[
    (DocKind::Json, JSON_EXTS),
    (DocKind::Markdown, MARKDOWN_EXTS),
    (DocKind::Yaml, YAML_EXTS),
    (DocKind::Toml, TOML_EXTS),
    (DocKind::Xml, XML_EXTS),
    (DocKind::Csv, CSV_EXTS),
    (DocKind::Tsv, TSV_EXTS),
    (DocKind::Text, TEXT_EXTS),
];

/// Decide how to read a document: extension first, then a peek at the content.
///
/// Content sniffing is deliberately limited to JSON and XML. Both announce
/// themselves in their first non-space character and cannot be mistaken for
/// prose. The others cannot: a paragraph containing a colon is valid YAML and
/// one containing commas is valid CSV, so guessing at them would silently
/// mangle ordinary text files. Anything unrecognised falls back to markdown,
/// which renders plain text unharmed.
pub fn detect_kind(name: &str, bytes: &[u8]) -> DocKind {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    for (kind, extensions) in BY_EXTENSION {
        if extensions.contains(&ext.as_str()) {
            return *kind;
        }
    }
    // Text, not markdown. A file that names no format is far more often a log
    // or a dump than prose, and rendering it as markdown eats its punctuation.
    // Whoever wants it rendered says so in the toolbar.
    sniff(bytes).unwrap_or(DocKind::Text)
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
            ("a.jsonl", DocKind::Json),
            ("a.ndjson", DocKind::Json),
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
