use super::{Asset, Manifest, UrlPolicy, MAX_MANIFEST_BYTES, MAX_UPDATE_BYTES};
use crate::error::{Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn too_large(limit: u64) -> Error {
    Error::DownloadFailed {
        detail: format!("response exceeds {limit} bytes"),
        limit_mb: limit.div_ceil(1024 * 1024),
    }
}

fn decode_box(encoded: &str) -> Result<String> {
    if encoded.len() > MAX_SIGNATURE_BYTES as usize {
        return Err(Error::UpdateBadSignature);
    }
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| Error::UpdateBadSignature)?;
    String::from_utf8(bytes).map_err(|_| Error::UpdateBadSignature)
}

/// Tauri wraps the complete minisign text in a second Base64 envelope.
pub fn verify(
    reader: &mut impl Read,
    public_key: &str,
    signature: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    let key = PublicKey::decode(&decode_box(public_key)?).map_err(|_| Error::UpdateBadSignature)?;
    let signature =
        Signature::decode(&decode_box(signature)?).map_err(|_| Error::UpdateBadSignature)?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|_| Error::UpdateBadSignature)?;
    let mut buffer = [0; 4096];
    loop {
        check_cancel(cancel)?;
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize().map_err(|_| Error::UpdateBadSignature)
}

fn response(
    url: &str,
    policy: &UrlPolicy,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<ureq::http::Response<ureq::Body>> {
    let mut url = policy.validate(url, false)?;
    for redirects in 0..=5 {
        check_cancel(cancel)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| Error::FetchFailed {
                detail: "update request timed out".into(),
            })?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(remaining))
            .timeout_recv_body(Some(Duration::from_secs(10)))
            .build()
            .into();
        let response = agent
            .get(url.as_str())
            .header("accept-encoding", "identity")
            .call()
            .map_err(|e| Error::FetchFailed {
                detail: e.to_string(),
            })?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == 5 {
                return Err(Error::UpdateManifest);
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or(Error::UpdateManifest)?;
            let next = url.join(location).map_err(|_| Error::UpdateManifest)?;
            url = policy.validate(next.as_str(), true)?;
        } else if response.status().as_u16() == 200 {
            return Ok(response);
        } else {
            return Err(Error::HttpStatus {
                status: response.status().as_u16().to_string(),
            });
        }
    }
    unreachable!()
}

pub fn copy_limited(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    let mut count = 0u64;
    let mut buffer = [0; 4096];
    loop {
        check_cancel(cancel)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or_else(|| too_large(limit))?;
        if count > limit {
            return Err(too_large(limit));
        }
        writer.write_all(&buffer[..read])?;
        progress(count);
    }
    Ok(count)
}

fn receive(
    url: &str,
    policy: &UrlPolicy,
    cancel: &AtomicBool,
    deadline: Instant,
    writer: &mut impl Write,
    limit: u64,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    let mut response = response(url, policy, cancel, deadline)?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if total.is_some_and(|n| n > limit) {
        return Err(too_large(limit));
    }
    progress(0, total);
    copy_limited(
        &mut response.body_mut().as_reader(),
        writer,
        limit,
        cancel,
        |n| progress(n, total),
    )?;
    check_cancel(cancel)
}

pub fn fetch_manifest(
    url: &str,
    policy: &UrlPolicy,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Manifest> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut bytes = Vec::new();
    receive(
        url,
        policy,
        cancel,
        deadline,
        &mut bytes,
        MAX_MANIFEST_BYTES as u64,
        |_, _| {},
    )?;
    let mut signature = Vec::new();
    receive(
        &format!("{url}.sig"),
        policy,
        cancel,
        deadline,
        &mut signature,
        MAX_SIGNATURE_BYTES,
        |_, _| {},
    )?;
    let signature = std::str::from_utf8(&signature).map_err(|_| Error::UpdateBadSignature)?;
    verify(&mut bytes.as_slice(), key, signature, cancel)?;
    Manifest::parse(&bytes, policy)
}

/// Keep this handle alive through the install operation. On Windows it denies
/// other writers and deletion, so the verified path cannot be swapped later.
#[derive(Debug)]
pub struct VerifiedDownload {
    pub(crate) file: File,
    path: PathBuf,
    directory: tempfile::TempDir,
}

impl VerifiedDownload {
    #[cfg(windows)]
    pub(crate) fn retain_for_installer(self) -> File {
        let Self {
            file, directory, ..
        } = self;
        let _ = directory.keep();
        file
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn directory(&self) -> &Path {
        self.directory.path()
    }
    pub fn size(&self) -> Result<u64> {
        Ok(self.file.metadata()?.len())
    }
}

pub fn download(
    asset: &Asset,
    policy: &UrlPolicy,
    key: &str,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<VerifiedDownload> {
    let directory = tempfile::Builder::new()
        .prefix("dviewer-update-")
        .tempdir()?;
    let path = directory.path().join("update.exe");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    receive(
        &asset.url,
        policy,
        cancel,
        Instant::now() + Duration::from_secs(1800),
        &mut file,
        MAX_UPDATE_BYTES,
        progress,
    )?;
    file.sync_all()?;
    drop(file);

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ: no write or delete sharing.
    }
    let mut file = options.open(&path)?;
    if file.metadata()?.len() > MAX_UPDATE_BYTES {
        return Err(too_large(MAX_UPDATE_BYTES));
    }
    // Authenticate after obtaining the protected handle, including any change
    // between closing the writer and opening this reader.
    verify(&mut file, key, &asset.signature, cancel)?;
    file.rewind()?;
    Ok(VerifiedDownload {
        file,
        path,
        directory,
    })
}

#[cfg(test)]
mod tests;
