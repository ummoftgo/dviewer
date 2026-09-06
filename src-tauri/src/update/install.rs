use super::{download::VerifiedDownload, Flavor};
use crate::{
    error::{Error, Result},
    state::DocSource,
};
use parking_lot::Mutex;
use std::{collections::HashSet, process::Command};
use tauri::Manager;

#[derive(Default)]
pub struct RestartAfterExit(Mutex<Option<Vec<String>>>);

/// Called by App::run after Tauri has delivered Exit to its plugins. In
/// particular, the single-instance plugin has released its mutex by this point.
pub fn on_exit(app: &tauri::AppHandle) {
    if let Some(args) = app.state::<RestartAfterExit>().0.lock().take() {
        let result = std::env::current_exe().and_then(|exe| Command::new(exe).args(args).spawn());
        if let Err(error) = result {
            eprintln!("update restart: {error}");
        }
    }
}

pub fn reopen_args<'a>(sources: impl IntoIterator<Item = &'a DocSource>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut args = Vec::new();
    for source in sources {
        let mut source = source;
        while let DocSource::ArchiveEntry { root, .. } = source {
            source = root;
        }
        let arg = match source {
            DocSource::File { path } => format!("--open={path}"),
            DocSource::Url { url } => format!("--open-url={url}"),
            _ => continue,
        };
        if seen.insert(arg.clone()) {
            args.push(arg);
        }
    }
    args
}

/// Windows' argv quoting, with every argument quoted also to protect '/' from
/// the NSIS /ARGS parser. No shell interprets these arguments.
fn quote_nsis(arg: &str) -> Result<String> {
    if arg.contains(['\0', '\r', '\n']) {
        return Err(Error::UpdateManifest);
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
        } else {
            result.extend(std::iter::repeat_n(
                '\\',
                slashes * if ch == '"' { 2 } else { 1 },
            ));
            slashes = 0;
            if ch == '"' {
                result.push('\\');
            }
            result.push(ch);
        }
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    Ok(result)
}

pub fn nsis_parameters(args: &[String]) -> Result<String> {
    let mut parameters = String::from("/S /UPDATE /R");
    if !args.is_empty() {
        parameters.push_str(" /ARGS ");
        parameters.push_str(
            &args
                .iter()
                .map(|arg| quote_nsis(arg))
                .collect::<Result<Vec<_>>>()?
                .join(" "),
        );
    }
    // ShellExecuteW's parameter buffer is a Windows command line, in UTF-16.
    if parameters.encode_utf16().count() > 30000 {
        return Err(Error::UpdateManifest);
    }
    Ok(parameters)
}

pub fn apply(
    app: &tauri::AppHandle,
    download: VerifiedDownload,
    flavor: Flavor,
    args: Vec<String>,
) -> Result<()> {
    if !flavor.can_install(std::env::consts::OS, std::env::consts::ARCH) {
        return Err(Error::UpdateManifest);
    }
    #[cfg(windows)]
    {
        let parameters = nsis_parameters(&args)?;
        validate_executable(&download, flavor)?;
        match flavor {
            Flavor::PortableExe => {
                replace_portable(download.path())?;
                *app.state::<RestartAfterExit>().0.lock() = Some(args);
            }
            Flavor::Nsis => {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::UI::Shell::ShellExecuteW;
                let parameters: Vec<u16> = parameters.encode_utf16().chain(Some(0)).collect();
                let file: Vec<u16> = download
                    .path()
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                // Mark only directories owned by this updater for later cleanup.
                std::fs::write(download.directory().join("dviewer-installer"), b"M22\n")?;
                let result = unsafe {
                    ShellExecuteW(
                        std::ptr::null_mut(),
                        windows_sys::w!("open"),
                        file.as_ptr(),
                        parameters.as_ptr(),
                        std::ptr::null(),
                        0,
                    )
                };
                if result as isize <= 32 {
                    return Err(Error::Io {
                        detail: format!("ShellExecuteW failed ({})", result as isize),
                    });
                }
                // The installer needs its file after the old process exits.
                // Retain the read lock until that exit, then clean on next start.
                app.manage(InstallerFile {
                    _file: download.retain_for_installer(),
                });
            }
            _ => unreachable!(),
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, download, args);
        Err(Error::UpdateManifest)
    }
}

#[cfg(windows)]
struct InstallerFile {
    _file: std::fs::File,
}

#[cfg(windows)]
fn validate_executable(download: &VerifiedDownload, flavor: Flavor) -> Result<()> {
    validate_pe(&download.file, flavor)
}

#[cfg(windows)]
fn validate_pe(mut file: &std::fs::File, flavor: Flavor) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    file.rewind()?;
    let mut dos = [0; 64];
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Err(Error::UpdateManifest);
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if offset > file.metadata()?.len().saturating_sub(6) {
        return Err(Error::UpdateManifest);
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0; 6];
    file.read_exact(&mut pe)?;
    let machine = u16::from_le_bytes([pe[4], pe[5]]);
    if &pe[..4] != b"PE\0\0"
        || !matches!(machine, 0x8664 | 0x014c)
        || (flavor == Flavor::PortableExe && machine != 0x8664)
    {
        return Err(Error::UpdateManifest);
    }
    Ok(())
}

