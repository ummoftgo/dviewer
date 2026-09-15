//! A bounded, document-scoped loopback origin for active document content.
use std::{collections::HashMap, io::{Cursor, Read}, net::Ipv4Addr, path::{Component, Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, thread::JoinHandle, time::Duration};
use parking_lot::Mutex;
use tauri::Manager;
use subtle::ConstantTimeEq;
use crate::{bytes::SharedBytes, error::{Error, Result, Subject}, state::{AppState, DocId, DocKind, DocSource}};

pub const MAX_DOCUMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PDF_BYTES: usize = 256 * 1024 * 1024;
const AGENT: &str = include_str!("../../src/lib/frame/agent.js");
const PDF_AGENT: &str = include_str!("../../src/lib/frame/pdf-agent.js");
const POLICY: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'self' blob:";
type Response = tiny_http::Response<Box<dyn Read + Send>>;
mod pdf;
use pdf::{pdf_asset_path, pdf_file_matches, pdf_policy, pdf_response};

#[derive(Default)]
struct Served { html: AtomicU64, agent: AtomicU64, resource: AtomicU64 }

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct FrameServed { html: u64, agent: u64, resource: u64 }

#[derive(Clone)]
struct Route { id: DocId, served: Arc<Served>, external: bool }

impl Route {
    fn new(id: DocId) -> Self { Self { id, served: Arc::new(Served::default()), external: false } }
    fn counts(&self) -> FrameServed {
        FrameServed { html: self.served.html.load(Ordering::Relaxed), agent: self.served.agent.load(Ordering::Relaxed), resource: self.served.resource.load(Ordering::Relaxed) }
    }
}

pub struct DocServer {
    host: String,
    tokens: Arc<Mutex<HashMap<String, Route>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl DocServer {
    pub fn start(app: tauri::AppHandle) -> Result<Self> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(Error::internal)?;
        let host = listener.local_addr().map_err(Error::internal)?.to_string();
        let policy = document_policy(&host);
        let server = tiny_http::Server::from_listener(listener, None).map_err(Error::internal)?;
        let tokens = Arc::new(Mutex::new(HashMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (routes, stopping, expected_host) = (tokens.clone(), stop.clone(), host.clone());
        // AssetResolver falls back to the app's index.html for missing files.
        // Only names produced by the pinned PDF.js preparation may reach it.
        let pdf_assets: std::collections::HashSet<String> = app.asset_resolver().get("pdfjs/manifest.json".into())
            .and_then(|asset| serde_json::from_slice(&asset.bytes).ok()).unwrap_or_default();
        let worker = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let request = match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(request)) => request,
                    Ok(None) => continue,
                    Err(_) => break,
                };
                let headers = request.headers();
                let hosts: Vec<_> = headers.iter().filter(|h| h.field.equiv("Host")).collect();
                let host_ok = valid_host(&hosts.iter().map(|h| h.value.as_str()).collect::<Vec<_>>(), &expected_host);
                let response = if host_ok && request.method() == &tiny_http::Method::Get {
                    let ranges: Vec<_> = headers.iter().filter(|h| h.field.equiv("Range")).map(|h| h.value.as_str()).collect();
                    serve(&app.state::<AppState>(), &routes, request.url(), app.try_state::<crate::smoke::SmokeRun>().is_some(), &policy,
                        &ranges, &|path| if pdf_assets.contains(path) { app.asset_resolver().get(path.to_owned()).map(|asset| asset.bytes) } else { None })
                } else { None };
                let _ = request.respond(response.unwrap_or_else(not_found));
            }
        });
        Ok(Self { host, tokens, stop, worker: Some(worker) })
    }

    pub fn url(&self, id: DocId) -> Result<String> {
        let mut tokens = self.tokens.lock();
        if let Some((token, _)) = tokens.iter().find(|(_, doc)| doc.id == id) {
            return Ok(format!("http://{}/{token}/", self.host));
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(Error::internal)?;
        let token = random.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let url = format!("http://{}/{token}/", self.host);
        tokens.insert(token, Route::new(id));
        Ok(url)
    }

    pub fn revoke(&self, id: DocId) { self.tokens.lock().retain(|_, doc| doc.id != id); }

    fn served(&self, id: DocId) -> Result<FrameServed> {
        self.tokens.lock().values().find(|route| route.id == id).map(Route::counts).ok_or(Error::NoSuchDoc { id })
    }

    fn external(&self, id: DocId, allow: bool) -> Result<()> {
        let mut tokens = self.tokens.lock();
        let route = tokens.values_mut().find(|doc| doc.id == id).ok_or(Error::NoSuchDoc { id })?;
        route.external = allow;
        Ok(())
    }
}

