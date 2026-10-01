//! Observations of the single tiny_http worker, independent of document locks.
//! Atomic health is always readable. History is best effort: a single try_lock
//! never makes the worker or observer wait, and every lost observation is counted.
//! An `ok` tiny_http return is not delivery acknowledgement: tiny_http 0.12
//! suppresses some broken-connection errors.
use std::{collections::VecDeque, io, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Instant, SystemTime, UNIX_EPOCH}};
use parking_lot::Mutex;
use crate::state::DocId;

const HISTORY_LIMIT: usize = 64;
const STARTING: u64 = 0;
const RECV_WAIT: u64 = 1;
const RECV_TIMEOUT: u64 = 2;
const RECV_ERROR: u64 = 3;
const RECEIVED: u64 = 4;
const BUILD_ENTER: u64 = 5;
const BUILT: u64 = 6;
const RESPOND_ENTER: u64 = 7;
const RESPOND_RETURNED: u64 = 8;
const EXITED: u64 = 9;
const PHASES: [&str; 10] = ["starting", "recv-wait", "recv-timeout", "recv-error", "recv-returned",
    "response-build-enter", "response-built", "respond-enter", "respond-returned", "exited"];
const EXIT_REASONS: [&str; 3] = ["stopped", "recv-error", "panic"];
// Store only a bounded error kind, never error text with a path or URL. Unknown
// future ErrorKind variants deliberately fall back to Other.
const ERROR_KINDS: [io::ErrorKind; 22] = [io::ErrorKind::NotFound, io::ErrorKind::PermissionDenied,
    io::ErrorKind::ConnectionRefused, io::ErrorKind::ConnectionReset, io::ErrorKind::ConnectionAborted,
    io::ErrorKind::NotConnected, io::ErrorKind::AddrInUse, io::ErrorKind::AddrNotAvailable,
    io::ErrorKind::BrokenPipe, io::ErrorKind::AlreadyExists, io::ErrorKind::WouldBlock,
    io::ErrorKind::InvalidInput, io::ErrorKind::InvalidData, io::ErrorKind::TimedOut,
    io::ErrorKind::WriteZero, io::ErrorKind::Interrupted, io::ErrorKind::Unsupported,
    io::ErrorKind::UnexpectedEof, io::ErrorKind::OutOfMemory, io::ErrorKind::Other,
    io::ErrorKind::NetworkDown, io::ErrorKind::NetworkUnreachable];

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    pub(super) sequence: u64,
    pub(super) path: String,
    pub(super) doc_id: Option<DocId>,
    /// The snapshot actually used to build this response, never a URL hint.
    pub(super) generation: Option<u32>,
    pub(super) received_at_ms: u64,
    pub(super) received_elapsed_ms: u64,
    pub(super) build_entered_at_ms: Option<u64>,
    pub(super) build_entered_elapsed_ms: Option<u64>,
    pub(super) built_at_ms: Option<u64>,
    pub(super) built_elapsed_ms: Option<u64>,
    pub(super) respond_entered_at_ms: Option<u64>,
    pub(super) respond_entered_elapsed_ms: Option<u64>,
    pub(super) respond_returned_at_ms: Option<u64>,
    pub(super) respond_returned_elapsed_ms: Option<u64>,
    pub(super) status: Option<u16>,
    pub(super) content_length: Option<usize>,
    pub(super) respond_result: Option<&'static str>,
    pub(super) respond_error_kind: Option<String>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    limit: usize, total: u64,
    /// Evicted records plus receives that could not acquire history.
    dropped: u64,
    history_available: bool,
    contention_count: u64,
    request_drops: u64,
    event_drops: u64,
    snapshot_misses: u64,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameServerHealth {
    clock_origin: &'static str,
    clock_origin_at_ms: u64,
    observed_elapsed_ms: u64,
    /// True only when atomic health fields were read between worker updates.
    /// History is a separate best-effort observation, not an atomic transaction.
    health_consistent: bool,
    pub(super) phase: &'static str,
    phase_at_ms: u64,
    phase_elapsed_ms: u64,
    phase_age_ms: u64,
    last_progress_at_ms: u64,
    last_progress_elapsed_ms: u64,
    last_progress_age_ms: u64,
    pub(super) active_request_id: Option<u64>,
    recv_timeout_count: u64,
    recv_error_count: u64,
    last_error_kind: Option<String>,
    exited_at_ms: Option<u64>,
    exited_elapsed_ms: Option<u64>,
    exit_reason: Option<&'static str>,
    pub(super) requests: Vec<FrameRequest>,
    retention: Retention,
}

