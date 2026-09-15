use super::*;

pub(super) fn pdf_policy(base: &str, external: bool, probe: bool) -> String {
    let policy = response_policy(base, external, probe);
    let origin = base.split("script-src ").nth(1).and_then(|s| s.split(' ').next()).expect("document policy origin");
    let policy = policy.replace("script-src ", "script-src 'wasm-unsafe-eval' ");
    if policy.contains("connect-src 'none'") { policy.replace("connect-src 'none'", &format!("connect-src {origin}")) }
    else { policy.replace("connect-src ", &format!("connect-src {origin} ")) }
}

pub(super) fn pdf_file_matches(query: &str, token: &str) -> bool {
    let files: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key == "file").map(|(_, value)| value).collect();
    files.len() == 1 && files[0] == format!("/{token}/")
}

pub(super) fn pdf_asset_path(relative: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(relative.strip_prefix("_/pdfjs/")?).decode_utf8().ok()?;
    if decoded.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || decoded.contains(['\\', ':']) || decoded.chars().any(char::is_control) { return None; }
    let allowed = matches!(decoded.as_ref(), "build/pdf.mjs" | "build/pdf.worker.mjs" | "build/pdf.sandbox.mjs"
        | "web/viewer.html" | "web/viewer.css" | "web/viewer.mjs" | "web/locale/locale.json")
        || ["web/images/", "web/cmaps/", "web/standard_fonts/", "web/wasm/", "web/iccs/"].iter().any(|prefix| decoded.starts_with(prefix))
        || ["en-US", "ko", "ja", "zh-CN"].iter().any(|lang| decoded == format!("web/locale/{lang}/viewer.ftl"));
    allowed.then(|| format!("pdfjs/{decoded}"))
}

// A single byte range, with an exclusive end. Refuse ambiguous/multipart requests.
fn byte_range(headers: &[&str], len: usize) -> std::result::Result<Option<std::ops::Range<usize>>, ()> {
    if headers.is_empty() { return Ok(None); }
    if headers.len() != 1 || len == 0 { return Err(()); }
    let (start, end) = headers[0].strip_prefix("bytes=").ok_or(())?.split_once('-').ok_or(())?;
    let number = |s: &str| -> std::result::Result<usize, ()> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) { return Err(()); }
        s.parse().map_err(|_| ())
    };
    if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 { return Err(()); }
        return Ok(Some(len.saturating_sub(suffix)..len));
    }
    let start = number(start)?;
    let end = if end.is_empty() { len - 1 } else { number(end)?.min(len - 1) };
    if start >= len || end < start { return Err(()); }
    Ok(Some(start..end + 1))
}

