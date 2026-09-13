use super::*;
use crate::{bytes::DocBytes, encoding, state::{Document, DocSource}};

fn document(state: &AppState, id: DocId, data: &[u8]) {
    let bytes = Arc::new(DocBytes::Owned(data.to_vec()));
    state.insert("main", Document::new(id, "test.html".into(), DocSource::Text, None, DocKind::Html, bytes.clone(), encoding::decode(bytes)));
}

#[test]
fn token_and_document_lifetime_bound_the_route() {
    let state = AppState::default(); document(&state, 1, b"<head></head>ok");
    let tokens = Mutex::new(HashMap::from([("token-a".into(), Route::new(1))]));
    assert!(serve(&state, &tokens, "/token-a/", false).is_some());
    for path in ["/", "/1/", "/token-b/", "/token-a-other/", "/token-a/../token-b/"] {
        assert!(serve(&state, &tokens, path, false).is_none(), "{path}");
    }
    let refused = not_found();
    assert!(refused.headers().iter().any(|h| h.field.equiv("Referrer-Policy") && h.value.as_str() == "no-referrer"));
    assert!(refused.headers().iter().any(|h| h.field.equiv("Cache-Control") && h.value.as_str() == "no-store"));
    state.remove(1);
    assert!(serve(&state, &tokens, "/token-a/", false).is_none());
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
    let state = AppState::default(); document(&state, 1, b"<head></head>");
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(1))]));
    for (smoke, url, allowed) in [(false,"/a/?probe=1",false),(true,"/a/",false),(true,"/a/?probe=1",true)] {
        let response = serve(&state, &tokens, url, smoke).unwrap();
        let policy = response.headers().iter().find(|h| h.field.equiv("Content-Security-Policy")).unwrap().value.as_str();
        assert_eq!(policy.contains("connect-src http://ipc.localhost"), allowed);
        let mut html = String::new(); response.into_reader().read_to_string(&mut html).unwrap();
        assert_eq!(html.contains(" data-probe"), allowed);
    }
}

#[test]
fn html_streams_utf8_with_injection_without_changing_the_snapshot() {
    let state = AppState::default(); document(&state, 1, &[0xff,0xfe,b'<',0,b'h',0,b'1',0,b'>',0,b'A',0]);
    let tokens = Mutex::new(HashMap::from([("a".into(), Route::new(1))]));
    let doc = state.get(1).unwrap();
    let response = serve(&state, &tokens, "/a/", false).unwrap();
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
    let state = AppState::default();
    document(&state, 1, b"<head></head>"); document(&state, 2, b"<head></head>");
    let server = DocServer { host: "127.0.0.1:12345".into(),
        tokens: Arc::new(Mutex::new(HashMap::from([("a".into(), Route::new(1)), ("b".into(), Route::new(2))]))),
        stop: Arc::new(AtomicBool::new(false)), worker: None };
    assert_eq!(server.served(1).unwrap(), FrameServed { html: 0, agent: 0, resource: 0 });
    assert!(serve(&state, &server.tokens, "/wrong/", false).is_none());
    assert!(serve(&state, &server.tokens, "/a/?g=0", false).is_some());
    assert!(serve(&state, &server.tokens, "/a/_/agent.js", false).is_some());
    assert!(serve(&state, &server.tokens, "/a/missing.css", false).is_none());
    assert_eq!(server.served(1).unwrap(), FrameServed { html: 1, agent: 1, resource: 1 });
    assert_eq!(server.served(2).unwrap(), FrameServed { html: 0, agent: 0, resource: 0 });
    assert_eq!(server.url(1).unwrap(), "http://127.0.0.1:12345/a/");
    assert_eq!(server.served(1).unwrap().html, 1);
    server.revoke(1);
    assert!(server.served(1).is_err());
    assert!(serve(&state, &server.tokens, "/a/", false).is_none());
    let reopened = server.url(1).unwrap();
    assert!(!reopened.ends_with("/a/"));
    assert_eq!(server.served(1).unwrap(), FrameServed { html: 0, agent: 0, resource: 0 });
}
