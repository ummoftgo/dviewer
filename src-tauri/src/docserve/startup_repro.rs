//! Opt-in smoke experiment, never a production request policy.
//! Only the chosen successful asset response moves to one helper. Its events are
//! separate from the single-writer document-server health observations.
use std::{io, thread::{self, JoinHandle}, time::{Duration, Instant}};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode { CssControl, CssDelay, ModuleDelay }
impl Mode {
    pub(crate) fn parse(value: Option<&str>) -> Result<Option<Self>, &'static str> {
        match value {
            None => Ok(None),
            Some("css-control") => Ok(Some(Self::CssControl)),
            Some("css-delay") => Ok(Some(Self::CssDelay)),
            Some("module-delay") => Ok(Some(Self::ModuleDelay)),
            Some(_) => Err("invalid DVIEWER_PDF_STARTUP_REPRO mode"),
        }
    }
    pub(crate) fn target(self) -> &'static str {
        if self == Self::ModuleDelay { "module" } else { "css" }
    }
    fn path(self) -> &'static str {
        if self == Self::ModuleDelay { "/_/pdfjs/web/viewer.mjs" } else { "/_/pdfjs/web/viewer.css" }
    }
    pub(crate) fn delay_ms(self) -> u64 { if self == Self::CssControl { 0 } else { 1000 } }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Event {
    pub phase: &'static str, pub target: &'static str, pub delay_ms: u64,
    pub request_id: Option<u64>, pub doc_id: Option<u64>, pub result: Option<&'static str>,
    pub error_kind: Option<&'static str>, pub held_ms: Option<u64>, pub status: Option<u16>,
}
impl Event {
    pub(crate) fn armed(mode: Mode) -> Self {
        Self {phase:"armed",target:mode.target(),delay_ms:mode.delay_ms(),request_id:None,doc_id:None,
            result:None,error_kind:None,held_ms:None,status:None}
    }
}

