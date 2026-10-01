use super::*;
use crate::{bytes::DocBytes, encoding, state::{Document, DocSource}};

fn test_server() -> DocServer {
    let tokens = HashMap::from([("a".into(), Route::new(1)), ("b".into(), Route::new(2))]);
    let summaries = Arc::new(Mutex::new(tokens.values().map(|route| (route.id, route.clone())).collect()));
    DocServer { host: "127.0.0.1:12345".into(), tokens: Arc::new(Mutex::new(tokens)),
        stop: Arc::new(AtomicBool::new(false)), worker: None,
        diagnostics: Arc::new(Diagnostics::default()), summaries }
}

fn assert_empty(served: &FrameServed) {
    assert_eq!((served.html, served.agent, served.resource), (Some(0), Some(0), Some(0)));
    assert!(served.registry_available);
    assert!(served.last.is_empty());
}

fn traced_response(server: &DocServer, state: &AppState, url: &str, ranges: &[&str]) -> Response {
    let trace = server.diagnostics.received();
    trace.record_path(url);
    let mut result = None;
    process_request(&trace, (), |_| serve_traced(state, &server.tokens, url, false, &document_policy(&server.host),
        ranges, &|_| None, Some(&trace), None).unwrap_or_else(not_found), |_, response| { result = Some(response); Ok(()) });
    result.unwrap()
}


fn serve(state: &AppState, tokens: &Mutex<HashMap<String, Route>>, url: &str, smoke: bool, policy: &str) -> Option<Response> {
    super::serve(state, tokens, url, smoke, policy, &[], &|_| None)
}

fn document(state: &AppState, id: DocId, data: &[u8]) {
    let bytes = Arc::new(DocBytes::Owned(data.to_vec()));
    state.insert("main", Document::new(id, "test.html".into(), DocSource::Text, None, DocKind::Html, bytes.clone(), encoding::decode(bytes)));
}

#[test]
fn token_and_document_lifetime_bound_the_route() {
    let policy = document_policy("127.0.0.1:12345");
    let state = AppState::default(); document(&state, 1, b"<head></head>ok");
    let tokens = Mutex::new(HashMap::from([("token-a".into(), Route::new(1))]));
    assert!(serve(&state, &tokens, "/token-a/", false, &policy).is_some());
    for path in ["/", "/1/", "/token-b/", "/token-a-other/", "/token-a/../token-b/"] {
        assert!(serve(&state, &tokens, path, false, &policy).is_none(), "{path}");
    }
    let refused = not_found();
    assert!(refused.headers().iter().any(|h| h.field.equiv("Referrer-Policy") && h.value.as_str() == "no-referrer"));
    assert!(refused.headers().iter().any(|h| h.field.equiv("Cache-Control") && h.value.as_str() == "no-store"));
    state.remove(1);
    assert!(serve(&state, &tokens, "/token-a/", false, &policy).is_none());
}

#[test]
fn only_the_exact_single_host_is_accepted() {
    assert!(valid_host(&["127.0.0.1:3456"], "127.0.0.1:3456"));
    for hosts in [vec![], vec!["localhost:3456"], vec!["127.0.0.1:3457"], vec!["evil:3456"], vec!["127.0.0.1:3456", "127.0.0.1:3456"]] {
        assert!(!valid_host(&hosts, "127.0.0.1:3456"));
    }
}

#[test]
fn resource_paths_decode_then_stay_under_the_parent() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("root");
    std::fs::create_dir_all(base.join("assets")).unwrap();
    std::fs::write(base.join("한 글.css"), "body{}").unwrap();
    std::fs::write(temp.path().join("outside.css"), "private").unwrap();
    assert_eq!(resource_path(&base, "%ED%95%9C%20%EA%B8%80.css"), Some(base.join("한 글.css")));
    assert_eq!(resource_path(&base, "assets/../%ED%95%9C%20%EA%B8%80.css"), Some(base.join("한 글.css")));
    for path in ["../outside.css", "%2e%2e/outside.css", "/outside.css", "C:/outside.css", "assets/%2e%2e/%2e%2e/outside.css", "..%5coutside.css", "a%00.css"] {
        assert!(resource_path(&base, path).is_none(), "{path}");
    }
    #[cfg(unix)] {
        std::os::unix::fs::symlink(temp.path().join("outside.css"), base.join("link.css")).unwrap();
        assert!(resource_path(&base, "link.css").is_none());
    }
}

