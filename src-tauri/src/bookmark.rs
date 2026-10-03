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
fn file_fingerprint(mut file: File) -> Result<(String, u64, bool)> {
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
    Ok((format!("v1:{len}:{modified:?}:{digest:016x}"), digest, gzip))
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

fn verify_loaded(loaded: &crate::bytes::DocBytes, disk_digest: u64, gzip: bool) -> Result<()> {
    if !gzip {
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
            let (fingerprint, disk_digest, gzip) = file_fingerprint(File::open(path)?)?;
            // An editor can save before the watcher reloads. Owned source bytes are
            // safe to compare with the same bounded samples, so never save a stale
            // coordinate against a new disk fingerprint. Gzip source bytes have
            // already been decompressed; mapped files retain their existing race
            // limitation and are not touched again merely for a bookmark.
            let loaded = doc.source_bytes();
            verify_loaded(&loaded, disk_digest, gzip)?;
            Ok(fingerprint)
        }
        DocSource::Url { .. } => Ok(bytes_fingerprint(&doc.source_bytes())),
        _ => Err(Error::internal("unsupported bookmark source")),
    })
    .await
    .map_err(Error::internal)?
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
        assert!(verify_loaded(&loaded, bytes_digest(b"still loaded"), false).is_ok());
        assert!(verify_loaded(&loaded, bytes_digest(b"new contents"), false).is_err());
        // Compressed disk samples cannot be compared with decompressed source bytes.
        assert!(verify_loaded(&loaded, bytes_digest(b"compressed"), true).is_ok());
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
        let first = file_fingerprint(File::open(&path).unwrap()).unwrap();
        assert_eq!(first, file_fingerprint(File::open(&path).unwrap()).unwrap());
        std::fs::write(&path, b"other").unwrap();
        assert_ne!(first, file_fingerprint(File::open(&path).unwrap()).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
