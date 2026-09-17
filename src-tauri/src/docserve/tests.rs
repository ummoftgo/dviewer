use super::*;
use crate::{bytes::DocBytes, encoding, state::{Document, DocSource}};

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
    let server = DocServer { host: "127.0.0.1:12345".into(),
        tokens: Arc::new(Mutex::new(HashMap::from([("a".into(), Route::new(1)), ("b".into(), Route::new(2))]))),
        stop: Arc::new(AtomicBool::new(false)), worker: None };
    assert_eq!(server.served(1).unwrap(), FrameServed { html: 0, agent: 0, resource: 0, last: vec![] });
    assert!(serve(&state, &server.tokens, "/wrong/", false, &policy).is_none());
    assert!(serve(&state, &server.tokens, "/a/?g=0", false, &policy).is_some());
    assert!(serve(&state, &server.tokens, "/a/_/agent.js", false, &policy).is_some());
    assert!(serve(&state, &server.tokens, "/a/missing.css", false, &policy).is_none());
    let served = server.served(1).unwrap();
    assert_eq!((served.html, served.agent, served.resource), (1, 1, 1));
    assert_eq!(served.last.iter().map(|item| item.status).collect::<Vec<_>>(), vec![200, 200, 404]);
    assert_eq!(server.served(2).unwrap(), FrameServed { html: 0, agent: 0, resource: 0, last: vec![] });
    assert_eq!(server.url(1).unwrap(), "http://127.0.0.1:12345/a/");
    assert_eq!(server.served(1).unwrap().html, 1);
    server.revoke(1);
    assert!(server.served(1).is_err());
    assert!(serve(&state, &server.tokens, "/a/", false, &policy).is_none());
    let reopened = server.url(1).unwrap();
    assert!(!reopened.ends_with("/a/"));
    assert_eq!(server.served(1).unwrap(), FrameServed { html: 0, agent: 0, resource: 0, last: vec![] });
}

#[test]
fn request_history_keeps_twenty_tokenless_paths_including_missing_pdf_assets() {
    let state = AppState::default();
    let bytes = Arc::new(DocBytes::Owned(b"%PDF-1.7".to_vec()));
    state.insert("main", Document::new(1, "test.pdf".into(), DocSource::Text, None, DocKind::Pdf, bytes.clone(), encoding::verbatim(bytes)));
    let token = "ab".repeat(32);
    let tokens = Mutex::new(HashMap::from([(token.clone(), Route::new(1))]));
    let policy = document_policy("127.0.0.1:12345");
    for index in 0..22 {
        assert!(serve(&state, &tokens, &format!("/{token}/_/pdfjs/web/locale/missing{index}/viewer.ftl?file={token}"), false, &policy).is_none());
    }
    assert!(super::serve(&state, &tokens, &format!("/{token}/"), false, &policy, &["bytes=0-3"], &|_| None).is_some());
    assert!(serve(&state, &tokens, "/wrong/", false, &policy).is_none());
    let served = tokens.lock().get(&token).unwrap().counts();
    assert_eq!(served.last.len(), 20);
    assert_eq!(served.last[0], FrameRequest { sequence: 4, path: "/_/pdfjs/web/locale/missing3/viewer.ftl".into(), status: 404 });
    assert_eq!(served.last.last().unwrap(), &FrameRequest { sequence: 23, path: "/".into(), status: 206 });
    let json = serde_json::to_string(&served).unwrap();
    assert!(!json.contains(&token)); assert!(!json.contains('?'));
    let route = tokens.lock().get(&token).unwrap().clone();
    route.record(&format!("_/{}\n?{token}", "x".repeat(1000)), &token, 404);
    assert_eq!(route.counts().last.last().unwrap().path.len(), 128);
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
    let server = DocServer { host: "127.0.0.1:12345".into(),
        tokens: Arc::new(Mutex::new(HashMap::from([("a".into(), Route::new(1)), ("b".into(), Route::new(2))]))),
        stop: Arc::new(AtomicBool::new(false)), worker: None };
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