#[test]
fn the_probe_policy_requires_smoke_state_and_query_together() {
    let policy = document_policy("127.0.0.1:12345");
    let state = AppState::default(); document(&state, 1, b"<head></head>");
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(1))]));
    for (smoke, url, allowed) in [(false,"/a/?probe=1",false),(true,"/a/",false),(true,"/a/?probe=1",true)] {
        let response = serve(&state, &tokens, url, smoke, &policy).unwrap();
        let policy = response.headers().iter().find(|h| h.field.equiv("Content-Security-Policy")).unwrap().value.as_str();
        assert_eq!(policy.contains("connect-src http://ipc.localhost"), allowed);
        let mut html = String::new(); response.into_reader().read_to_string(&mut html).unwrap();
        assert_eq!(html.contains(" data-probe"), allowed);
    }
}

#[test]
fn html_streams_utf8_with_injection_without_changing_the_snapshot() {
    let policy = document_policy("127.0.0.1:12345");
    let state = AppState::default(); document(&state, 1, &[0xff,0xfe,b'<',0,b'h',0,b'1',0,b'>',0,b'A',0]);
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(1))]));
    let doc = state.get(1).unwrap();
    let response = serve(&state, &tokens, "/a/", false, &policy).unwrap();
    assert!(response.headers().iter().any(|h| h.field.equiv("Content-Type") && h.value.as_str() == "text/html; charset=utf-8"));
    let mut html = String::new(); response.into_reader().read_to_string(&mut html).unwrap();
    assert!(html.contains("<h1>A")); assert!(html.contains("/a/_/agent.js"));
    assert_eq!(&**doc.bytes(), b"<h1>A");
    assert!(doc.line_index(0, &AtomicBool::new(false)).is_ok());
}

#[test]
fn head_insertion_skips_comments_and_quoted_angles() {
    for (html, prefix) in [
        ("<head><title>x</title>", "<head>"),
        ("<HEAD data-x='>'>x", "<HEAD data-x='>'>"),
        ("<!-- <head> --><head>x", "<!-- <head> --><head>"),
        ("<!doctype html><body>x", "<!doctype html>"),
        ("<script>const x='<head>';</script>", ""),
    ] { assert_eq!(injection_offset(html.as_bytes()), prefix.len(), "{html}"); }
}

#[test]
fn mime_and_size_are_explicit() {
    for (name, expected) in [("a.HTML","text/html; charset=utf-8"),("a.mjs","text/javascript"),("a.woff2","font/woff2"),("a.css","text/css"),("a.png","image/png"),("a.unknown","application/octet-stream")] {
        assert_eq!(mime(Path::new(name)),expected);
    }
    assert!(check_size(MAX_DOCUMENT_BYTES).is_ok());
    assert!(check_size(MAX_DOCUMENT_BYTES+1).is_err());
}