pub(super) struct Diagnostics {
    origin: Instant,
    origin_at_ms: u64,
    // Single worker writes health; observers do bounded version-checked reads.
    // SeqCst keeps an in-progress update visible without a retry/spin wait.
    version: AtomicU64,
    phase: AtomicU64,
    phase_elapsed_ms: AtomicU64,
    last_progress_elapsed_ms: AtomicU64,
    active_request_id: AtomicU64,
    sequence: AtomicU64,
    recv_timeout_count: AtomicU64,
    recv_error_count: AtomicU64,
    last_error_kind: AtomicU64,
    exited_elapsed_ms: AtomicU64,
    exit_reason: AtomicU64,
    requests: Mutex<VecDeque<FrameRequest>>,
    evicted: AtomicU64,
    contention_count: AtomicU64,
    request_drops: AtomicU64,
    event_drops: AtomicU64,
    snapshot_misses: AtomicU64,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self { origin: Instant::now(), origin_at_ms: epoch_ms(), version: AtomicU64::new(0),
            phase: AtomicU64::new(STARTING), phase_elapsed_ms: AtomicU64::new(0),
            last_progress_elapsed_ms: AtomicU64::new(0), active_request_id: AtomicU64::new(0),
            sequence: AtomicU64::new(0), recv_timeout_count: AtomicU64::new(0), recv_error_count: AtomicU64::new(0),
            last_error_kind: AtomicU64::new(0), exited_elapsed_ms: AtomicU64::new(0), exit_reason: AtomicU64::new(0),
            requests: Mutex::new(VecDeque::with_capacity(HISTORY_LIMIT)), evicted: AtomicU64::new(0),
            contention_count: AtomicU64::new(0), request_drops: AtomicU64::new(0), event_drops: AtomicU64::new(0),
            snapshot_misses: AtomicU64::new(0) }
    }
}

impl Diagnostics {
    fn elapsed_ms(&self) -> u64 { millis(self.origin.elapsed()) }
    // Wall fields are an origin-anchored projection, not independently sampled
    // civil clocks. Every ordering and age uses the monotonic elapsed clock.
    fn wall_ms(&self, elapsed: u64) -> u64 { self.origin_at_ms.saturating_add(elapsed) }

    fn progress(&self, phase: u64, request: u64) -> u64 {
        self.progress_with(phase, request, || {})
    }

    fn progress_with(&self, phase: u64, request: u64, update: impl FnOnce()) -> u64 {
        self.version.fetch_add(1, Ordering::SeqCst);
        self.active_request_id.store(request, Ordering::SeqCst);
        self.phase.store(phase, Ordering::SeqCst);
        let elapsed = self.elapsed_ms();
        self.phase_elapsed_ms.store(elapsed, Ordering::SeqCst);
        self.last_progress_elapsed_ms.store(elapsed, Ordering::SeqCst);
        update();
        self.version.fetch_add(1, Ordering::SeqCst);
        elapsed
    }

    /// First action on recv's Some branch: no URL access, allocation or lock.
    pub(super) fn received(self: &Arc<Self>) -> RequestTrace {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let received_elapsed_ms = self.progress(RECEIVED, sequence);
        RequestTrace { diagnostics: self.clone(), sequence, received_elapsed_ms }
    }

    pub(super) fn recv_wait(&self) { self.progress(RECV_WAIT, 0); }
    pub(super) fn recv_timeout(&self) {
        self.progress_with(RECV_TIMEOUT, 0, || { self.recv_timeout_count.fetch_add(1, Ordering::SeqCst); });
    }
    pub(super) fn recv_error(&self, error: &io::Error) {
        self.progress_with(RECV_ERROR, 0, || {
            self.recv_error_count.fetch_add(1, Ordering::SeqCst);
            let kind = ERROR_KINDS.iter().position(|kind| *kind == error.kind())
                .unwrap_or_else(|| ERROR_KINDS.iter().position(|kind| *kind == io::ErrorKind::Other).unwrap());
            self.last_error_kind.store(kind as u64 + 1, Ordering::SeqCst);
        });
    }
    pub(super) fn sequence(&self) -> u64 { self.sequence.load(Ordering::SeqCst) }

