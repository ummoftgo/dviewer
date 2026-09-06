use super::{download, install, Flavor, Manifest, UrlPolicy, MANIFEST_URL, RELEASES_URL};
use crate::{
    error::{Error, Result},
    state::AppState,
};
use parking_lot::{Condvar, Mutex};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    check: bool,
    last_check: Option<u64>,
    skipped: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            check: true,
            last_check: None,
            skipped: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    Downloading,
    Installing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub can_install: bool,
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub revision: u64,
    pub configured: bool,
    pub flavor: Flavor,
    pub check: bool,
    pub last_check: Option<u64>,
    pub skipped: Option<String>,
    pub phase: Phase,
    pub available: Option<UpdateInfo>,
    pub progress: Option<Progress>,
    pub error: Option<Error>,
}

struct Inner {
    status: UpdateStatus,
    preferences: Preferences,
    candidate: Option<Manifest>,
}
impl Inner {
    fn new(configured: bool, flavor: Flavor, preferences: Preferences) -> Self {
        Self {
            status: UpdateStatus {
                revision: 0,
                configured,
                flavor,
                check: preferences.check,
                last_check: preferences.last_check,
                skipped: preferences.skipped.clone(),
                phase: Phase::Idle,
                available: None,
                progress: None,
                error: None,
            },
            preferences,
            candidate: None,
        }
    }
    fn changed(&mut self) {
        self.status.revision += 1;
    }
    fn begin(&mut self, phase: Phase) -> Result<()> {
        if !self.status.configured || self.status.phase != Phase::Idle {
            return Err(Error::UpdateUnavailable);
        }
        self.status.phase = phase;
        self.status.error = None;
        self.status.progress = None;
        self.changed();
        Ok(())
    }
    fn accept(&mut self, manifest: Manifest, current: &Version, manual: bool) {
        self.status.available =
            if manifest.is_newer(current, self.preferences.skipped.as_deref(), manual) {
                Some(UpdateInfo {
                    version: manifest.version.clone(),
                    notes: manifest
                        .notes
                        .as_deref()
                        .unwrap_or("")
                        .lines()
                        .take(10)
                        .collect::<Vec<_>>()
                        .join("\n"),
                    published_at: manifest.pub_date.clone(),
                    can_install: self
                        .status
                        .flavor
                        .can_install(std::env::consts::OS, std::env::consts::ARCH)
                        && manifest
                            .asset(
                                self.status.flavor,
                                std::env::consts::OS,
                                std::env::consts::ARCH,
                            )
                            .is_some(),
                    release_url: format!("{RELEASES_URL}/tag/v{}", manifest.version),
                })
            } else {
                None
            };
        self.candidate = Some(manifest);
    }
}

pub struct Updater {
    inner: Mutex<Inner>,
    wake: Condvar,
    cancel: AtomicBool,
    stopped: AtomicBool,
    key: String,
    url: String,
    policy: UrlPolicy,
    version: Version,
    store: Option<Arc<tauri_plugin_store::Store<tauri::Wry>>>,
}

impl Updater {
    pub fn start(app: &tauri::AppHandle, smoke: bool) -> Arc<Self> {
        let key = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|v| v.get("pubkey"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_owned();
        let (url, policy, valid) = endpoint();
        let store = if smoke {
            None
        } else {
            match app.store("dviewer.json") {
                Ok(store) => Some(store),
                Err(error) => {
                    eprintln!("update settings: {error}");
                    None
                }
            }
        };
        let preferences = store
            .as_ref()
            .and_then(|s| s.get("updates"))
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let configured = !smoke && valid && !key.is_empty();
        let updater = Arc::new(Self {
            inner: Mutex::new(Inner::new(configured, Flavor::current(), preferences)),
            wake: Condvar::new(),
            cancel: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            key,
            url,
            policy,
            version: app.package_info().version.clone(),
            store,
        });
        if configured {
            let worker = Arc::clone(&updater);
            let app = app.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("update-check".into())
                .spawn(move || worker.run(app))
            {
                eprintln!("update thread: {error}");
            }
        }
        updater
    }

    fn run(&self, app: tauri::AppHandle) {
        let mut next = Instant::now() + Duration::from_secs(300);
        loop {
            let mut inner = self.inner.lock();
            if self.stopped.load(Ordering::Relaxed) {
                return;
            }
            self.wake
                .wait_for(&mut inner, next.saturating_duration_since(Instant::now()));
            if self.stopped.load(Ordering::Relaxed) {
                return;
            }
            if Instant::now() < next {
                continue;
            }
            next = Instant::now() + Duration::from_secs(3600);
            let enabled = inner.preferences.check && inner.status.phase == Phase::Idle;
            drop(inner);
            if enabled && !app.webview_windows().is_empty() {
                if let Err(error) = self.check_now(&app, false) {
                    eprintln!("update check: {error}");
                }
            }
        }
    }

    pub fn stop(&self) {
        let _inner = self.inner.lock();
        self.stopped.store(true, Ordering::Relaxed);
        self.cancel.store(true, Ordering::Relaxed);
        self.wake.notify_all();
    }
    pub fn status(&self) -> UpdateStatus {
        self.inner.lock().status.clone()
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let _ = app.emit("update:state", self.status());
    }
    fn persist(&self, inner: &Inner) -> Result<()> {
        if self.stopped.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let store = self.store.as_ref().ok_or(Error::UpdateUnavailable)?;
        store.set("updates", serde_json::json!(inner.preferences));
        store.save().map_err(|e| Error::Io {
            detail: e.to_string(),
        })
    }

    pub fn check_now(&self, app: &tauri::AppHandle, manual: bool) -> Result<UpdateStatus> {
        {
            let mut inner = self.inner.lock();
            if self.stopped.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            inner.begin(Phase::Checking)?;
            self.cancel.store(false, Ordering::Relaxed);
        }
        self.publish(app);
        let result = download::fetch_manifest(&self.url, &self.policy, &self.key, &self.cancel);
        let mut inner = self.inner.lock();
        inner.status.phase = Phase::Idle;
        inner.preferences.last_check = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        inner.status.last_check = inner.preferences.last_check;
        let failure = match result {
            Ok(manifest) => {
                inner.accept(manifest, &self.version, manual);
                None
            }
            Err(error) => Some(error),
        };
        let storage_failure = self.persist(&inner).err();
        let failure = failure.or(storage_failure);
        if manual {
            inner.status.error = failure.clone();
        }
        inner.changed();
        drop(inner);
        self.publish(app);
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(self.status())
        }
    }