#[test]
fn request_counters_follow_each_document_route_and_its_lifetime() {
    let policy = document_policy("127.0.0.1:12345");
    let state = AppState::default();
    document(&state, 1, b"<head></head>"); document(&state, 2, b"<head></head>");
    let server = test_server();
    assert_empty(&server.served(1).unwrap());
    assert!(serve(&state, &server.tokens, "/wrong/", false, &policy).is_none());
    assert_eq!(traced_response(&server, &state, "/a/?g=0", &[]).status_code().0, 200);
    assert_eq!(traced_response(&server, &state, "/a/_/agent.js", &[]).status_code().0, 200);
    assert_eq!(traced_response(&server, &state, "/a/missing.css", &[]).status_code().0, 404);
    let served = server.served(1).unwrap();
    assert_eq!((served.html, served.agent, served.resource), (Some(1), Some(1), Some(1)));
    assert_eq!(served.last.iter().map(|item| item.status).collect::<Vec<_>>(), vec![Some(200), Some(200), Some(404)]);
    assert_empty(&server.served(2).unwrap());
    assert_eq!(server.url(1).unwrap(), "http://127.0.0.1:12345/a/");
    assert_eq!(server.served(1).unwrap().html, Some(1));
    server.revoke(1);
    assert!(server.served(1).is_err());
    assert!(serve(&state, &server.tokens, "/a/", false, &policy).is_none());
    let reopened = server.url(1).unwrap();
    assert!(!reopened.ends_with("/a/"));
    assert_empty(&server.served(1).unwrap());
}

#[test]
fn request_history_keeps_twenty_safe_paths_including_missing_pdf_assets() {
    let state = AppState::default();
    let bytes = Arc::new(DocBytes::Owned(b"%PDF-1.7".to_vec()));
    state.insert("main", Document::new(1, "test.pdf".into(), DocSource::Text, None, DocKind::Pdf, bytes.clone(), encoding::verbatim(bytes)));
    let server = test_server();
    for index in 0..22 {
        let response = traced_response(&server, &state, &format!("/a/_/pdfjs/web/locale/private{index}/viewer.ftl?file=secret"), &[]);
        assert_eq!(response.status_code().0, 404);
    }
    assert_eq!(traced_response(&server, &state, "/a/", &["bytes=0-3"]).status_code().0, 206);
    assert_eq!(traced_response(&server, &state, "/wrong/", &[]).status_code().0, 404);
    let served = server.served(1).unwrap();
    assert_eq!(served.last.len(), 20);
    assert_eq!((served.last[0].sequence, served.last[0].path.as_str(), served.last[0].status),
        (4, "/_/pdfjs/web/locale/[asset]", Some(404)));
    let last = served.last.last().unwrap();
    assert_eq!((last.sequence, last.path.as_str(), last.status, last.content_length), (23, "/", Some(206), Some(4)));
    assert!(served.last.iter().all(|request| request.doc_id == Some(1) && request.generation == Some(0)));
    assert_eq!(served.server.requests.last().unwrap().doc_id, None);
    let json = serde_json::to_string(&served).unwrap();
    assert!(!json.contains("private")); assert!(!json.contains("secret")); assert!(!json.contains('?'));
    server.revoke(1);
    assert_eq!(served.last.len(), 20); // A captured value survives later revocation.
    server.url(1).unwrap();
    assert_empty(&server.served(1).unwrap());
}

#[test]
fn opaque_documents_get_an_explicit_server_origin_in_the_response_policy() {
    let state = AppState::default(); document(&state, 1, b"<head></head>");
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(1))]));
    for host in ["127.0.0.1:12345", "127.0.0.1:54321"] {
        let policy = document_policy(host);
        for probe in [false, true] {
            let response = serve(&state, &tokens, "/a/?probe=1", probe, &policy).unwrap();
            let csp = response.headers().iter().find(|h| h.field.equiv("Content-Security-Policy")).unwrap().value.as_str();
            for directive in ["script-src", "style-src", "img-src", "font-src", "media-src", "worker-src"] {
                let value = csp.split("; ").find(|value| value.starts_with(&format!("{directive} "))).unwrap();
                assert!(value.split(' ').any(|source| source == format!("http://{host}")), "{directive}");
            }
            assert!(!csp.contains("'self'"));
            assert!(!csp.contains('*'));
            assert!(csp.contains("frame-src 'none'; form-action 'none'; base-uri 'none'"));
            assert_eq!(csp.contains("connect-src http://ipc.localhost"), probe);
            assert_eq!(csp.contains("connect-src 'none'"), !probe);
        }
    }
}

