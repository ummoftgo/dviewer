use super::*;

#[test]
fn observation_precedes_association_and_every_response_boundary_is_distinct() {
    let diagnostics = Arc::new(Diagnostics::default());
    let trace = diagnostics.received();
    trace.record_path("/capability/_/pdfjs/web/viewer.mjs?g=999");
    let received = diagnostics.snapshot();
    assert_eq!(received.clock_origin, "doc-server-start");
    assert!(received.health_consistent);
    assert_eq!(received.phase, "recv-returned");
    let request = &received.requests[0];
    assert_eq!(received.active_request_id, Some(request.sequence));
    assert_eq!((request.doc_id, request.generation, request.status, request.content_length), (None, None, None, None));
    assert!(request.build_entered_at_ms.is_none() && request.respond_entered_at_ms.is_none());
    trace.build_enter();
    trace.associate(7, None);
    assert_eq!(diagnostics.snapshot().phase, "response-build-enter");
    assert_eq!(diagnostics.snapshot().requests[0].generation, None);
    trace.associate(7, Some(3));
    trace.built(206, Some(4));
    let built = diagnostics.snapshot();
    assert_eq!(built.phase, "response-built");
    assert_eq!((built.requests[0].doc_id, built.requests[0].generation), (Some(7), Some(3)));
    assert_eq!((built.requests[0].status, built.requests[0].content_length), (Some(206), Some(4)));
    assert!(built.requests[0].respond_entered_at_ms.is_none());
    trace.respond_enter();
    assert_eq!(diagnostics.snapshot().phase, "respond-enter");
    assert!(diagnostics.snapshot().requests[0].respond_result.is_none());
    trace.respond_returned(&Ok(()));
    let returned = diagnostics.snapshot();
    assert_eq!(returned.phase, "respond-returned");
    assert_eq!(returned.requests[0].respond_result, Some("ok"));
    assert!(returned.requests[0].respond_returned_at_ms.is_some());
    let json = serde_json::to_value(&returned).unwrap();
    for key in ["receivedAtMs", "buildEnteredAtMs", "builtAtMs", "respondEnteredAtMs", "respondReturnedAtMs"] {
        assert!(json["requests"][0][key].as_u64().unwrap() > 0, "{key}");
    }
    let events = ["receivedElapsedMs", "buildEnteredElapsedMs", "builtElapsedMs", "respondEnteredElapsedMs", "respondReturnedElapsedMs"]
        .map(|key| json["requests"][0][key].as_u64().unwrap());
    assert!(events.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(events[4] <= returned.observed_elapsed_ms);
    assert_eq!(returned.requests[0].received_at_ms, returned.clock_origin_at_ms + events[0]);
    assert!(json["requests"][0].get("sent").is_none());
}

#[test]
fn retention_has_global_ids_and_explicit_loss_instead_of_silent_emptiness() {
    let diagnostics = Arc::new(Diagnostics::default());
    for _ in 0..HISTORY_LIMIT + 9 { diagnostics.received().record_path("/secret/"); }
    let snapshot = diagnostics.snapshot();
    assert_eq!(snapshot.requests.len(), HISTORY_LIMIT);
    assert_eq!(snapshot.requests.first().unwrap().sequence, 10);
    assert_eq!(snapshot.requests.last().unwrap().sequence, (HISTORY_LIMIT + 9) as u64);
    assert_eq!(snapshot.retention.limit, HISTORY_LIMIT);
    assert_eq!(snapshot.retention.total, (HISTORY_LIMIT + 9) as u64);
    assert_eq!(snapshot.retention.dropped, 9);
}

#[test]
fn worker_wait_timeout_and_exit_are_visible_without_any_request() {
    let mut raw = Diagnostics::default();
    raw.origin -= std::time::Duration::from_secs(5);
    // Even a saturated wall projection must not change monotonic ages.
    raw.origin_at_ms = u64::MAX;
    let diagnostics = Arc::new(raw);
    let guard = diagnostics.worker_guard();
    diagnostics.recv_wait();
    diagnostics.phase_elapsed_ms.store(2000, Ordering::SeqCst);
    diagnostics.last_progress_elapsed_ms.store(0, Ordering::SeqCst);
    let waiting = diagnostics.snapshot();
    assert_eq!(waiting.phase, "recv-wait");
    assert!(waiting.phase_age_ms >= 3000 && waiting.last_progress_age_ms >= 5000);
    assert!(waiting.requests.is_empty());
    diagnostics.recv_timeout();
    let timeout = diagnostics.snapshot();
    assert_eq!(timeout.phase, "recv-timeout");
    assert_eq!(timeout.recv_timeout_count, 1);
    assert!(timeout.last_progress_age_ms < 5000);
    drop(guard);
    let exited = diagnostics.snapshot();
    assert_eq!(exited.phase, "exited");
    assert_eq!(exited.exit_reason, Some("stopped"));
    assert!(exited.exited_at_ms.is_some());
}

#[test]
fn receive_error_and_worker_panic_keep_terminal_health_and_request_evidence() {
    let errors = Arc::new(Diagnostics::default());
    {
        let mut guard = errors.worker_guard();
        errors.recv_error(&io::Error::new(io::ErrorKind::Other, "private /secret/path"));
        guard.reason = "recv-error";
    }
    let exited = errors.snapshot();
    assert_eq!(exited.exit_reason, Some("recv-error"));
    assert_eq!(exited.recv_error_count, 1);
    assert_eq!(exited.last_error_kind.as_deref(), Some("Other"));
    assert!(!serde_json::to_string(&exited).unwrap().contains("secret"));
    let diagnostics = Arc::new(Diagnostics::default());
    let worker = diagnostics.clone();
    assert!(std::thread::spawn(move || {
        let _guard = worker.worker_guard();
        let trace = worker.received();
        trace.record_path("/capability/");
        trace.build_enter();
        panic!("injected construction failure");
    }).join().is_err());
    let panicked = diagnostics.snapshot();
    assert_eq!(panicked.phase, "exited");
    assert_eq!(panicked.exit_reason, Some("panic"));
    assert_eq!(panicked.active_request_id, Some(1));
    assert!(panicked.requests[0].build_entered_at_ms.is_some());
    assert!(panicked.requests[0].built_at_ms.is_none());
}

#[test]
fn diagnostic_paths_are_bounded_categories_and_never_arbitrary_names() {
    for (input, expected) in [
        ("/secret/", "/"),
        ("/secret/_/agent.js?file=secret#private", "/_/agent.js"),
        ("http://private-host/secret/_/pdfjs/web/viewer.mjs?private", "/_/pdfjs/web/viewer.mjs"),
        ("/secret/_/pdfjs/web/locale/private/viewer.ftl", "/_/pdfjs/web/locale/[asset]"),
        ("/secret/_/pdfjs/web/images/secret.png", "/_/pdfjs/web/images/[asset]"),
        ("/secret/private.html", "/[document-resource]"),
        ("/secret/%73%65%63%72%65%74", "/[document-resource]"),
        ("/secret/private\nfile", "/[document-resource]"),
        ("/secret", "/[unmatched]"),
        ("/", "/[unmatched]"),
    ] { assert_eq!(diagnostic_path(input), expected, "{input}"); }
    assert_eq!(diagnostic_path(&format!("/secret/{}", "한😀".repeat(1000))), "/[document-resource]");
    assert_eq!(diagnostic_path(&format!("https://private/capability/{}", "x".repeat(8192))), "/[unmatched]");
    assert_eq!(diagnostic_path(&format!("data:private,{}", "x".repeat(8192))), "/[unmatched]");
}

#[test]
fn receive_is_published_before_path_sanitization_or_history_creation() {
    let diagnostics = Arc::new(Diagnostics::default());
    let trace = diagnostics.received();
    let before_path = diagnostics.snapshot();
    assert_eq!(before_path.phase, "recv-returned");
    assert_eq!(before_path.active_request_id, Some(1));
    assert_eq!(before_path.retention.total, 1);
    assert!(before_path.requests.is_empty());
    trace.record_path("/capability/private-name?secret");
    let after_path = diagnostics.snapshot();
    assert_eq!(after_path.requests.len(), 1);
    assert_eq!(after_path.requests[0].path, "/[document-resource]");
}

#[test]
fn held_history_never_blocks_worker_progress_or_health_and_reports_every_loss() {
    use std::{sync::mpsc, time::Duration};
    let diagnostics = Arc::new(Diagnostics::default());
    let held = diagnostics.requests.lock();
    let worker_diagnostics = diagnostics.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let trace = worker_diagnostics.received();
        trace.record_path("/secret/");
        trace.build_enter();
        trace.associate(7, Some(2));
        trace.built(200, Some(4));
        trace.respond_enter();
        trace.respond_returned(&Ok(()));
        done_tx.send(()).unwrap();
    });
    let done = done_rx.recv_timeout(Duration::from_secs(3));
    // Also exercise snapshot while the history mutex is held. The observer must
    // not delay releasing the worker if a blocking-lock regression is injected.
    let observer_diagnostics = diagnostics.clone();
    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let observer = std::thread::spawn(move || { snapshot_tx.send(observer_diagnostics.snapshot()).unwrap(); });
    let observed = snapshot_rx.recv_timeout(Duration::from_secs(3));
    drop(held);
    worker.join().unwrap(); observer.join().unwrap();
    done.expect("history prevented the worker from making progress");
    let health = observed.expect("history blocked atomic health");
    assert_eq!(health.phase, "respond-returned");
    assert_eq!(health.active_request_id, Some(1));
    assert_eq!(health.retention.total, 1);
    assert_eq!(health.retention.request_drops, 1);
    assert_eq!(health.retention.dropped, 1);
    assert_eq!(health.retention.event_drops, 5);
    assert_eq!(health.retention.contention_count, 7);
    assert_eq!(health.retention.snapshot_misses, 1);
    assert!(!health.retention.history_available);
    assert!(health.requests.is_empty());
    assert!(diagnostics.snapshot().retention.history_available);
    // The next request is independently retained; dropped IDs are never reused.
    diagnostics.received().record_path("/next/");
    assert_eq!(diagnostics.snapshot().requests[0].sequence, 2);
}