pub(crate) struct Experiment {
    mode: Mode, claimed: bool, worker: Option<JoinHandle<()>>, spawn_failed: bool,
}
impl Experiment {
    pub(crate) fn new(mode: Mode) -> Self { Self {mode,claimed:false,worker:None,spawn_failed:false} }
    // The caller has already built the response through the ordinary authenticated
    // route. Invalid hosts, tokens, methods, missing assets and non-200s stay inline.
    pub(crate) fn matches(&self, method: &str, status: u16, path: &str, doc_id: Option<u64>) -> bool {
        !self.claimed && method == "GET" && status == 200 && path == self.mode.path() && doc_id.is_some()
    }
    pub(crate) fn start(&mut self, request_id: u64, doc_id: u64,
        send: impl FnOnce() -> io::Result<()> + Send + 'static,
        record: impl Fn(Event) + Send + Sync + 'static) {
        assert!(!self.claimed, "only one response may be delayed");
        self.claimed = true;
        let mut event = Event::armed(self.mode);
        event.request_id = Some(request_id); event.doc_id = Some(doc_id);
        event.status = Some(200);
        self.worker = thread::Builder::new().name("pdf-startup-repro".into()).spawn(move || {
            event.phase = "held"; record(event.clone());
            let held = Instant::now();
            thread::sleep(Duration::from_millis(event.delay_ms));
            event.phase = "release"; event.held_ms = Some(held.elapsed().as_millis() as u64); record(event.clone());
            // Do not call Diagnostics::progress from here: it has one writer.
            let result = send();
            event.phase = "responded";
            event.result = Some(if result.is_ok() { "ok" } else { "error" });
            event.error_kind = result.err().map(|error| match error.kind() {
                io::ErrorKind::BrokenPipe => "BrokenPipe", io::ErrorKind::ConnectionReset => "ConnectionReset",
                io::ErrorKind::TimedOut => "TimedOut", _ => "Other",
            });
            record(event);
        }).map_err(|_| { self.spawn_failed = true; }).ok();
    }
    pub(crate) fn join(&mut self, record: impl FnOnce(Event)) -> bool {
        let joined = self.worker.take().map(|worker| worker.join().is_ok()).unwrap_or(false);
        let mut event = Event::armed(self.mode); event.phase = "joined";
        event.result = Some(if self.spawn_failed { "spawn-error" } else if !self.claimed { "not-injected" }
            else if joined { "ok" } else { "panic" });
        record(event);
        joined
    }
}
impl Drop for Experiment {
    fn drop(&mut self) { if let Some(worker) = self.worker.take() { let _ = worker.join(); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, mpsc};

    #[test]
    fn only_fixed_explicit_modes_and_validated_assets_can_claim_the_helper() {
        assert_eq!(Mode::parse(None), Ok(None));
        for value in ["", "css", "10000", "../viewer.css", "css-delay=5000"] { assert!(Mode::parse(Some(value)).is_err()); }
        for mode in [Mode::CssControl, Mode::CssDelay, Mode::ModuleDelay] {
            let experiment = Experiment::new(mode);
            assert!(experiment.matches("GET",200,mode.path(),Some(1)));
            for (method,status,path,id) in [("POST",200,mode.path(),Some(1)),("GET",404,mode.path(),Some(1)),
                ("GET",200,"/_/pdfjs/build/pdf.mjs",Some(1)),("GET",200,mode.path(),None),
                ("GET",200,"/_/pdfjs/web/viewer.css?secret",Some(1))] {
                assert!(!experiment.matches(method,status,path,id));
            }
            assert!(mode.delay_ms() <= 1000);
        }
    }

    #[test]
    fn zero_delay_control_uses_one_helper_and_preserves_response_errors_and_join() {
        let events = Arc::new(Mutex::new(Vec::new())); let recorded = events.clone();
        let mut experiment = Experiment::new(Mode::CssControl);
        experiment.start(7,3,|| Err(io::Error::new(io::ErrorKind::BrokenPipe,"private url and token")),
            move |event| recorded.lock().unwrap().push(event));
        assert!(!experiment.matches("GET",200,"/_/pdfjs/web/viewer.css",Some(3)));
        assert!(experiment.join(|event| events.lock().unwrap().push(event)));
        let events = events.lock().unwrap();
        assert_eq!(events.iter().map(|event| event.phase).collect::<Vec<_>>(),["held","release","responded","joined"]);
        assert_eq!(events[2].result,Some("error")); assert_eq!(events[2].error_kind,Some("BrokenPipe"));
        assert!(!serde_json::to_string(&*events).unwrap().contains("private"));
    }

    #[test]
    fn a_delayed_response_does_not_occupy_the_callers_thread_and_drop_joins_it() {
        let (tx,rx) = mpsc::channel(); let (events_tx,events_rx) = mpsc::channel();
        let (release_tx,release_rx) = mpsc::channel();
        let mut experiment = Experiment::new(Mode::CssDelay);
        experiment.start(1,2,move || { release_rx.recv().unwrap(); tx.send(()).unwrap(); Ok(()) },move |event| { events_tx.send(event).unwrap(); });
        assert_eq!(events_rx.recv_timeout(Duration::from_secs(2)).unwrap().phase,"held");
        // An independent response can complete on this thread while CSS is held.
        let (other_tx,other_rx) = mpsc::channel(); other_tx.send("viewer.mjs").unwrap();
        assert_eq!(other_rx.try_recv().unwrap(),"viewer.mjs");
        assert!(rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        drop(experiment);
        assert!(rx.try_recv().is_ok());
        let release = events_rx.try_recv().unwrap();
        assert_eq!(release.phase,"release"); assert!(release.held_ms.unwrap() >= 1000);
        assert_eq!(events_rx.try_recv().unwrap().phase,"responded");
    }

    #[test]
    fn untriggered_and_panicked_helpers_are_not_successful_experiments() {
        let mut empty = Experiment::new(Mode::CssControl);
        assert!(!empty.join(|event| assert_eq!(event.result,Some("not-injected"))));
        let mut panic = Experiment::new(Mode::CssControl);
        panic.start(1,1,|| panic!("synthetic helper panic"),|_| {});
        assert!(!panic.join(|event| assert_eq!(event.result,Some("panic"))));
    }
}