#[test]
fn external_permission_is_document_scoped_and_preserves_the_probe_policy() {
    let state = AppState::default();
    document(&state, 1, b"<head></head>"); document(&state, 2, b"<head></head>");
    let server = test_server();
    let base = document_policy(&server.host);
    let header = |id, probe| {
        let path = if id == 1 { "/a/?probe=1" } else { "/b/?probe=1" };
        let response = serve(&state, &server.tokens, path, probe, &base).unwrap();
        response.headers().iter().find(|h| h.field.equiv("Content-Security-Policy")).unwrap().value.to_string()
    };
    assert_eq!(header(1, false), base);
    server.external(1, true).unwrap();
    for probe in [false, true] {
        let policy = header(1, probe);
        for directive in ["script-src", "style-src", "img-src", "font-src", "media-src"] {
            assert!(policy.contains(&format!("{directive} https: http://127.0.0.1:12345")));
        }
        assert!(policy.contains("connect-src https:"));
        assert_eq!(policy.contains("http://ipc.localhost"), probe);
        assert!(policy.contains("frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src http://127.0.0.1:12345 blob:"));
        assert!(!policy.contains("unsafe-eval"));
        assert_eq!(header(2, false), base);
    }
    server.url(1).unwrap();
    assert!(header(1, false).contains("https:"));
    server.external(1, false).unwrap();
    assert_eq!(header(1, false), base);
    server.external(1, true).unwrap(); server.revoke(1);
    assert!(server.external(1, false).is_err());
    server.url(1).unwrap();
    assert!(!server.tokens.lock().values().find(|route| route.id == 1).unwrap().external);
}

#[test]
fn archive_paths_preserve_directories_but_never_climb_above_the_root() {
    assert_eq!(archive_path("docs/../shared.css").as_deref(), Some("shared.css"));
    assert_eq!(archive_path("./docs//page.html").as_deref(), Some("docs/page.html"));
    let path = "문서/한 글#?%.html";
    let encoded = encode_path(path);
    assert!(encoded.contains('/'));
    assert_eq!(percent_encoding::percent_decode_str(&encoded).decode_utf8().unwrap(), path);
    for path in ["../outside.css", "docs/../../outside.css", "/outside.css", "C:/outside.css", "docs\\page.css", "bad\0.css", ""] {
        assert!(archive_path(path).is_none(), "{path}");
    }
}

#[test]
fn archive_siblings_need_a_direct_file_parent_in_the_same_window() {
    use crate::archive::{ArchiveDoc, fixtures::{stored, zip_bytes}};
    let state = AppState::default();
    let root = DocSource::File { path: "bundle.zip".into() };
    let bytes = zip_bytes(vec![stored(b"docs/page.html", b"<head></head>", 0),
        stored(b"docs/page.css", b"body{color:red}", 0), stored(b"shared.css", b"body{margin:0}", 0)]);
    let parent = |id, window, source: DocSource| {
        let doc = Document::new(id, "bundle.zip".into(), source, None, DocKind::Zip, bytes.clone(), encoding::verbatim(bytes.clone()));
        doc.set_archive(0, Arc::new(ArchiveDoc::open(bytes.clone()).unwrap())).unwrap();
        state.insert(window, doc);
    };
    let child = |id, source: DocSource| {
        let bytes = Arc::new(DocBytes::Owned(b"<head></head>".to_vec()));
        state.insert("main", Document::new(id, "page.html".into(), source, None, DocKind::Html, bytes.clone(), encoding::decode(bytes)));
    };
    let source = root.entry(0, "docs/page.html".into()).unwrap();
    assert_eq!(document_path(&source).as_deref(), Some("docs/page.html"));
    parent(1, "main", root.clone()); parent(2, "other-window", root.clone()); child(3, source);
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(3))]));
    let policy = document_policy("127.0.0.1:12345");
    assert!(serve(&state, &tokens, "/a/docs/page%2Ehtml", false, &policy).is_some());
    for (path, expected) in [("/a/docs/page.css", "body{color:red}"), ("/a/docs/../shared.css", "body{margin:0}")] {
        let response = serve(&state, &tokens, path, false, &policy).unwrap();
        assert!(response.headers().iter().any(|h| h.field.equiv("Content-Type") && h.value.as_str() == "text/css"));
        let mut body = String::new(); response.into_reader().read_to_string(&mut body).unwrap();
        assert_eq!(body, expected);
    }
    for path in ["/a/docs/%2e%2e/%2e%2e/shared.css", "/a/../shared.css", "/a/missing.css"] {
        assert!(serve(&state, &tokens, path, false, &policy).is_none());
    }
    state.remove(1);
    assert!(serve(&state, &tokens, "/a/docs/page.css", false, &policy).is_none());
    assert!(serve(&state, &tokens, "/a/docs/page.html", false, &policy).is_some());
    let nested = root.entry(4, "inner.zip".into()).unwrap();
    parent(4, "main", nested.clone()); child(5, nested.entry(0, "docs/page.html".into()).unwrap());
    let remote = DocSource::Url { url: "https://example.test/bundle.zip".into() };
    parent(6, "main", remote.clone()); child(7, remote.entry(0, "docs/page.html".into()).unwrap());
    for id in [5, 7] {
        assert!(state.frame_archive(id).is_none());
        let tokens = Mutex::new(HashMap::from([("b".into(), Route::new(id))]));
        assert!(serve(&state, &tokens, "/b/docs/page.html", false, &policy).is_some());
        assert!(serve(&state, &tokens, "/b/docs/page.css", false, &policy).is_none());
    }
}

