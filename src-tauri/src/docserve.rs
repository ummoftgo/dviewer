//! A bounded, document-scoped loopback origin for active document content.
use std::{collections::HashMap, io::{Cursor, Read}, net::Ipv4Addr, path::{Component, Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, thread::JoinHandle, time::Duration};
use parking_lot::Mutex;
use tauri::Manager;
use subtle::ConstantTimeEq;
use crate::{bytes::SharedBytes, error::{Error, Result, Subject}, state::{AppState, DocId, DocKind}};

pub const MAX_DOCUMENT_BYTES: usize = 64 * 1024 * 1024;
const AGENT: &str = include_str!("../../src/lib/frame/agent.js");
const POLICY: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'self' blob:";
type Response = tiny_http::Response<Box<dyn Read + Send>>;

#[derive(Default)]
struct Served { html: AtomicU64, agent: AtomicU64, resource: AtomicU64 }

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct FrameServed { html: u64, agent: u64, resource: u64 }

#[derive(Clone)]
struct Route { id: DocId, served: Arc<Served> }

impl Route {
    fn new(id: DocId) -> Self { Self { id, served: Arc::new(Served::default()) } }
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
                    serve(&app.state::<AppState>(), &routes, request.url(), app.try_state::<crate::smoke::SmokeRun>().is_some(), &policy)
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
    if doc.kind() != DocKind::Html { return Err(Error::WrongView { subject: Subject::Source }); }
    check_size(doc.bytes().len())?;
    state.doc_server.lock().as_ref().ok_or(Error::FrameServer)?.url(doc_id)
}

#[tauri::command]
pub fn frame_served(state: tauri::State<'_, AppState>, doc_id: DocId) -> Result<FrameServed> {
    state.get(doc_id)?;
    state.doc_server.lock().as_ref().ok_or(Error::FrameServer)?.served(doc_id)
}

fn check_size(len: usize) -> Result<()> {
    if len > MAX_DOCUMENT_BYTES { return Err(Error::TooLarge { subject: Subject::Source, megabytes: len / 1024 / 1024, limit_mb: 64 }); }
    Ok(())
}

fn document_policy(host: &str) -> String {
    POLICY.replace("'self'", &format!("http://{host}"))
}

fn reply(body: Box<dyn Read + Send>, len: usize, mime: &'static str, policy: Option<&str>, probe: bool) -> Response {
    let mut response = tiny_http::Response::new(tiny_http::StatusCode(200), vec![], body, Some(len), None);
    for (name, value) in [("Content-Type", mime), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Access-Control-Allow-Origin", "null")] {
        response.add_header(tiny_http::Header::from_bytes(name, value).expect("static header"));
    }
    if let Some(policy) = policy {
        let policy = if probe { policy.replace("connect-src 'none'", "connect-src http://ipc.localhost") } else { policy.into() };
        response.add_header(tiny_http::Header::from_bytes("Content-Security-Policy", policy).expect("static policy"));
    }
    response
}

fn valid_host(hosts: &[&str], expected: &str) -> bool { hosts == [expected] }

fn not_found() -> Response {
    reply(Box::new(Cursor::new(b"not found")), 9, "text/plain; charset=utf-8", None, false).with_status_code(404)
}

fn serve(state: &AppState, tokens: &Mutex<HashMap<String, Route>>, url: &str, smoke: bool, policy: &str) -> Option<Response> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let (token, relative) = path.strip_prefix('/')?.split_once('/')?;
    // Compare the secret in constant time; the small registry follows open HTML tabs.
    let route = tokens.lock().iter().find_map(|(key, route)| bool::from(key.as_bytes().ct_eq(token.as_bytes())).then(|| route.clone()))?;
    let doc = state.get(route.id).ok()?;
    let snapshot = doc.snapshot();
    if snapshot.kind != DocKind::Html { return None; }
    // Count authenticated requests, not successful delivery or script execution.
    let counter = if relative.is_empty() { &route.served.html }
        else if relative == "_/agent.js" { &route.served.agent } else { &route.served.resource };
    counter.fetch_add(1, Ordering::Relaxed);
    let probe = smoke && query.split('&').any(|part| part == "probe=1");
    if relative == "_/agent.js" {
        return Some(reply(Box::new(Cursor::new(AGENT.as_bytes())), AGENT.len(), "text/javascript; charset=utf-8", None, false));
    }
    if relative.is_empty() {
        check_size(snapshot.bytes.len()).ok()?;
        let tag = format!("<script src=\"/{token}/_/agent.js\"{}></script>", if probe { " data-probe" } else { "" });
        let at = injection_offset(&snapshot.bytes);
        let first = Cursor::new(SharedBytes::new(snapshot.bytes.clone())).take(at as u64);
        let mut tail = Cursor::new(SharedBytes::new(snapshot.bytes.clone()));
        tail.set_position(at as u64);
        let len = snapshot.bytes.len() + tag.len();
        return Some(reply(Box::new(first.chain(Cursor::new(tag.into_bytes())).chain(tail)), len, "text/html; charset=utf-8", Some(policy), probe));
    }
    // Sibling resources belong only to local file documents, never a URL or archive.
    if !matches!(doc.source, crate::state::DocSource::File { .. }) { return None; }
    let file_path = resource_path(doc.base_dir.as_ref()?, relative)?;
    let file = std::fs::File::open(&file_path).ok()?;
    let size = file.metadata().ok()?.len();
    if size > MAX_DOCUMENT_BYTES as u64 { return None; }
    let mime = mime(&file_path);
    Some(reply(Box::new(file.take(size)), size as usize, mime, mime.starts_with("text/html").then_some(policy), false))
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
        "json" => "application/json", "txt" => "text/plain", _ => "application/octet-stream",
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