    pub(super) fn snapshot(&self) -> FrameServerHealth {
        let mut sample = (0, 0, 0, 0, 0, 0, 0, 0, 0);
        let mut consistent = false;
        // Bounded even if the worker is suspended halfway through publication.
        for _ in 0..3 {
            let before = self.version.load(Ordering::SeqCst);
            sample = (self.phase.load(Ordering::SeqCst), self.phase_elapsed_ms.load(Ordering::SeqCst),
                self.last_progress_elapsed_ms.load(Ordering::SeqCst), self.active_request_id.load(Ordering::SeqCst),
                self.recv_timeout_count.load(Ordering::SeqCst), self.recv_error_count.load(Ordering::SeqCst),
                self.last_error_kind.load(Ordering::SeqCst), self.exited_elapsed_ms.load(Ordering::SeqCst),
                self.exit_reason.load(Ordering::SeqCst));
            consistent = before % 2 == 0 && before == self.version.load(Ordering::SeqCst);
            if consistent { break; }
        }
        let (phase, phase_elapsed, progress_elapsed, active, timeouts, errors, error, exited, reason) = sample;
        let now = self.elapsed_ms();
        let history = self.requests.try_lock();
        let history_available = history.is_some();
        let requests = if let Some(history) = history { history.iter().cloned().collect() } else {
            self.contention_count.fetch_add(1, Ordering::Relaxed);
            self.snapshot_misses.fetch_add(1, Ordering::Relaxed);
            Vec::new()
        };
        let request_drops = self.request_drops.load(Ordering::Relaxed);
        FrameServerHealth { clock_origin: "doc-server-start", clock_origin_at_ms: self.origin_at_ms,
            observed_elapsed_ms: now, health_consistent: consistent,
            phase: PHASES.get(phase as usize).copied().unwrap_or("unknown"),
            phase_at_ms: self.wall_ms(phase_elapsed), phase_elapsed_ms: phase_elapsed,
            phase_age_ms: now.saturating_sub(phase_elapsed),
            last_progress_at_ms: self.wall_ms(progress_elapsed), last_progress_elapsed_ms: progress_elapsed,
            last_progress_age_ms: now.saturating_sub(progress_elapsed), active_request_id: (active != 0).then_some(active),
            recv_timeout_count: timeouts, recv_error_count: errors,
            last_error_kind: error.checked_sub(1).and_then(|index| ERROR_KINDS.get(index as usize)).map(|kind| format!("{kind:?}")),
            exited_at_ms: (reason != 0).then(|| self.wall_ms(exited)), exited_elapsed_ms: (reason != 0).then_some(exited),
            exit_reason: reason.checked_sub(1).and_then(|index| EXIT_REASONS.get(index as usize)).copied(), requests,
            retention: Retention { limit: HISTORY_LIMIT, total: self.sequence(),
                dropped: self.evicted.load(Ordering::Relaxed).saturating_add(request_drops), history_available,
                contention_count: self.contention_count.load(Ordering::Relaxed), request_drops,
                event_drops: self.event_drops.load(Ordering::Relaxed), snapshot_misses: self.snapshot_misses.load(Ordering::Relaxed) } }
    }

    pub(super) fn worker_guard(self: &Arc<Self>) -> WorkerGuard {
        WorkerGuard { diagnostics: self.clone(), reason: "stopped" }
    }
}

pub(super) struct WorkerGuard { diagnostics: Arc<Diagnostics>, pub(super) reason: &'static str }
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let diagnostics = &self.diagnostics;
        // Terminal health does not acquire history, including while unwinding.
        diagnostics.version.fetch_add(1, Ordering::SeqCst);
        diagnostics.phase.store(EXITED, Ordering::SeqCst);
        let elapsed = diagnostics.elapsed_ms();
        diagnostics.phase_elapsed_ms.store(elapsed, Ordering::SeqCst);
        diagnostics.last_progress_elapsed_ms.store(elapsed, Ordering::SeqCst);
        diagnostics.exited_elapsed_ms.store(elapsed, Ordering::SeqCst);
        let reason = if std::thread::panicking() { "panic" } else { self.reason };
        diagnostics.exit_reason.store(EXIT_REASONS.iter().position(|value| *value == reason).unwrap_or(0) as u64 + 1, Ordering::SeqCst);
        diagnostics.version.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) struct RequestTrace { diagnostics: Arc<Diagnostics>, sequence: u64, received_elapsed_ms: u64 }
