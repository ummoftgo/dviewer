use super::*;
use minisign::KeyPair;
use std::{io::Cursor, net::TcpListener, thread};

fn keypair() -> (KeyPair, String) {
    let pair = KeyPair::generate_unencrypted_keypair().unwrap();
    let public = STANDARD.encode(pair.pk.to_box().unwrap().to_string());
    (pair, public)
}

fn sign(pair: &KeyPair, bytes: &[u8]) -> String {
    STANDARD.encode(
        minisign::sign(Some(&pair.pk), &pair.sk, Cursor::new(bytes), None, None)
            .unwrap()
            .to_string(),
    )
}

fn server(replies: Vec<(String, Vec<u8>)>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        for (head, body) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 8192);
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
            }
            stream.write_all(head.as_bytes()).unwrap();
            // A rejected length or redirect may close the socket before its body.
            let _ = stream.write_all(&body);
        }
    });
    (address, thread)
}

fn ok(bytes: &[u8]) -> (String, Vec<u8>) {
    (
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        ),
        bytes.to_vec(),
    )
}

#[test]
fn signatures_authenticate_bytes_and_the_matching_key() {
    let (pair, key) = keypair();
    let signature = sign(&pair, b"old signed bytes");
    let cancel = AtomicBool::new(false);
    verify(&mut &b"old signed bytes"[..], &key, &signature, &cancel).unwrap();
    assert_eq!(
        verify(&mut &b"modified bytes"[..], &key, &signature, &cancel),
        Err(Error::UpdateBadSignature)
    );
    let (_, wrong_key) = keypair();
    assert_eq!(
        verify(
            &mut &b"old signed bytes"[..],
            &wrong_key,
            &signature,
            &cancel
        ),
        Err(Error::UpdateBadSignature)
    );
}

#[test]
fn signatures_require_the_tauri_envelope_and_valid_text() {
    let (pair, key) = keypair();
    let signature = sign(&pair, b"a");
    let plain = String::from_utf8(STANDARD.decode(&signature).unwrap()).unwrap();
    for invalid in [
        "".to_owned(),
        "not base64".to_owned(),
        plain,
        STANDARD.encode([255]),
        "a".repeat(16385),
    ] {
        assert_eq!(
            verify(&mut &b"a"[..], &key, &invalid, &AtomicBool::new(false)),
            Err(Error::UpdateBadSignature)
        );
    }
}

#[test]
fn cancelled_signature_verification_does_not_succeed() {
    let (pair, key) = keypair();
    assert_eq!(
        verify(
            &mut &b"a"[..],
            &key,
            &sign(&pair, b"a"),
            &AtomicBool::new(true)
        ),
        Err(Error::Cancelled)
    );
}

#[test]
fn streaming_limit_checks_actual_bytes_before_writing_them() {
    let cancel = AtomicBool::new(false);
    let mut destination = Vec::new();
    assert_eq!(
        copy_limited(&mut &b"abcd"[..], &mut destination, 4, &cancel, |_| {}).unwrap(),
        4
    );
    destination.clear();
    assert!(copy_limited(&mut &b"abcde"[..], &mut destination, 4, &cancel, |_| {}).is_err());
    assert!(destination.is_empty());
}

#[test]
fn cancel_from_progress_stops_before_the_next_chunk() {
    let cancel = AtomicBool::new(false);
    let mut destination = Vec::new();
    let result = copy_limited(
        &mut std::io::repeat(7).take(10000),
        &mut destination,
        10000,
        &cancel,
        |_| cancel.store(true, Ordering::Relaxed),
    );
    assert_eq!(result, Err(Error::Cancelled));
    assert_eq!(destination.len(), 4096);
}

#[test]
fn declared_and_undeclared_http_lengths_obey_the_limit() {
    for reply in [
        ok(b"abcde"),
        (
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".into(),
            b"abcde".to_vec(),
        ),
    ] {
        let (url, server) = server(vec![reply]);
        let mut bytes = Vec::new();
        assert!(receive(
            &url,
            &UrlPolicy::development(&url).unwrap(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(5),
            &mut bytes,
            4,
            |_, _| {}
        )
        .is_err());
        assert!(bytes.is_empty());
        server.join().unwrap();
    }
}

#[test]
fn redirects_are_validated_before_following() {
    let (url, server) = server(vec![(
        "HTTP/1.1 302 Found\r\nLocation: http://example.com/evil\r\nContent-Length: 0\r\n\r\n"
            .into(),
        vec![],
    )]);
    let result = response(
        &url,
        &UrlPolicy::development(&url).unwrap(),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(5),
    );
    assert!(matches!(result, Err(Error::BadUrl { .. })));
    server.join().unwrap();
}

#[test]
fn relative_redirects_keep_the_same_loopback_origin() {
    let (url, server) = server(vec![
        (
            "HTTP/1.1 302 Found\r\nLocation: /asset\r\nContent-Length: 0\r\n\r\n".into(),
            vec![],
        ),
        ok(b"abc"),
    ]);
    let mut bytes = Vec::new();
    receive(
        &url,
        &UrlPolicy::development(&url).unwrap(),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(5),
        &mut bytes,
        3,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(bytes, b"abc");
    server.join().unwrap();
}

#[test]
fn metadata_is_authenticated_before_a_changed_version_is_used() {
    let (pair, key) = keypair();
    let original = super::super::tests::manifest("0.14.0");
    for (bytes, expected) in [
        (original.clone(), true),
        (super::super::tests::manifest("9.0.0"), false),
    ] {
        let signature = sign(&pair, &original);
        let (url, server) = server(vec![ok(&bytes), ok(signature.as_bytes())]);
        let result = fetch_manifest(
            &format!("{url}/latest.json"),
            &UrlPolicy::development(&url).unwrap(),
            &key,
            &AtomicBool::new(false),
        );
        assert_eq!(result.is_ok(), expected);
        if !expected {
            assert!(matches!(result, Err(Error::UpdateBadSignature)));
        }
        server.join().unwrap();
    }
}

#[test]
fn downloaded_file_stays_verified_and_is_removed_when_dropped() {
    let (pair, key) = keypair();
    let (url, server) = server(vec![ok(b"a signed executable")]);
    let asset = Asset {
        url: url.clone(),
        signature: sign(&pair, b"a signed executable"),
    };
    let download = download(
        &asset,
        &UrlPolicy::development(&url).unwrap(),
        &key,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    let path = download.path().to_owned();
    assert_eq!(std::fs::read(&path).unwrap(), b"a signed executable");
    #[cfg(windows)]
    {
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::remove_file(&path).is_err());
    }
    drop(download);
    assert!(!path.exists());
    server.join().unwrap();
}

#[test]
fn changed_download_never_becomes_an_installable_file() {
    let (pair, key) = keypair();
    let (url, server) = server(vec![ok(b"modified executable")]);
    let asset = Asset {
        url: url.clone(),
        signature: sign(&pair, b"a signed executable"),
    };
    assert!(matches!(
        download(
            &asset,
            &UrlPolicy::development(&url).unwrap(),
            &key,
            &AtomicBool::new(false),
            |_, _| {}
        ),
        Err(Error::UpdateBadSignature)
    ));
    server.join().unwrap();
}
