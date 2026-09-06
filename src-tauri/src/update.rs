//! Signed update metadata and the small set of distributions we can replace.

use crate::error::{Error, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use tauri::utils::config::BundleType;
use url::Url;

pub const MANIFEST_URL: &str =
    "https://github.com/ummoftgo/dviewer/releases/latest/download/latest.json";
pub const RELEASES_URL: &str = "https://github.com/ummoftgo/dviewer/releases";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_UPDATE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Flavor {
    Nsis,
    Msi,
    PortableExe,
    MacApp,
    AppImage,
    Package,
    Unknown,
}

impl Flavor {
    pub fn current() -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        Self::detect(
            std::env::consts::OS,
            tauri::utils::platform::bundle_type(),
            &exe,
        )
    }

    pub fn detect(os: &str, bundle: Option<BundleType>, exe: &Path) -> Self {
        match (os, bundle) {
            ("windows", Some(BundleType::Nsis)) => Self::Nsis,
            ("windows", Some(BundleType::Msi)) => Self::Msi,
            ("windows", None)
                if exe
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("exe")) =>
            {
                Self::PortableExe
            }
            ("macos", _)
                if exe
                    .ancestors()
                    .any(|p| p.extension().is_some_and(|s| s == "app")) =>
            {
                Self::MacApp
            }
            ("linux", Some(BundleType::AppImage)) => Self::AppImage,
            ("linux", Some(BundleType::Deb | BundleType::Rpm)) => Self::Package,
            _ => Self::Unknown,
        }
    }

    pub fn can_install(self, os: &str, arch: &str) -> bool {
        os == "windows" && arch == "x86_64" && matches!(self, Self::Nsis | Self::PortableExe)
    }

    pub fn platform_key(self, os: &str, arch: &str) -> String {
        match self {
            Self::Nsis => format!("windows-{arch}-nsis"),
            Self::Msi => format!("windows-{arch}-msi"),
            Self::PortableExe => format!("windows-{arch}-portable"),
            Self::MacApp => format!("darwin-{arch}"),
            _ => format!("{os}-{arch}"),
        }
    }
}

/// The loopback exception exists only in debug builds, and only for one origin.
#[derive(Debug, Clone, Default)]
pub struct UrlPolicy {
    local_origin: Option<Url>,
}

impl UrlPolicy {
    pub fn development(manifest: &str) -> Result<Self> {
        let url = Url::parse(manifest).map_err(|_| Error::UpdateManifest)?;
        if !cfg!(debug_assertions)
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::UpdateManifest);
        }
        Ok(Self {
            local_origin: Some(url),
        })
    }

    pub fn validate(&self, input: &str, redirect: bool) -> Result<Url> {
        let bad = || Error::BadUrl {
            url: input.to_owned(),
        };
        let url = Url::parse(input).map_err(|_| bad())?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(bad());
        }
        if cfg!(debug_assertions)
            && self
                .local_origin
                .as_ref()
                .is_some_and(|local| local.origin() == url.origin())
        {
            return Ok(url);
        }
        if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
            return Err(bad());
        }
        let repository = url.host_str() == Some("github.com")
            && url.path().starts_with("/ummoftgo/dviewer/releases/")
            && !url.path().contains('%')
            && url.query().is_none();
        let asset_redirect =
            redirect && url.host_str() == Some("release-assets.githubusercontent.com");
        if !repository && !asset_redirect {
            return Err(bad());
        }
        Ok(url)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub url: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub platforms: BTreeMap<String, Asset>,
}

impl Manifest {
    /// Call only after authenticating these exact bytes with latest.json.sig.
    pub fn parse(bytes: &[u8], policy: &UrlPolicy) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::UpdateManifest);
        }
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| Error::UpdateManifest)?;
        Version::parse(&manifest.version).map_err(|_| Error::UpdateManifest)?;
        if manifest.platforms.is_empty() {
            return Err(Error::UpdateManifest);
        }
        for asset in manifest.platforms.values() {
            policy.validate(&asset.url, false)?;
            if asset.signature.trim().is_empty() {
                return Err(Error::UpdateManifest);
            }
        }
        Ok(manifest)
    }

    pub fn is_newer(&self, current: &Version, skipped: Option<&str>, manual: bool) -> bool {
        let Ok(version) = Version::parse(&self.version) else {
            return false;
        };
        version.pre.is_empty()
            && version.cmp_precedence(current).is_gt()
            && (manual || skipped != Some(self.version.as_str()))
    }

    pub fn asset(&self, flavor: Flavor, os: &str, arch: &str) -> Option<&Asset> {
        self.platforms.get(&flavor.platform_key(os, arch))
    }
}

#[cfg(test)]
mod tests;