/// self-replace moves the old image away before copying the new one. Keep an
/// independent copy until it succeeds, including when its cleanup helper fails.
#[cfg(windows)]
pub fn replace_portable(new_file: &std::path::Path) -> Result<()> {
    let current = std::env::current_exe()?.canonicalize()?;
    let parent = current.parent().ok_or(Error::UpdateManifest)?;
    let backup = tempfile::Builder::new()
        .prefix(".dviewer-rollback-")
        .tempdir_in(parent)?;
    let original = backup.path().join("original.exe");
    std::fs::copy(&current, &original)?;
    if let Err(error) = self_replace::self_replace(new_file) {
        if !current.exists() {
            if let Err(restore) = std::fs::rename(&original, &current) {
                let saved = backup.keep();
                return Err(Error::Io {
                    detail: format!("{error}; restore: {restore}; backup: {}", saved.display()),
                });
            }
        }
        return Err(error.into());
    }
    Ok(())
}

/// Delete only our marked installer and marker, never recursively. An installer
/// still running may keep its file busy; it will be retried on the next start.
pub fn cleanup_installers() {
    if !cfg!(windows) {
        return;
    }
    let root = std::env::temp_dir();
    cleanup_in(&root);
}

fn cleanup_in(root: &std::path::Path) {
    use std::io::Read;
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("dviewer-update-")
            || !entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
        {
            continue;
        }
        let Ok(marker) = std::fs::File::open(path.join("dviewer-installer")) else {
            continue;
        };
        let mut bytes = Vec::new();
        if marker.take(5).read_to_end(&mut bytes).is_err() || bytes != b"M22\n" {
            continue;
        }
        if std::fs::remove_file(path.join("update.exe")).is_ok() {
            let _ = std::fs::remove_file(path.join("dviewer-installer"));
            let _ = std::fs::remove_dir(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopen_only_originals_without_duplicating_archive_roots() {
        let file = DocSource::File {
            path: "C:/한글 파일/data.json".into(),
        };
        let url = DocSource::Url {
            url: "https://example.com/a?q=1&x=2".into(),
        };
        let entry = file.entry(0, "inner.json".into()).unwrap();
        let args = reopen_args([&file, &url, &DocSource::Text, &entry]);
        let parsed = crate::cli::parse(&args);
        assert_eq!(parsed.request.files, ["C:/한글 파일/data.json"]);
        assert_eq!(parsed.request.urls, ["https://example.com/a?q=1&x=2"]);
        assert!(!parsed.new_window);
    }

    #[test]
    fn nsis_arguments_keep_paths_urls_quotes_and_trailing_slashes() {
        assert_eq!(nsis_parameters(&[]).unwrap(), "/S /UPDATE /R");
        assert_eq!(
            quote_nsis("--open=C:/한글 파일/a.json").unwrap(),
            "\"--open=C:/한글 파일/a.json\""
        );
        assert_eq!(
            quote_nsis("--open-url=https://example.com/a").unwrap(),
            "\"--open-url=https://example.com/a\""
        );
        assert_eq!(quote_nsis("a\"b").unwrap(), "\"a\\\"b\"");
        assert_eq!(quote_nsis("C:\\last\\").unwrap(), "\"C:\\last\\\\\"");
        assert!(nsis_parameters(&["bad\0argument".into()]).is_err());
        assert!(nsis_parameters(&["😀".repeat(16000)]).is_err());
    }

    #[test]
    fn cleanup_only_removes_the_marked_installer_files() {
        let root = tempfile::tempdir().unwrap();
        for (name, marker) in [
            ("dviewer-update-owned", "M22\n"),
            ("dviewer-update-other", "someone else"),
            ("unrelated", "M22\n"),
        ] {
            let dir = root.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("dviewer-installer"), marker).unwrap();
            std::fs::write(dir.join("update.exe"), b"file").unwrap();
            std::fs::write(dir.join("keep.txt"), b"untouched").unwrap();
        }
        cleanup_in(root.path());
        assert!(!root.path().join("dviewer-update-owned/update.exe").exists());
        assert!(root.path().join("dviewer-update-owned/keep.txt").exists());
        assert!(root.path().join("dviewer-update-other/update.exe").exists());
        assert!(root.path().join("unrelated/update.exe").exists());
    }

    #[test]
    #[cfg(windows)]
    fn portable_payload_must_be_a_64_bit_windows_executable() {
        use std::io::Write;
        let mut bytes = [0u8; 128];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(validate_pe(&file, Flavor::PortableExe).is_ok());
        bytes[68..70].copy_from_slice(&0x014cu16.to_le_bytes());
        use std::io::Seek;
        file.rewind().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(validate_pe(&file, Flavor::Nsis).is_ok());
        assert!(validate_pe(&file, Flavor::PortableExe).is_err());
        bytes[0] = b'X';
        file.rewind().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(validate_pe(&file, Flavor::Nsis).is_err());
    }
}