impl Drop for DocServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

#[tauri::command]
pub fn frame_url(state: tauri::State<'_, AppState>, doc_id: DocId) -> Result<String> {
    let doc = state.get(doc_id)?;
    if !matches!(doc.kind(), DocKind::Html | DocKind::Pdf) { return Err(Error::WrongView { subject: Subject::Source }); }
    check_document_size(doc.kind(), doc.bytes().len())?;
    let path = document_path(&doc.source).ok_or(Error::WrongView { subject: Subject::Source })?;
    let base = state.doc_server.lock().as_ref().ok_or(Error::FrameServer)?.url(doc_id)?;
    if doc.kind() == DocKind::Pdf {
        let file = url::Url::parse(&base).map_err(Error::internal)?.path().to_owned();
        return Ok(format!("{base}_/pdfjs/web/viewer.html?file={}", percent_encoding::utf8_percent_encode(&file, percent_encoding::NON_ALPHANUMERIC)));
    }
    Ok(format!("{base}{}", encode_path(&path)))
}

#[tauri::command]
pub fn frame_served(state: tauri::State<'_, AppState>, doc_id: DocId) -> Result<FrameServed> {
    state.get(doc_id)?;
    state.doc_server.lock().as_ref().ok_or(Error::FrameServer)?.served(doc_id)
}

#[tauri::command]
pub fn frame_external(state: tauri::State<'_, AppState>, doc_id: DocId, allow: bool) -> Result<()> {
    let doc = state.get(doc_id)?;
    if !matches!(doc.kind(), DocKind::Html | DocKind::Pdf) { return Err(Error::WrongView { subject: Subject::Source }); }
    state.doc_server.lock().as_ref().ok_or(Error::FrameServer)?.external(doc_id, allow)
}

fn check_size(len: usize) -> Result<()> {
    if len > MAX_DOCUMENT_BYTES { return Err(Error::TooLarge { subject: Subject::Source, megabytes: len / 1024 / 1024, limit_mb: 64 }); }
    Ok(())
}

fn document_policy(host: &str) -> String {
    POLICY.replace("'self'", &format!("http://{host}"))
}

fn check_document_size(kind: DocKind, len: usize) -> Result<()> {
    if kind != DocKind::Pdf { return check_size(len); }
    if len > MAX_PDF_BYTES { return Err(Error::TooLarge { subject: Subject::Source, megabytes: len / 1024 / 1024, limit_mb: 256 }); }
    Ok(())
}

