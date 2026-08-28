use std::path::{Path, PathBuf};

use crate::bytes::DocBytes;
use crate::error::{Error, Result};
use crate::state::DocKind;

/// Hard ceiling on remote documents. Local files are memory-mapped so their
/// size is bounded by the JSON indexer instead, but a download has to fit in
/// RAM, so we refuse rather than swap the machine to death.
pub const MAX_URL_BYTES: u64 = 512 * 1024 * 1024;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt"];
const JSON_EXTS: &[&str] = &["json", "jsonc", "jsonl", "ndjson", "geojson", "har", "ipynb"];

/// Decide how to read a document: extension first, then a peek at the content.
///
/// Anything that is not recognisably JSON falls back to markdown, because plain
/// text is valid markdown and degrades gracefully, whereas feeding prose to the
/// JSON indexer just produces an error.
pub fn detect_kind(name: &str, bytes: &[u8]) -> DocKind {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if JSON_EXTS.contains(&ext.as_str()) {
        return DocKind::Json;
    }
    if MARKDOWN_EXTS.contains(&ext.as_str()) {
        return DocKind::Markdown;
    }
    if looks_like_json(bytes) {
        DocKind::Json
    } else {
        DocKind::Markdown
    }
}

fn looks_like_json(bytes: &[u8]) -> bool {
    let head = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    matches!(
        head.iter().find(|b| !b.is_ascii_whitespace()),
        Some(b'{') | Some(b'[')
    )
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

pub fn fetch_url(url: &str) -> Result<Fetched> {
    let parsed = url::Url::parse(url).map_err(|_| Error::Fetch(format!("주소 형식이 올바르지 않습니다: {url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::Fetch("http 또는 https 주소만 열 수 있습니다.".into()));
    }

    let mut response = ureq::get(parsed.as_str())
        .header("accept", "text/markdown, application/json, text/plain;q=0.9, */*;q=0.5")
        .call()
        .map_err(|e| Error::Fetch(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::Fetch(format!("서버가 {status} 응답을 보냈습니다.")));
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
        .map_err(|e| Error::Fetch(format!("{e} (최대 {}MB)", MAX_URL_BYTES / 1024 / 1024)))?;

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
        .unwrap_or_else(|| url.host_str().unwrap_or("문서").to_owned())
}

/// Content-Type is a hint only: many servers send `text/plain` for .md files
/// and `application/octet-stream` for everything. Trust it when it is specific,
/// otherwise fall back to sniffing.
pub fn kind_from_response(title: &str, content_type: Option<&str>, bytes: &[u8]) -> DocKind {
    let mime = content_type
        .map(|ct| ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();

    match mime.as_str() {
        "application/json" | "application/ld+json" | "text/json" => DocKind::Json,
        "text/markdown" | "text/x-markdown" => DocKind::Markdown,
        _ => detect_kind(title, bytes),
    }
}