    pub fn set_check(&self, app: &tauri::AppHandle, check: bool) -> Result<UpdateStatus> {
        let mut inner = self.inner.lock();
        inner.preferences.check = check;
        inner.status.check = check;
        inner.changed();
        let result = self.persist(&inner);
        drop(inner);
        self.wake.notify_all();
        self.publish(app);
        result.map(|_| self.status())
    }

    pub fn skip(&self, app: &tauri::AppHandle, version: String) -> Result<UpdateStatus> {
        let mut inner = self.inner.lock();
        if inner.status.phase != Phase::Idle
            || inner.status.available.as_ref().map(|v| &v.version) != Some(&version)
        {
            return Err(Error::UpdateUnavailable);
        }
        inner.preferences.skipped = Some(version.clone());
        inner.status.skipped = Some(version);
        inner.status.available = None;
        inner.changed();
        let result = self.persist(&inner);
        drop(inner);
        self.publish(app);
        result.map(|_| self.status())
    }

    pub fn install(&self, app: &tauri::AppHandle, version: &str) -> Result<UpdateStatus> {
        let (asset, flavor) = {
            let mut inner = self.inner.lock();
            if self.stopped.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let available = inner
                .status
                .available
                .as_ref()
                .ok_or(Error::UpdateUnavailable)?;
            if available.version != version || !available.can_install {
                return Err(Error::UpdateUnavailable);
            }
            let flavor = inner.status.flavor;
            let asset = inner
                .candidate
                .as_ref()
                .and_then(|m| m.asset(flavor, std::env::consts::OS, std::env::consts::ARCH))
                .cloned()
                .ok_or(Error::UpdateUnavailable)?;
            inner.begin(Phase::Downloading)?;
            self.cancel.store(false, Ordering::Relaxed);
            (asset, flavor)
        };
        self.publish(app);
        let mut last_progress = Instant::now() - Duration::from_secs(1);
        let result = download::download(
            &asset,
            &self.policy,
            &self.key,
            &self.cancel,
            |received, total| {
                if last_progress.elapsed() < Duration::from_millis(100) && Some(received) != total {
                    return;
                }
                last_progress = Instant::now();
                {
                    let mut inner = self.inner.lock();
                    inner.status.progress = Some(Progress { received, total });
                    inner.changed();
                }
                self.publish(app);
            },
        )
        .and_then(|file| {
            {
                let mut inner = self.inner.lock();
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(Error::Cancelled);
                }
                inner.status.phase = Phase::Installing;
                inner.changed();
            }
            self.publish(app);
            let state = app.state::<AppState>();
            let mut ids: Vec<_> = app
                .webview_windows()
                .keys()
                .flat_map(|label| state.docs_owned_by(label))
                .collect();
            ids.sort_unstable();
            ids.dedup();
            let docs: Vec<_> = ids.iter().filter_map(|id| state.get(*id).ok()).collect();
            let args = install::reopen_args(docs.iter().map(|doc| &doc.source));
            install::apply(app, file, flavor, args)
        });
        if let Err(error) = result {
            let mut inner = self.inner.lock();
            inner.status.phase = Phase::Idle;
            inner.status.progress = None;
            inner.status.error = if self.cancel.load(Ordering::Relaxed) {
                None
            } else {
                Some(error.clone())
            };
            inner.changed();
            drop(inner);
            self.publish(app);
            if !self.cancel.load(Ordering::Relaxed) {
                return Err(error);
            }
        }
        Ok(self.status())
    }
}

