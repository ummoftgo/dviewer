use std::fs::File;
use std::io::Cursor;
use std::ops::Deref;
use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use memmap2::Mmap;
use parquet::errors::{ParquetError, Result as ParquetResult};
use parquet::file::reader::{ChunkReader, Length};

use crate::error::Result;

// Small files must not retain a mapping that can block an editor's save,
// deletion or rename, or fault after truncation. Large files stay mapped to
// avoid copying their entire contents into the heap.
const OWNED_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn keeps_in_memory(len: u64) -> bool {
    len <= OWNED_MAX_BYTES
}

/// The bytes of an open document.
///
/// Local files up to 64 MiB are copied; larger files are memory-mapped so a
/// 500MB JSON never enters the heap. URL and pasted content arrives as an owned
/// buffer. Everything downstream works against `&[u8]` regardless of storage.
///
/// A mapped file that changes on disk under us is a real hazard, and a bigger
/// one than it first looks. Content edited in place gives torn reads, which a
/// read-only viewer can live with — reopen and the question goes away. But a
/// file *truncated* while mapped is different: on Linux and macOS, touching a
/// page past the new end raises SIGBUS and takes the process with it, with no
/// error to report and nothing to catch. Windows saves can also succeed while
/// mapped; access to an invalidated mapping can then produce an in-page error.
/// Watching and remapping narrows the stale interval but does not make reads
/// concurrent with external writes safe.
///
/// The owned copy removes this mapping hazard for small files. For larger
/// files the memory cost of copying would defeat the reason the map exists,
/// so the risk remains documented in the README's known limitations.
pub enum DocBytes {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

impl DocBytes {
    pub fn map_file(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        if keeps_in_memory(len) {
            return Ok(Self::Owned(std::fs::read(path)?));
        }
        // SAFETY: we never write through the map, and the map is dropped with
        // the document. External modification is the accepted risk documented
        // above; on Unix a truncation here is fatal to the process.
        let mmap = unsafe { Mmap::map(&file)? };
        Ok(Self::Mapped(mmap))
    }

    pub fn len(&self) -> usize {
        self.deref().len()
    }
}

impl Deref for DocBytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            Self::Mapped(m) => m,
            Self::Owned(v) => v,
        }
    }
}

impl From<Vec<u8>> for DocBytes {
    fn from(v: Vec<u8>) -> Self {
        Self::Owned(v)
    }
}

/// Decode as UTF-8, stripping a BOM and replacing invalid sequences. Viewers
/// should show *something* rather than refuse a file with one bad byte.
pub fn decode_utf8(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(body).into_owned()
}

/// The document's bytes, in the shape a reader that wants to own them takes.
///
/// Two of the libraries here read from something they hold rather than from a
/// path: calamine wants `Read + Seek`, and parquet wants a `ChunkReader`. Both
/// are satisfied by the buffer the document already has, but neither can be
/// handed an `Arc<DocBytes>` — `Cursor` needs `AsRef<[u8]>`, which a foreign
/// smart pointer around a foreign type cannot be given. Hence a newtype, here
/// rather than in either format's module, because both formats use it.
#[derive(Clone)]
pub struct SharedBytes(Arc<DocBytes>);

impl SharedBytes {
    pub fn new(bytes: Arc<DocBytes>) -> Self {
        Self(bytes)
    }

    fn slice(&self, start: u64, length: usize) -> ParquetResult<&[u8]> {
        let all: &[u8] = &self.0;
        let start = usize::try_from(start).map_err(|_| past_end(start, all.len()))?;
        let end = start
            .checked_add(length)
            .ok_or_else(|| past_end(start as u64, all.len()))?;
        all.get(start..end)
            .ok_or_else(|| past_end(end as u64, all.len()))
    }
}

fn past_end(at: u64, len: usize) -> ParquetError {
    ParquetError::EOF(format!("read past the end of {len} bytes at {at}"))
}

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Length for SharedBytes {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
}

impl ChunkReader for SharedBytes {
    type T = Cursor<SharedBytes>;

    fn get_read(&self, start: u64) -> ParquetResult<Self::T> {
        self.slice(start, 0)?;
        let mut cursor = Cursor::new(self.clone());
        cursor.set_position(start);
        Ok(cursor)
    }

    /// Copied rather than borrowed.
    ///
    /// `Bytes` cannot point into a map it does not own, and the file
    /// implementation this replaces read into a fresh buffer too — so the copy
    /// is the same one parquet was already paying for, and what comes back is
    /// a column chunk that is about to be decoded anyway.
    fn get_bytes(&self, start: u64, length: usize) -> ParquetResult<Bytes> {
        Ok(Bytes::copy_from_slice(self.slice(start, length)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_limit_includes_exactly_64_mib() {
        for len in [0, 1, OWNED_MAX_BYTES - 1, OWNED_MAX_BYTES] {
            assert!(keeps_in_memory(len), "{len} bytes must be owned");
        }
        for len in [OWNED_MAX_BYTES + 1, u64::MAX] {
            assert!(!keeps_in_memory(len), "{len} bytes must stay mapped");
        }
    }

    #[test]
    fn small_and_empty_files_are_owned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.json");
        for content in [b"".as_slice(), b"{\"value\":1}".as_slice()] {
            std::fs::write(&path, content).unwrap();
            let bytes = DocBytes::map_file(&path).unwrap();
            assert!(matches!(bytes, DocBytes::Owned(_)));
            assert_eq!(&*bytes, content);
        }
    }
}
