//! Bounded source fingerprints for durable reading locations, never whole-file hashing.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};
use crate::state::{AppState, DocId, DocSource};
use tauri::State;

const SAMPLE: usize = 4096;
const BASIS: u64 = 0xcbf29ce484222325;
fn hash(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    hash
}
fn offsets(len: u64) -> [u64; 3] {
    [
        0,
        len.saturating_sub(SAMPLE as u64) / 2,
        len.saturating_sub(SAMPLE as u64),
    ]
}
fn file_fingerprint(file: &mut File) -> Result<(String, u64, bool, u64)> {
    let before = file.metadata()?;
    let len = before.len();
    let modified = before
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos());
    let mut digest = hash(BASIS, &len.to_le_bytes());
    let mut sample = [0; SAMPLE];
    let mut gzip = false;
    for offset in offsets(len) {
        file.seek(SeekFrom::Start(offset))?;
        let count = (len - offset).min(SAMPLE as u64) as usize;
        file.read_exact(&mut sample[..count])?;
        if offset == 0 && count >= 2 {
            gzip = sample[..2] == [0x1f, 0x8b];
        }
        digest = hash(hash(digest, &offset.to_le_bytes()), &sample[..count]);
    }
    let after = file.metadata()?;
    if len != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(Error::internal("source changed while fingerprinting"));
    }
    Ok((
        format!("v1:{len}:{modified:?}:{digest:016x}"),
        digest,
        gzip,
        len,
    ))
}
fn same_file_metadata(before: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    if before.len() != current.len() || before.modified().ok() != current.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != current.dev() || before.ino() != current.ino() {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> std::io::Result<(u64, [u8; 16])> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut info = FILE_ID_INFO::default();
    // SAFETY: the borrowed File keeps the handle open, and info is a valid,
    // correctly sized FILE_ID_INFO buffer for the requested information class.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // Use the full 128-bit ID: the older 64-bit file index is not unique on ReFS.
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

fn checked_file_fingerprint(
    mut file: File,
    path: &std::path::Path,
) -> Result<(String, u64, bool, u64)> {
    let before = file.metadata()?;
    let sampled = file_fingerprint(&mut file)?;
    // An atomic editor save can replace the pathname while this handle still
    // points at the previous file. Validate the path as well as the open handle.
    // Keep both handles open through the comparison so file IDs cannot be reused.
    let current = File::open(path)?;
    if !same_file_metadata(&before, &current.metadata()?) {
        return Err(Error::internal("source replaced while fingerprinting"));
    }
    #[cfg(windows)]
    if windows_file_identity(&file)? != windows_file_identity(&current)? {
        return Err(Error::internal("source replaced while fingerprinting"));
    }
    Ok(sampled)
}
fn bytes_digest(bytes: &[u8]) -> u64 {
    let len = bytes.len() as u64;
    let mut digest = hash(BASIS, &len.to_le_bytes());
    for offset in offsets(len) {
        let start = offset as usize;
        digest = hash(
            hash(digest, &offset.to_le_bytes()),
            &bytes[start..(start + SAMPLE).min(bytes.len())],
        );
    }
    digest
}
fn bytes_fingerprint(bytes: &[u8]) -> String {
    format!("v1:{}:url:{:016x}", bytes.len(), bytes_digest(bytes))
}

fn verify_loaded(
    loaded: &crate::bytes::DocBytes,
    disk_digest: u64,
    gzip: bool,
    disk_len: u64,
) -> Result<()> {
    if !gzip {
        // Reading a cached node after truncation may touch an inaccessible mmap
        // page. Its recorded length is safe to inspect; do not sample that map.
        if loaded.len() as u64 != disk_len {
            return Err(Error::internal(
                "source size changed; reload before bookmarking",
            ));
        }
        if let crate::bytes::DocBytes::Owned(bytes) = loaded {
            if bytes_digest(bytes) != disk_digest {
                return Err(Error::internal("source changed; reload before bookmarking"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn bookmark_fingerprint(state: State<'_, AppState>, doc_id: DocId) -> Result<String> {
    let doc = state.get(doc_id)?;
    tauri::async_runtime::spawn_blocking(move || match &doc.source {
        DocSource::File { path } => {
            let (fingerprint, disk_digest, gzip, disk_len) =
                checked_file_fingerprint(File::open(path)?, std::path::Path::new(path))?;
            // An editor can save before the watcher reloads. Owned source bytes are
            // safe to compare with the same bounded samples, so never save a stale
            // coordinate against a new disk fingerprint. Gzip source bytes have
            // already been decompressed; mapped files retain their existing race
            // limitation and are not touched again merely for a bookmark.
            let loaded = doc.source_bytes();
            verify_loaded(&loaded, disk_digest, gzip, disk_len)?;
            Ok(fingerprint)
        }
        DocSource::Url { .. } => Ok(bytes_fingerprint(&doc.source_bytes())),
        _ => Err(Error::internal("unsupported bookmark source")),
    })
    .await
    .map_err(Error::internal)?
}

#[tauri::command]
pub fn bookmark_log_line(
    state: State<'_, AppState>,
    doc_id: DocId,
    row: u32,
    plain: bool,
) -> Result<Option<u32>> {
    let doc = state.get(doc_id)?;
    if doc.kind() != crate::state::DocKind::Text {
        return Ok(None);
    }
    Ok(doc.table().and_then(|table| table.source_line(row, plain)))
}

#[tauri::command]
pub fn bookmark_log_row(
    state: State<'_, AppState>,
    doc_id: DocId,
    line: u32,
    plain: bool,
) -> Result<Option<u32>> {
    let doc = state.get(doc_id)?;
    if doc.kind() != crate::state::DocKind::Text {
        return Ok(None);
    }
    Ok(doc
        .table()
        .and_then(|table| table.row_for_source_line(line, plain)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_samples_detect_equal_length_changes_at_each_sample() {
        let bytes = vec![b'a'; SAMPLE * 10];
        let original = bytes_fingerprint(&bytes);
        for offset in offsets(bytes.len() as u64) {
            let mut changed = bytes.clone();
            changed[offset as usize] = b'b';
            assert_ne!(original, bytes_fingerprint(&changed));
        }
        assert_eq!(original, bytes_fingerprint(&bytes));
        assert_ne!(bytes_fingerprint(b"abc"), bytes_fingerprint(b"abd"));
        assert_ne!(bytes_fingerprint(b"abc"), bytes_fingerprint(b"abcd"));
        assert_eq!(bytes_fingerprint(b""), bytes_fingerprint(b""));
    }
    #[test]
    fn loaded_owned_samples_match_the_disk_digest_and_reject_stale_content() {
        let loaded = crate::bytes::DocBytes::from(b"still loaded".to_vec());
        assert!(verify_loaded(&loaded, bytes_digest(b"still loaded"), false, 12).is_ok());
        assert!(verify_loaded(&loaded, bytes_digest(b"new contents"), false, 12).is_err());
        // Compressed disk samples cannot be compared with decompressed source bytes.
        assert!(verify_loaded(&loaded, bytes_digest(b"compressed"), true, 10).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn truncated_mapped_source_is_rejected_without_reading_inaccessible_sample_pages() {
        let dir = std::env::temp_dir().join(format!(
            "dviewer-bookmark-truncate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("source");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.set_len(8192).unwrap();
        // SAFETY: the test never reads the mapped contents, including after
        // deliberately truncating the backing file. Only its length is used.
        let mapped = unsafe { memmap2::Mmap::map(&file).unwrap() };
        let loaded = crate::bytes::DocBytes::Mapped(mapped);
        file.set_len(0).unwrap();
        assert!(verify_loaded(&loaded, bytes_digest(b""), false, 0).is_err());
        drop(loaded);
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_path_replacement_cannot_verify_samples_from_the_previous_handle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source");
        let replacement = dir.path().join("replacement");
        std::fs::write(&path, b"first").unwrap();
        let opened = File::open(&path).unwrap();
        let before = opened.metadata().unwrap();
        std::fs::write(&replacement, b"other").unwrap();
        // Match both metadata fields deliberately: rejection must depend on file
        // identity, not the filesystem's timestamp precision or test timing.
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(before.modified().unwrap())
            .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let current = std::fs::metadata(&path).unwrap();
        assert_eq!(before.len(), current.len());
        assert_eq!(before.modified().unwrap(), current.modified().unwrap());
        assert!(checked_file_fingerprint(opened, &path).is_err());
        assert!(checked_file_fingerprint(File::open(&path).unwrap(), &path).is_ok());
    }
    #[test]
    fn checked_sampling_accepts_the_same_file_and_its_hard_link() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source");
        let alias = dir.path().join("alias");
        std::fs::write(&path, b"same source").unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        let expected = file_fingerprint(&mut File::open(&path).unwrap()).unwrap();
        assert_eq!(
            expected,
            checked_file_fingerprint(File::open(&path).unwrap(), &path).unwrap()
        );
        assert_eq!(
            expected,
            checked_file_fingerprint(File::open(&path).unwrap(), &alias).unwrap()
        );
    }
    #[test]
    fn file_sampling_matches_repeated_reads_and_equal_length_rewrite() {
        let dir = std::env::temp_dir().join(format!(
            "dviewer-bookmark-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("source");
        std::fs::write(&path, b"first").unwrap();
        let first = file_fingerprint(&mut File::open(&path).unwrap()).unwrap();
        assert_eq!(
            first,
            file_fingerprint(&mut File::open(&path).unwrap()).unwrap()
        );
        std::fs::write(&path, b"other").unwrap();
        assert_ne!(
            first,
            file_fingerprint(&mut File::open(&path).unwrap()).unwrap()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
