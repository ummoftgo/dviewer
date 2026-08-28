use std::fs::File;
use std::ops::Deref;
use std::path::Path;

use memmap2::Mmap;

use crate::error::Result;

/// The bytes of an open document.
///
/// Files are memory-mapped so a 500MB JSON never enters the heap; URL and
/// pasted content arrives as an owned buffer. Everything downstream works
/// against `&[u8]` and does not care which it got.
///
/// Note: a mapped file that changes on disk under us yields torn reads. That is
/// acceptable for a read-only viewer — the fix is to reopen the document, which
/// the user can do explicitly.
pub enum DocBytes {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

impl DocBytes {
    pub fn map_file(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        // Mapping a zero-length file fails on Windows; there is nothing to map.
        if len == 0 {
            return Ok(Self::Owned(Vec::new()));
        }
        // SAFETY: see the note above — external modification is a known,
        // accepted risk for a viewer, and we never write through the map.
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