#[test]
fn resource_decompression_stops_at_the_callers_limit() {
    use crate::archive::{ArchiveDoc, fixtures::{crc32, deflated, zip_of}};
    let body = b"12345678";
    let archive = ArchiveDoc::open(zip_of(&[(deflated(b"page.css", body), crc32(body))])).unwrap();
    assert!(matches!(archive.read_entry_limited(0, 4), Err(Error::TooLarge { .. })));
    assert_eq!(archive.read_entry_limited(0, body.len()).unwrap(), body);
    assert_eq!(archive.read_entry(0).unwrap(), body);
}

// The network result is only tiny_http's return value. A broken connection can
// be normalized to Ok by tiny_http 0.12, so this must never be called "sent".
#[test]
fn response_return_result_is_explicit_and_not_a_delivery_claim() {
    let observations = Arc::new(Diagnostics::default());
    let trace = observations.received();
    trace.record_path("/token/_/pdfjs/web/viewer.mjs?secret=1");
    process_request(&trace, (), |_| not_found(), |_, _| Err(std::io::ErrorKind::BrokenPipe.into()));
    let snapshot = observations.snapshot();
    let request = &snapshot.requests[0];
    assert_eq!(request.respond_result, Some("error"));
    assert_eq!(request.respond_error_kind.as_deref(), Some("BrokenPipe"));
    assert!(request.respond_returned_at_ms.is_some());
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("sent"));
    assert!(json.contains("\"respondResult\":\"error\""));
}

// Pause the exact production helper inside each callback. A diagnostic query
// must finish while the worker remains paused, not only after it is released.
#[test]
fn paused_build_and_write_remain_independently_observable() {
    use std::sync::mpsc;
    for pause_build in [true, false] {
        let server = Arc::new(test_server());
        let worker_server = server.clone();
        let (paused_tx, paused_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let trace = worker_server.diagnostics.received();
            trace.record_path("/a/_/pdfjs/web/viewer.mjs");
            process_request(&trace, (), |_| {
                if pause_build { paused_tx.send(()).unwrap(); resume_rx.recv().unwrap(); }
                not_found()
            }, |_, _| {
                if !pause_build { paused_tx.send(()).unwrap(); resume_rx.recv().unwrap(); }
                Ok(())
            });
        });
        paused_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let observer_server = server.clone();
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let observer = std::thread::spawn(move || { snapshot_tx.send(observer_server.served(1)).unwrap(); });
        let observed = snapshot_rx.recv_timeout(Duration::from_secs(3));
        // Release even on a regression so the test fails instead of hanging.
        resume_tx.send(()).unwrap();
        worker.join().unwrap(); observer.join().unwrap();
        let snapshot = observed.expect("diagnostics blocked on response work").unwrap();
        let request = &snapshot.server.requests[0];
        assert_eq!(snapshot.server.phase, if pause_build { "response-build-enter" } else { "respond-enter" });
        assert!(request.build_entered_at_ms.is_some());
        assert_eq!(request.built_at_ms.is_none(), pause_build);
        assert_eq!(request.respond_entered_at_ms.is_none(), pause_build);
        assert!(request.respond_returned_at_ms.is_none());
        assert_eq!(server.served(1).unwrap().server.requests[0].respond_result, Some("ok"));
    }
}