impl RequestTrace {
    pub(super) fn record_path(&self, url: &str) {
        let Some(mut requests) = self.diagnostics.requests.try_lock() else {
            self.diagnostics.contention_count.fetch_add(1, Ordering::Relaxed);
            self.diagnostics.request_drops.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if requests.len() == HISTORY_LIMIT {
            requests.pop_front();
            self.diagnostics.evicted.fetch_add(1, Ordering::Relaxed);
        }
        requests.push_back(FrameRequest { sequence: self.sequence, path: diagnostic_path(url), doc_id: None, generation: None,
            received_at_ms: self.diagnostics.wall_ms(self.received_elapsed_ms), received_elapsed_ms: self.received_elapsed_ms,
            build_entered_at_ms: None, build_entered_elapsed_ms: None, built_at_ms: None, built_elapsed_ms: None,
            respond_entered_at_ms: None, respond_entered_elapsed_ms: None, respond_returned_at_ms: None,
            respond_returned_elapsed_ms: None, status: None, content_length: None, respond_result: None, respond_error_kind: None });
    }

    fn update_history(&self, update: impl FnOnce(&mut FrameRequest)) {
        if let Some(mut requests) = self.diagnostics.requests.try_lock() {
            if let Some(request) = requests.iter_mut().find(|request| request.sequence == self.sequence) {
                update(request);
                return;
            }
        } else { self.diagnostics.contention_count.fetch_add(1, Ordering::Relaxed); }
        self.diagnostics.event_drops.fetch_add(1, Ordering::Relaxed);
    }
    fn update(&self, phase: u64, update: impl FnOnce(&mut FrameRequest, u64, u64)) {
        let elapsed = self.diagnostics.progress(phase, self.sequence);
        self.update_history(|request| update(request, self.diagnostics.wall_ms(elapsed), elapsed));
    }
    pub(super) fn associate(&self, id: DocId, generation: Option<u32>) {
        self.update_history(|request| { request.doc_id = Some(id); request.generation = generation; });
    }
    pub(super) fn build_enter(&self) {
        self.update(BUILD_ENTER, |request, at, elapsed| {
            request.build_entered_at_ms = Some(at); request.build_entered_elapsed_ms = Some(elapsed);
        });
    }
    pub(super) fn built(&self, status: u16, len: Option<usize>) {
        self.update(BUILT, |request, at, elapsed| {
            request.built_at_ms = Some(at); request.built_elapsed_ms = Some(elapsed);
            request.status = Some(status); request.content_length = len;
        });
    }
    pub(super) fn respond_enter(&self) {
        self.update(RESPOND_ENTER, |request, at, elapsed| {
            request.respond_entered_at_ms = Some(at); request.respond_entered_elapsed_ms = Some(elapsed);
        });
    }
    pub(super) fn respond_returned(&self, result: &io::Result<()>) {
        self.update(RESPOND_RETURNED, |request, at, elapsed| {
            request.respond_returned_at_ms = Some(at); request.respond_returned_elapsed_ms = Some(elapsed);
            request.respond_result = Some(if result.is_ok() { "ok" } else { "error" });
            request.respond_error_kind = result.as_ref().err().map(|error| format!("{:?}", error.kind()));
        });
    }
}

fn epoch_ms() -> u64 { millis(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()) }
fn millis(duration: std::time::Duration) -> u64 { duration.as_millis().min(u64::MAX as u128) as u64 }

/// Safe before token lookup. Never records an origin, capability, query, local
/// filename, arbitrary resource name, or error text supplied by the requester.
pub(crate) fn diagnostic_path(url: &str) -> String {
    // Native resource hooks may also receive very large data/unknown URLs.
    // Keep diagnostic parsing bounded without changing request routing.
    if url.len() > 8192 { return "/[unmatched]".into(); }
    let absolute = url::Url::parse(url).ok();
    let path = absolute.as_ref().map_or(url, |url| url.path()).split(['?', '#']).next().unwrap_or("");
    let Some((_, relative)) = path.strip_prefix('/').and_then(|path| path.split_once('/')) else {
        return "/[unmatched]".into();
    };
    match relative {
        "" => "/".into(),
        "_/agent.js" | "_/pdf-agent.js" | "_/pdfjs/build/pdf.mjs" | "_/pdfjs/build/pdf.worker.mjs"
        | "_/pdfjs/build/pdf.sandbox.mjs" | "_/pdfjs/web/viewer.html" | "_/pdfjs/web/viewer.css"
        | "_/pdfjs/web/viewer.mjs" | "_/pdfjs/web/locale/locale.json" => format!("/{relative}"),
        _ => {
            for category in ["images", "cmaps", "standard_fonts", "wasm", "iccs", "locale"] {
                if relative.starts_with(&format!("_/pdfjs/web/{category}/")) {
                    return format!("/_/pdfjs/web/{category}/[asset]");
                }
            }
            "/[document-resource]".into()
        }
    }
}

#[cfg(test)]
#[path = "diagnostics/tests.rs"]
mod tests;