fn archive_path(path: &str) -> Option<String> {
    if path.starts_with('/') || path.contains(['\\', ':']) || path.chars().any(char::is_control) { return None; }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {},
            ".." => { parts.pop()?; },
            _ => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn document_path(source: &DocSource) -> Option<String> {
    match source {
        DocSource::ArchiveEntry { entries, .. } => archive_path(&entries.last()?.name.replace('\\', "/")),
        _ => Some(String::new()),
    }
}

fn encode_path(path: &str) -> String {
    path.split('/').map(|part| percent_encoding::utf8_percent_encode(part, percent_encoding::NON_ALPHANUMERIC).to_string()).collect::<Vec<_>>().join("/")
}

fn response_policy(base: &str, external: bool, probe: bool) -> String {
    let mut policy = base.to_owned();
    if external {
        for directive in ["script-src", "style-src", "img-src", "font-src", "media-src"] {
            policy = policy.replace(&format!("{directive} "), &format!("{directive} https: "));
        }
    }
    let connect = match (external, probe) {
        (false, false) => "'none'", (true, false) => "https:",
        (false, true) => "http://ipc.localhost", (true, true) => "https: http://ipc.localhost",
    };
    policy.replace("connect-src 'none'", &format!("connect-src {connect}"))
}

fn reply(body: Box<dyn Read + Send>, len: usize, mime: &'static str, policy: Option<&str>, external: bool, probe: bool) -> Response {
    let mut response = tiny_http::Response::new(tiny_http::StatusCode(200), vec![], body, Some(len), None);
    for (name, value) in [("Content-Type", mime), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Access-Control-Allow-Origin", "null")] {
        response.add_header(tiny_http::Header::from_bytes(name, value).expect("static header"));
    }
    if let Some(policy) = policy {
        response.add_header(tiny_http::Header::from_bytes("Content-Security-Policy", response_policy(policy, external, probe)).expect("static policy"));
    }
    response
}

fn valid_host(hosts: &[&str], expected: &str) -> bool { hosts == [expected] }

fn not_found() -> Response {
    reply(Box::new(Cursor::new(b"not found")), 9, "text/plain; charset=utf-8", None, false, false).with_status_code(404)
}

fn serve(state: &AppState, tokens: &Mutex<HashMap<String, Route>>, url: &str, smoke: bool, policy: &str,
    ranges: &[&str], asset: &dyn Fn(&str) -> Option<Vec<u8>>) -> Option<Response> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let (token, relative) = path.strip_prefix('/')?.split_once('/')?;
    // Compare the secret in constant time; the small registry follows open HTML tabs.
    let route = tokens.lock().iter().find_map(|(key, route)| bool::from(key.as_bytes().ct_eq(token.as_bytes())).then(|| route.clone()))?;
    let doc = state.get(route.id).ok()?;
    let snapshot = doc.snapshot();
    if !matches!(snapshot.kind, DocKind::Html | DocKind::Pdf) { return None; }
    if snapshot.kind == DocKind::Pdf {
        check_document_size(snapshot.kind, snapshot.bytes.len()).ok()?;
        let probe = smoke && query.split('&').any(|part| part == "probe=1");
        if relative.is_empty() {
            route.served.resource.fetch_add(1, Ordering::Relaxed);
            return Some(pdf_response(snapshot.bytes.clone(), ranges));
        }
        if relative == "_/agent.js" {
            route.served.agent.fetch_add(1, Ordering::Relaxed);
            return Some(reply(Box::new(Cursor::new(AGENT.as_bytes())), AGENT.len(), "text/javascript", None, false, false));
        }
        if relative == "_/pdf-agent.js" {
            route.served.agent.fetch_add(1, Ordering::Relaxed);
            return Some(reply(Box::new(Cursor::new(PDF_AGENT.as_bytes())), PDF_AGENT.len(), "text/javascript", None, false, false));
        }
        let path = pdf_asset_path(relative)?;
        let viewer = path == "pdfjs/web/viewer.html";
        if viewer && !pdf_file_matches(query, token) { return None; }
        let mut bytes = asset(&path)?;
        if viewer {
            route.served.html.fetch_add(1, Ordering::Relaxed);
            let tag = format!("<script src=\"/{token}/_/agent.js\" data-pdf{}></script><script src=\"/{token}/_/pdf-agent.js\"></script>", if probe { " data-probe" } else { "" });
            let at = injection_offset(&bytes);
            bytes.splice(at..at, tag.bytes());
        } else { route.served.resource.fetch_add(1, Ordering::Relaxed); }
        let len = bytes.len();
        let policy = pdf_policy(policy, route.external, probe);
        return Some(reply(Box::new(Cursor::new(bytes)), len, mime(Path::new(&path)), viewer.then_some(policy.as_str()), false, false));
    }
    let entry = matches!(doc.source, DocSource::ArchiveEntry { .. });
    let name = if entry && relative != "_/agent.js" {
        archive_path(&percent_encoding::percent_decode_str(relative).decode_utf8().ok()?)?
    } else { relative.to_owned() };
    let main = name == document_path(&doc.source)?;
    // Count authenticated requests, not successful delivery or script execution.
    let counter = if main { &route.served.html }
        else if relative == "_/agent.js" { &route.served.agent } else { &route.served.resource };
    counter.fetch_add(1, Ordering::Relaxed);
    let probe = smoke && query.split('&').any(|part| part == "probe=1");
    if relative == "_/agent.js" {
        return Some(reply(Box::new(Cursor::new(AGENT.as_bytes())), AGENT.len(), "text/javascript; charset=utf-8", None, false, false));
    }
    if main {
        check_size(snapshot.bytes.len()).ok()?;
        let tag = format!("<script src=\"/{token}/_/agent.js\"{}></script>", if probe { " data-probe" } else { "" });
        let at = injection_offset(&snapshot.bytes);
        let first = Cursor::new(SharedBytes::new(snapshot.bytes.clone())).take(at as u64);
        let mut tail = Cursor::new(SharedBytes::new(snapshot.bytes.clone()));
        tail.set_position(at as u64);
        let len = snapshot.bytes.len() + tag.len();
        return Some(reply(Box::new(first.chain(Cursor::new(tag.into_bytes())).chain(tail)), len, "text/html; charset=utf-8", Some(policy), route.external, probe));
    }
    if entry {
        let archive = state.frame_archive(doc.id)?;
        let sibling = archive.listing().entries.iter().find(|sibling| archive_path(&sibling.name.replace('\\', "/")).as_deref() == Some(&name))?;
        let bytes = archive.read_entry_limited(sibling.index, MAX_DOCUMENT_BYTES).ok()?;
        let len = bytes.len();
        let mime = mime(Path::new(&name));
        return Some(reply(Box::new(Cursor::new(bytes)), len, mime, mime.starts_with("text/html").then_some(policy), route.external, false));
    }
    if !matches!(doc.source, DocSource::File { .. }) { return None; }
    let file_path = resource_path(doc.base_dir.as_ref()?, relative)?;
    let file = std::fs::File::open(&file_path).ok()?;
    let size = file.metadata().ok()?.len();
    if size > MAX_DOCUMENT_BYTES as u64 { return None; }
    let mime = mime(&file_path);
    Some(reply(Box::new(file.take(size)), size as usize, mime, mime.starts_with("text/html").then_some(policy), route.external, false))
}