#[test]
fn held_history_cannot_hide_worker_panic_or_exit() {
    use std::{sync::mpsc, time::Duration};
    let diagnostics = Arc::new(Diagnostics::default());
    let held = diagnostics.requests.lock();
    let worker_diagnostics = diagnostics.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = worker_diagnostics.worker_guard();
            let trace = worker_diagnostics.received();
            trace.build_enter();
            panic!("injected build panic with locked history");
        }));
        done_tx.send(result.is_err()).unwrap();
    });
    let done = done_rx.recv_timeout(Duration::from_secs(3));
    let health = diagnostics.snapshot();
    drop(held);
    worker.join().unwrap();
    assert!(done.expect("worker unwind blocked on history"));
    assert_eq!(health.phase, "exited");
    assert_eq!(health.exit_reason, Some("panic"));
    assert_eq!(health.active_request_id, Some(1));
    assert!(health.exited_elapsed_ms.is_some());
    assert!(!health.retention.history_available);
}

#[test]
fn partial_atomic_publication_is_bounded_and_explicit() {
    let diagnostics = Diagnostics::default();
    // A suspended writer must not make a seqlock observer spin indefinitely.
    diagnostics.version.store(1, Ordering::SeqCst);
    let health = diagnostics.snapshot();
    assert!(!health.health_consistent);
    assert_eq!(health.phase, "starting");
    assert!(health.retention.history_available);
}