#[test]
fn receive_and_diagnostic_query_do_not_need_the_token_registry_lock() {
    use std::sync::mpsc;
    let server = Arc::new(test_server());
    let tokens = server.tokens.lock();
    let worker_server = server.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let state = AppState::default(); document(&state, 1, b"<head></head>");
        let trace = worker_server.diagnostics.received();
        trace.record_path("/a/");
        assert_eq!(worker_server.diagnostics.snapshot().phase, "recv-returned");
        process_request(&trace, (), |_| {
            entered_tx.send(()).unwrap();
            serve_traced(&state, &worker_server.tokens, "/a/", false, &document_policy(&worker_server.host),
                &[], &|_| None, Some(&trace), None).unwrap()
        }, |_, _| Ok(()));
    });
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let observer_server = server.clone();
    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let observer = std::thread::spawn(move || { snapshot_tx.send(observer_server.served(1)).unwrap(); });
    let observed = snapshot_rx.recv_timeout(Duration::from_secs(3));
    drop(tokens);
    worker.join().unwrap(); observer.join().unwrap();
    let snapshot = observed.expect("diagnostics waited on the token registry").unwrap();
    assert_eq!(snapshot.server.phase, "response-build-enter");
    assert_eq!(snapshot.server.requests[0].doc_id, None);
    assert!(snapshot.server.requests[0].built_at_ms.is_none());
    let served = server.served(1).unwrap();
    assert_eq!((served.last[0].doc_id, served.last[0].generation), (Some(1), Some(0)));
}


#[test]
fn independent_diagnostics_survive_outer_server_lock_waiting_on_tokens() {
    use std::sync::mpsc;
    let state = Arc::new(AppState::default());
    let server = test_server();
    let diagnostics = server.diagnostic_handle();
    let token_registry = server.tokens.clone();
    *state.doc_server.lock() = Some(server);
    let held_tokens = token_registry.lock();
    let worker_state = state.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let registrar = std::thread::spawn(move || {
        let server = worker_state.doc_server.lock();
        entered_tx.send(()).unwrap();
        server.as_ref().unwrap().url(3).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let observer = std::thread::spawn(move || { snapshot_tx.send(diagnostics.served(1)).unwrap(); });
    let observed = snapshot_rx.recv_timeout(Duration::from_secs(3));
    drop(held_tokens);
    registrar.join().unwrap(); observer.join().unwrap();
    let snapshot = observed.expect("diagnostics waited for outer server/token locks").unwrap();
    assert!(snapshot.registry_available);
    assert_eq!(snapshot.server.phase, "starting");
}

#[test]
fn busy_summary_index_keeps_health_and_marks_counters_unknown() {
    let server = test_server();
    let trace = server.diagnostics.received();
    trace.record_path("/a/");
    trace.build_enter();
    let held = server.summaries.lock();
    let snapshot = server.diagnostic_handle().served(1).unwrap();
    assert!(!snapshot.registry_available);
    assert_eq!((snapshot.html, snapshot.agent, snapshot.resource), (None, None, None));
    assert!(snapshot.last.is_empty());
    assert_eq!(snapshot.server.phase, "response-build-enter");
    assert_eq!(snapshot.server.active_request_id, Some(1));
    drop(held);
    assert!(server.served(1).unwrap().registry_available);
}