fn resource_path(base: &Path, encoded: &str) -> Option<PathBuf> {
    // URL decoding precedes traversal checks, including encoded slashes and dots.
    let decoded = percent_encoding::percent_decode_str(encoded).decode_utf8().ok()?;
    if decoded.contains(['\\', '\0', ':']) { return None; }
    let mut path = base.to_path_buf();
    for component in Path::new(decoded.as_ref()).components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => continue,
            Component::ParentDir if path != base => { path.pop(); continue; },
            _ => return None,
        }
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if metadata.file_type().is_symlink() { return None; }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 { return None; }
        }
    }
    if !path.is_file() || !path.canonicalize().ok()?.starts_with(base.canonicalize().ok()?) { return None; }
    Some(path)
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
        "css" => "text/css", "js" | "mjs" => "text/javascript", "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "svg" => "image/svg+xml",
        "webp" => "image/webp", "woff2" => "font/woff2", "woff" => "font/woff", "ttf" => "font/ttf",
        "json" => "application/json", "txt" | "ftl" => "text/plain", "pdf" => "application/pdf",
        "wasm" => "application/wasm", "pfb" => "application/x-font-type1", _ => "application/octet-stream",
    }
}

fn injection_offset(bytes: &[u8]) -> usize {
    let mut cursor = 0;
    let mut fallback = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 };
    while cursor < bytes.len() {
        let Some(next) = bytes[cursor..].iter().position(|b| *b == b'<') else { break; };
        let start = cursor + next;
        if bytes[start..].starts_with(b"<!--") {
            let Some(end) = bytes[start + 4..].windows(3).position(|s| s == b"-->") else { break; };
            cursor = start + 4 + end + 3;
            continue;
        }
        let mut end = start + 1;
        let mut quote = 0;
        while end < bytes.len() {
            let b = bytes[end];
            if quote != 0 { if b == quote { quote = 0; } }
            else if b == b'\'' || b == b'"' { quote = b; }
            else if b == b'>' { break; }
            end += 1;
        }
        if bytes.get(start..start + 9).is_some_and(|tag| tag.eq_ignore_ascii_case(b"<!doctype")) && end < bytes.len() { fallback = end + 1; }
        if [b"script".as_slice(), b"style", b"title"].iter().any(|name| bytes.get(start + 1..start + 1 + name.len()).is_some_and(|tag| tag.eq_ignore_ascii_case(name))) { break; }
        let name = bytes.get(start + 1..start + 5);
        if name.is_some_and(|name| name.eq_ignore_ascii_case(b"head"))
            && bytes.get(start + 5).is_some_and(|b| b.is_ascii_whitespace() || *b == b'>') && end < bytes.len() { return end + 1; }
        if bytes.get(start + 1..start + 5).is_some_and(|name| name.eq_ignore_ascii_case(b"body")) { break; }
        cursor = end + 1;
    }
    fallback
}

#[cfg(test)]
mod tests;