pub(super) fn pdf_response(bytes: Arc<crate::bytes::DocBytes>, ranges: &[&str]) -> Response {
    let len = bytes.len();
    let (status, selected, content_range) = match byte_range(ranges, len) {
        Ok(None) => (200, 0..len, None),
        Ok(Some(range)) => (206, range.clone(), Some(format!("bytes {}-{}/{len}", range.start, range.end - 1))),
        Err(()) => (416, 0..0, Some(format!("bytes */{len}"))),
    };
    let mut reader = Cursor::new(SharedBytes::new(bytes));
    reader.set_position(selected.start as u64);
    let mut response = reply(Box::new(reader.take(selected.len() as u64)), selected.len(), "application/pdf", None, false, false).with_status_code(status);
    for (name, value) in [("Accept-Ranges", "bytes"), ("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Encoding")] {
        response.add_header(tiny_http::Header::from_bytes(name, value).expect("static header"));
    }
    if let Some(value) = content_range { response.add_header(tiny_http::Header::from_bytes("Content-Range", value).expect("range header")); }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bytes::DocBytes, encoding, state::Document};

    #[test]
    fn pdf_ranges_are_bounded_single_and_inclusive_on_the_wire() {
        for (header, expected) in [("bytes=0-0",0..1),("bytes=3-",3..10),("bytes=-3",7..10),("bytes=8-999",8..10),("bytes=-99",0..10)] {
            assert_eq!(byte_range(&[header],10),Ok(Some(expected)),"{header}");
        }
        for header in ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "bytes=+1-3", "bytes=1-x", "items=0-1", "bytes=", "bytes=999999999999999999999-"] {
            assert!(byte_range(&[header],10).is_err(),"{header}");
        }
        assert!(byte_range(&["bytes=0-1","bytes=2-3"],10).is_err());
        assert!(byte_range(&["bytes=0-"],0).is_err());
    }

    #[test]
    fn pdf_range_responses_expose_headers_and_stream_only_the_selected_bytes() {
        let state = AppState::default();
        let bytes = Arc::new(DocBytes::Owned(b"0123456789".to_vec()));
        state.insert("main", Document::new(1,"test.pdf".into(),DocSource::Text,None,DocKind::Pdf,bytes.clone(),encoding::verbatim(bytes)));
        let tokens = Mutex::new(HashMap::from([("a".into(),Route::new(1))]));
        for (headers, status, content_range, body) in [(vec![],200,None,"0123456789"),(vec!["bytes=2-4"],206,Some("bytes 2-4/10"),"234"),(vec!["bytes=10-"],416,Some("bytes */10"),"")] {
            let response = serve(&state,&tokens,"/a/",false,&document_policy("127.0.0.1:1"),&headers,&|_| None).unwrap();
            assert_eq!(response.status_code().0,status);
            assert_eq!(response.headers().iter().find(|h| h.field.equiv("Content-Range")).map(|h| h.value.as_str()),content_range);
            assert!(response.headers().iter().any(|h| h.field.equiv("Access-Control-Expose-Headers") && h.value.as_str().contains("Accept-Ranges")));
            let mut received = String::new(); response.into_reader().read_to_string(&mut received).unwrap();
            assert_eq!(received,body);
        }
    }

    #[test]
    fn pdf_assets_and_file_query_cannot_escape_the_current_document() {
        assert!(pdf_file_matches("file=%2Ftoken%2F&g=1", "token"));
        for query in ["", "file=/other/", "file=https://evil/", "file=//token/", "file=/token/../", "file=/token/&file=/token/"] { assert!(!pdf_file_matches(query,"token")); }
        assert_eq!(pdf_asset_path("_/pdfjs/web/viewer.html").as_deref(),Some("pdfjs/web/viewer.html"));
        for path in ["_/pdfjs/../index.html","_/pdfjs/web/%2e%2e/viewer.html","_/pdfjs/web/images/%2f..%2findex.html","_/pdfjs/web/images/a%5cb","_/pdfjs/index.html","_/pdfjs/web/images/a%00"] { assert!(pdf_asset_path(path).is_none(),"{path}"); }
    }

    #[test]
    fn pdf_policy_size_mime_and_injection_are_separate_from_html() {
        let base = document_policy("127.0.0.1:12345");
        let pdf = pdf_policy(&base,false,false);
        assert!(pdf.contains("connect-src http://127.0.0.1:12345"));
        assert!(pdf.contains("'wasm-unsafe-eval'")); assert!(!pdf.contains("'unsafe-eval'"));
        assert!(pdf.contains("frame-src 'none'; form-action 'none'; base-uri 'none'"));
        assert!(!base.contains("wasm-unsafe-eval"));
        assert!(check_document_size(DocKind::Pdf,MAX_PDF_BYTES).is_ok());
        assert!(check_document_size(DocKind::Pdf,MAX_PDF_BYTES+1).is_err());
        assert!(check_document_size(DocKind::Html,MAX_DOCUMENT_BYTES+1).is_err());
        for (file, expected) in [("x.pdf","application/pdf"),("x.mjs","text/javascript"),("x.wasm","application/wasm"),("x.bcmap","application/octet-stream"),("x.pfb","application/x-font-type1")] { assert_eq!(mime(Path::new(file)),expected); }
        let state = AppState::default(); let bytes = Arc::new(DocBytes::Owned(b"%PDF-".to_vec()));
        state.insert("main", Document::new(1,"test.pdf".into(),DocSource::Text,None,DocKind::Pdf,bytes.clone(),encoding::verbatim(bytes)));
        let tokens = Mutex::new(HashMap::from([("a".into(),Route::new(1))]));
        let asset = |_: &str| Some(b"<!doctype html><head></head>".to_vec());
        assert!(serve(&state,&tokens,"/a/_/pdfjs/web/viewer.html?file=/b/",false,&base,&[],&asset).is_none());
        let response = serve(&state,&tokens,"/a/_/pdfjs/web/viewer.html?file=/a/",false,&base,&[],&asset).unwrap();
        let mut html = String::new(); response.into_reader().read_to_string(&mut html).unwrap();
        assert!(html.contains("<head><script src=\"/a/_/agent.js\" data-pdf>"));
    }
}