fn endpoint() -> (String, UrlPolicy, bool) {
    #[cfg(debug_assertions)]
    if let Ok(local) = std::env::var("DVIEWER_UPDATE_MANIFEST") {
        return match UrlPolicy::development(&local) {
            Ok(policy) => (local, policy, true),
            Err(error) => {
                eprintln!("update configuration: {error}");
                (MANIFEST_URL.into(), UrlPolicy::default(), false)
            }
        };
    }
    (MANIFEST_URL.into(), UrlPolicy::default(), true)
}

#[tauri::command]
pub fn update_status(updater: tauri::State<'_, Arc<Updater>>) -> UpdateStatus {
    updater.status()
}
#[tauri::command]
pub fn update_set_check(
    app: tauri::AppHandle,
    updater: tauri::State<'_, Arc<Updater>>,
    check: bool,
) -> Result<UpdateStatus> {
    updater.set_check(&app, check)
}
#[tauri::command]
pub fn update_skip(
    app: tauri::AppHandle,
    updater: tauri::State<'_, Arc<Updater>>,
    version: String,
) -> Result<UpdateStatus> {
    updater.skip(&app, version)
}
#[tauri::command]
pub fn update_cancel(updater: tauri::State<'_, Arc<Updater>>) {
    if updater.inner.lock().status.phase == Phase::Downloading {
        updater.cancel.store(true, Ordering::Relaxed);
    }
}
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateStatus> {
    let updater = Arc::clone(app.state::<Arc<Updater>>().inner());
    tauri::async_runtime::spawn_blocking(move || updater.check_now(&app, true))
        .await
        .map_err(|e| Error::Internal {
            detail: e.to_string(),
        })?
}
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, version: String) -> Result<UpdateStatus> {
    let updater = Arc::clone(app.state::<Arc<Updater>>().inner());
    tauri::async_runtime::spawn_blocking(move || updater.install(&app, &version))
        .await
        .map_err(|e| Error::Internal {
            detail: e.to_string(),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate() -> Manifest {
        Manifest::parse(
            &super::super::tests::manifest("0.14.0"),
            &UrlPolicy::default(),
        )
        .unwrap()
    }
    #[test]
    fn checking_and_downloading_cannot_overlap_across_windows() {
        let mut inner = Inner::new(true, Flavor::PortableExe, Preferences::default());
        inner.begin(Phase::Checking).unwrap();
        assert_eq!(
            inner.begin(Phase::Downloading),
            Err(Error::UpdateUnavailable)
        );
        inner.status.phase = Phase::Idle;
        inner.begin(Phase::Downloading).unwrap();
        assert_eq!(inner.begin(Phase::Checking), Err(Error::UpdateUnavailable));
    }
    #[test]
    fn no_signing_key_disables_all_work() {
        let mut inner = Inner::new(false, Flavor::PortableExe, Preferences::default());
        assert_eq!(inner.begin(Phase::Checking), Err(Error::UpdateUnavailable));
        assert_eq!(
            inner.begin(Phase::Downloading),
            Err(Error::UpdateUnavailable)
        );
    }
    #[test]
    fn skipped_automatic_candidate_remains_visible_to_manual_check() {
        let mut inner = Inner::new(
            true,
            Flavor::PortableExe,
            Preferences {
                skipped: Some("0.14.0".into()),
                ..Default::default()
            },
        );
        inner.accept(candidate(), &Version::new(0, 13, 0), false);
        assert!(inner.status.available.is_none());
        inner.accept(candidate(), &Version::new(0, 13, 0), true);
        assert_eq!(inner.status.available.unwrap().version, "0.14.0");
    }
    #[test]
    fn link_only_flavor_never_offers_install_and_notes_are_ten_lines() {
        let mut inner = Inner::new(true, Flavor::Msi, Preferences::default());
        let mut manifest = candidate();
        manifest.notes = Some(
            (0..20)
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        inner.accept(manifest, &Version::new(0, 13, 0), true);
        let info = inner.status.available.unwrap();
        assert!(!info.can_install);
        assert_eq!(info.notes.lines().count(), 10);
    }
    #[test]
    fn partial_preferences_keep_defaults_and_status_has_a_revision() {
        let saved: Preferences =
            serde_json::from_value(serde_json::json!({"skipped":"0.14.0"})).unwrap();
        assert!(saved.check);
        let mut inner = Inner::new(true, Flavor::PortableExe, saved);
        let before = inner.status.revision;
        inner.begin(Phase::Checking).unwrap();
        assert!(inner.status.revision > before);
        assert_eq!(inner.status.skipped.as_deref(), Some("0.14.0"));
    }
}
