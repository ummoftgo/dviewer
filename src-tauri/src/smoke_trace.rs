//! Smoke-only, bounded, redacted observations. Native objects never leave GTK's thread.
use std::{fs::File, io::Write, path::Path, sync::{Arc, atomic::{AtomicU64, AtomicU8, Ordering}, mpsc::{self, SyncSender}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde_json::{json, Value};

const QUEUE: usize = 256;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_LINE: usize = 70 * 1024;
enum Entry { Event(Value), Flush(mpsc::Sender<()>) }
#[derive(Clone)]
pub(crate) struct Trace {
    origin: Instant, origin_at_ms: u64, tx: SyncSender<Entry>, dropped: Arc<AtomicU64>, sequence: Arc<AtomicU64>, ready: Arc<AtomicU8>,
}
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
impl Trace {
    pub(crate) fn start(out: &Path) -> Result<Self, String> {
        let mut file = File::create(out.with_extension("trace.jsonl")).map_err(|_| "cannot create smoke diagnostic trace".to_owned())?;
        let (tx,rx) = mpsc::sync_channel(QUEUE);
        let dropped = Arc::new(AtomicU64::new(0));
        let loss = dropped.clone();
        std::thread::Builder::new().name("smoke-trace".into()).spawn(move || {
            let mut bytes = 0;
            while let Ok(entry) = rx.recv() {
                match entry {
                    Entry::Event(value) => {
                        let line = value.to_string();
                        if line.len() > MAX_LINE || bytes + line.len() + 1 > MAX_BYTES {
                            loss.fetch_add(1,Ordering::Relaxed); continue;
                        }
                        bytes += line.len() + 1;
                        if writeln!(file,"{line}").and_then(|_| file.flush()).is_err() { loss.fetch_add(1,Ordering::Relaxed); }
                    }
                    Entry::Flush(done) => {
                        // Reserve this final metadata independently of the data-byte cap.
                        let _ = writeln!(file,"{}",json!({"kind":"trace-retention","atMs":now_ms(),"bytes":bytes,"limitBytes":MAX_BYTES,"dropped":loss.load(Ordering::Relaxed)}));
                        let _ = file.flush(); let _ = done.send(());
                    }
                }
            }
        }).map_err(|_| "cannot start smoke diagnostic writer".to_owned())?;
        Ok(Self {origin:Instant::now(),origin_at_ms:now_ms(),tx,dropped,sequence:Arc::new(AtomicU64::new(0)),ready:Arc::new(AtomicU8::new(if cfg!(target_os="linux") {0} else {2}))})
    }
    pub(crate) fn record(&self, kind:&str, mut value:Value) {
        if let Some(fields)=value.as_object_mut() {
            fields.insert("kind".into(),kind.into()); fields.insert("atMs".into(),now_ms().into());
            fields.insert("clockOriginAtMs".into(),self.origin_at_ms.into());
            fields.insert("elapsedMs".into(),(self.origin.elapsed().as_millis() as u64).into());
            fields.insert("dropped".into(),self.dropped.load(Ordering::Relaxed).into());
        }
        if self.tx.try_send(Entry::Event(value)).is_err() { self.dropped.fetch_add(1,Ordering::Relaxed); }
    }
    pub(crate) fn ready(&self) -> Result<bool,String> {
        match self.ready.load(Ordering::Acquire) {0=>Ok(false),1|2=>Ok(true),_=>Err("native WebKit observation hook failed".into())}
    }
    pub(crate) fn flush(&self) {
        let (tx,rx)=mpsc::channel();
        if self.tx.try_send(Entry::Flush(tx)).is_ok() { let _=rx.recv_timeout(Duration::from_millis(100)); }
    }
    #[cfg(target_os="linux")]
    pub(crate) fn install(&self, window:&tauri::WebviewWindow) {
        let trace=self.clone();
        if window.with_webview(move |platform| {
            use webkit2gtk::{WebViewExt, WebResourceExt, URIRequestExt, URIResponseExt};
            use webkit2gtk::glib::{prelude::ObjectExt, error::ErrorDomain};
            let view=platform.inner();
            let scopes=std::rc::Rc::new(std::cell::RefCell::new(ScopeRegistry::default()));
            let resource_trace=trace.clone();
            view.connect_resource_load_started(move |_,resource,request| {
                let id=resource_trace.sequence.fetch_add(1,Ordering::Relaxed)+1;
                let uri=request.uri();
                let path=crate::docserve::diagnostic_path(uri.as_deref().unwrap_or(""));
                let scope=scopes.borrow_mut().scope(uri.as_deref().unwrap_or(""));
                let lifecycle=std::rc::Rc::new(std::cell::Cell::new(false));
                resource_trace.record("native-resource",json!({"id":id,"initialRouteScope":scope,"event":"resource-load-started","path":path}));
                // GTK 2.0.2's generated sent-request wrapper gives a non-null type to
                // nullable redirected_response. Read only the request GValue instead.
                let sent=resource_trace.clone(); let sent_path=path.clone();
                resource.connect_local("sent-request",false,move |values| {
                    let path=values.get(1).and_then(|v| v.get::<webkit2gtk::URIRequest>().ok())
                        .and_then(|r| r.uri()).map(|uri| crate::docserve::diagnostic_path(&uri)).unwrap_or_else(|| sent_path.clone());
                    sent.record("native-resource",json!({"id":id,"initialRouteScope":scope,"event":"sent-request","path":path})); None
                });
                let response=resource_trace.clone(); let response_path=path.clone();
                resource.connect_response_notify(move |resource| {
                    if let Some(value)=resource.response() { response.record("native-resource",json!({"id":id,"initialRouteScope":scope,"event":"response","path":response_path,
                        "status":value.status_code(),"contentLength":value.content_length()})); }
                });
                let failed=resource_trace.clone(); let failed_path=path.clone();
                let failed_state=lifecycle.clone();
                resource.connect_failed(move |_,error| {
                    failed_state.set(true);
                    // Error messages/domains can include private URLs; numeric code only.
                    failed.record("native-resource",json!({"id":id,"initialRouteScope":scope,"event":"failed","path":failed_path,"errorDomain":if error.is::<webkit2gtk::NetworkError>() {"webkit-network"} else if error.is::<webkit2gtk::gio::IOErrorEnum>() {"gio-io"} else {"other"},"errorCode":error.kind::<webkit2gtk::NetworkError>().map(ErrorDomain::code).or_else(|| error.kind::<webkit2gtk::gio::IOErrorEnum>().map(ErrorDomain::code))}));
                });
                let finished=resource_trace.clone();
                resource.connect_finished(move |_| { finished.record("native-resource",json!({"id":id,"initialRouteScope":scope,"event":"finished","path":path,"failedBeforeFinish":lifecycle.get()})); });
            });
            trace.record("native-hook",json!({"state":"ready","scope":"main-webview-including-subresources","sentRequestIsWireProof":false,"routeScopeLimit":128,"routeScopeIsDocId":false}));
            trace.ready.store(1,Ordering::Release);
        }).is_err() { self.ready.store(3,Ordering::Release); }
    }
    #[cfg(not(target_os="linux"))]
    pub(crate) fn install(&self,_window:&tauri::WebviewWindow) {
        self.record("native-hook",json!({"state":"unsupported-platform"}));
    }
}

/// Intern only capability-shaped loopback routes. Keys never leave memory;
/// these IDs correlate this webview's resource events, not backend document IDs.
#[derive(Default)]
struct ScopeRegistry { keys:std::collections::HashMap<String,u64> }
impl ScopeRegistry {
    fn scope(&mut self, value:&str) -> Option<u64> {
        if value.len() > 8192 { return None; }
        let uri=url::Url::parse(value).ok()?;
        if uri.scheme() != "http" || uri.host_str() != Some("127.0.0.1") { return None; }
        let token=uri.path().strip_prefix('/')?.split('/').next()?;
        if token.len()!=64 || !token.bytes().all(|c|c.is_ascii_hexdigit()) { return None; }
        let key=format!("{}:{token}",uri.port()?);
        if let Some(id)=self.keys.get(&key) { return Some(*id); }
        if self.keys.len()>=128 { return None; }
        let id=self.keys.len() as u64+1; self.keys.insert(key,id); Some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_scopes_distinguish_documents_but_never_export_capabilities() {
        let mut scopes=ScopeRegistry::default();
        let first=format!("http://127.0.0.1:42/{}/", "ab".repeat(32));
        let second=format!("http://127.0.0.1:42/{}/", "cd".repeat(32));
        assert_eq!(scopes.scope(&first),Some(1));
        assert_eq!(scopes.scope(&format!("{first}_/agent.js?g=99")),Some(1));
        assert_eq!(scopes.scope(&second),Some(2));
        assert_eq!(scopes.scope("https://example.com/private"),None);
        assert_eq!(scopes.scope(&format!("{first}{}","x".repeat(8192))),None);
        assert_eq!(scopes.scope("http://127.0.0.1:42/private/"),None);
        for n in 0..130 { let _=scopes.scope(&format!("http://127.0.0.1:42/{n:064x}/")); }
        assert_eq!(scopes.keys.len(),128);
        assert_eq!(scopes.scope(&format!("http://127.0.0.1:42/{:064x}/",999)),None);
    }
    #[test]
    fn traces_are_flushed_separately_without_affecting_smoke_tallies() {
        let dir=tempfile::tempdir().unwrap(); let path=dir.path().join("sweep.jsonl");
        let trace=Trace::start(&path).unwrap(); trace.record("test",json!({"event":"observed"})); trace.flush();
        let text=std::fs::read_to_string(path.with_extension("trace.jsonl")).unwrap();
        let rows:Vec<Value>=text.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows[0]["event"],"observed"); assert!(rows[0]["elapsedMs"].is_u64()); assert!(rows[0]["clockOriginAtMs"].is_u64()); assert_eq!(rows[1]["kind"],"trace-retention"); assert!(!path.exists());
    }
}
