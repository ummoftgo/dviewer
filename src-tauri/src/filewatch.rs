//! Best-effort change notifications, coalesced per open file rather than per OS event.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use parking_lot::{Condvar, Mutex};

use crate::state::DocId;

const DEBOUNCE: Duration = Duration::from_millis(300);

pub(crate) fn normalize(path: &Path) -> std::io::Result<PathBuf> {
    path.canonicalize()
}

fn changed_paths(event: &Event) -> &[PathBuf] {
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Any) => {
            &event.paths
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            event.paths.get(1..).unwrap_or_default()
        }
        EventKind::Modify(ModifyKind::Name(
            RenameMode::To | RenameMode::Any | RenameMode::Other,
        )) => &event.paths,
        _ => &[],
    }
}

#[derive(Default)]
struct Registry {
    files: HashMap<PathBuf, HashMap<DocId, String>>,
    documents: HashMap<DocId, PathBuf>,
    parents: HashMap<PathBuf, usize>,
    pending: HashMap<PathBuf, Instant>,
    stopped: bool,
}

impl Registry {
    fn changed(&mut self, path: PathBuf, now: Instant) {
        if self.files.contains_key(&path) {
            // Continuous writers still get a delivery after the first interval.
            self.pending.entry(path).or_insert(now + DEBOUNCE);
        }
    }

    fn register(&mut self, id: DocId, path: PathBuf, window: String) -> bool {
        let parent = path
            .parent()
            .expect("a canonical file has a parent")
            .to_owned();
        self.documents.insert(id, path.clone());
        self.files.entry(path).or_default().insert(id, window);
        let count = self.parents.entry(parent).or_default();
        *count += 1;
        *count == 1
    }

    fn remove(&mut self, id: DocId) -> Option<PathBuf> {
        let path = self.documents.remove(&id)?;
        let documents = self.files.get_mut(&path)?;
        documents.remove(&id);
        if documents.is_empty() {
            self.files.remove(&path);
            self.pending.remove(&path);
        }
        let parent = path.parent()?.to_owned();
        let count = self.parents.get_mut(&parent)?;
        *count -= 1;
        if *count == 0 {
            self.parents.remove(&parent);
            Some(parent)
        } else {
            None
        }
    }
}

pub(crate) struct FileWatch {
    watcher: RecommendedWatcher,
    shared: Arc<(Mutex<Registry>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

impl FileWatch {
    pub fn new(mut changed: impl FnMut(DocId, &str) + Send + 'static) -> notify::Result<Self> {
        let shared = Arc::new((Mutex::new(Registry::default()), Condvar::new()));
        let incoming = shared.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    eprintln!("[dviewer] file watch: {error}");
                    return;
                }
            };
            let paths: Vec<_> = changed_paths(&event)
                .iter()
                .filter_map(|path| normalize(path).ok())
                .collect();
            let (state, wake) = &*incoming;
            let mut state = state.lock();
            for path in paths {
                state.changed(path, Instant::now());
            }
            wake.notify_one();
        })?;
        let processing = shared.clone();
        let worker = std::thread::spawn(move || {
            let (state, wake) = &*processing;
            loop {
                let mut state = state.lock();
                if state.stopped {
                    break;
                }
                let Some(deadline) = state.pending.values().copied().min() else {
                    wake.wait(&mut state);
                    continue;
                };
                let now = Instant::now();
                if deadline > now {
                    wake.wait_for(&mut state, deadline - now);
                    continue;
                }
                let paths: Vec<_> = state
                    .pending
                    .iter()
                    .filter(|(_, deadline)| **deadline <= now)
                    .map(|(path, _)| path.clone())
                    .collect();
                let mut deliveries = Vec::new();
                for path in paths {
                    state.pending.remove(&path);
                    if let Some(documents) = state.files.get(&path) {
                        for (id, window) in documents {
                            deliveries.push((path.clone(), *id, window.clone()));
                        }
                    }
                }
                drop(state);
                for (path, id, window) in deliveries {
                    if path.is_file() {
                        changed(id, &window);
                    }
                }
            }
        });
        Ok(Self {
            watcher,
            shared,
            worker: Some(worker),
        })
    }

    pub fn register(&mut self, id: DocId, path: PathBuf, window: String) -> notify::Result<()> {
        self.remove(id);
        let parent = path.parent().expect("canonical file parent").to_owned();
        let first = self.shared.0.lock().register(id, path, window);
        if first {
            // Never hold the registry lock while waiting on a watcher backend.
            if let Err(error) = self.watcher.watch(&parent, RecursiveMode::NonRecursive) {
                self.shared.0.lock().remove(id);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn remove(&mut self, id: DocId) {
        let parent = self.shared.0.lock().remove(id);
        if let Some(parent) = parent {
            let _ = self.watcher.unwatch(&parent);
        }
    }
}

impl Drop for FileWatch {
    fn drop(&mut self) {
        self.shared.0.lock().stopped = true;
        self.shared.1.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::CreateKind;

    #[test]
    fn continuous_writes_keep_the_first_deadline_until_delivery() {
        let path = std::env::temp_dir().join("continuous.log");
        let mut registry = Registry::default();
        registry.register(1, path.clone(), "main".into());
        let start = Instant::now();
        for millis in [0, 100, 200, 299, 400, 500] {
            registry.changed(path.clone(), start + Duration::from_millis(millis));
            assert_eq!(registry.pending[&path], start + DEBOUNCE);
        }
        registry.pending.remove(&path);
        let next = start + Duration::from_secs(1);
        registry.changed(path.clone(), next);
        assert_eq!(registry.pending[&path], next + DEBOUNCE);
        registry.remove(1);
        registry.changed(path, next);
        assert!(registry.pending.is_empty());
    }

    #[test]
    fn registrations_share_the_parent_until_the_last_document_leaves() {
        let parent = std::env::temp_dir();
        let first = parent.join("first.json");
        let second = parent.join("second.json");
        let mut registry = Registry::default();
        assert!(registry.register(1, first.clone(), "main".into()));
        assert!(!registry.register(2, first, "doc-1".into()));
        assert!(!registry.register(3, second.clone(), "main".into()));
        registry.pending.insert(second, Instant::now());
        assert!(registry.remove(1).is_none());
        assert!(registry.remove(2).is_none());
        assert_eq!(registry.remove(3), Some(parent));
        assert!(
            registry.files.is_empty() && registry.pending.is_empty() && registry.parents.is_empty()
        );
    }

    #[test]
    fn rename_uses_the_destination_and_ignores_outgoing_and_access_events() {
        let from = PathBuf::from("temporary");
        let to = PathBuf::from("document");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(from.clone())
            .add_path(to.clone());
        assert_eq!(changed_paths(&event), std::slice::from_ref(&to));
        assert!(changed_paths(
            &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(from)
        )
        .is_empty());
        assert!(changed_paths(
            &Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(to.clone())
        )
        .is_empty());
        assert_eq!(
            changed_paths(&Event::new(EventKind::Create(CreateKind::File)).add_path(to.clone())),
            [to]
        );
    }

    #[test]
    fn a_real_write_notifies_only_the_registered_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.md");
        std::fs::write(&path, "before").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher = FileWatch::new(move |id, window| {
            let _ = sender.send((id, window.to_owned()));
        })
        .unwrap();
        watcher
            .register(7, normalize(&path).unwrap(), "main".into())
            .unwrap();
        std::fs::write(&path, "after").unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
            (7, "main".into())
        );
        watcher.remove(7);
    }
}
