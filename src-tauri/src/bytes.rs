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
/// A mapped file that changes on disk under us is a real hazard, and a bigger
/// one than it first looks. Content edited in place gives torn reads, which a
/// read-only viewer can live with — reopen and the question goes away. But a
/// file *truncated* while mapped is different: on Linux and macOS, touching a
/// page past the new end raises SIGBUS and takes the process with it, with no
/// error to report and nothing to catch. Windows does not have this problem,
/// because the OS refuses to shrink a file that has a mapping open.
///
/// Defending against it properly costs the reason the map exists — copying the
/// file, or installing a signal handler and unwinding out of it. Neither is
/// worth it for a viewer, so it stands as a documented limitation. See the
/// "알려진 한계" section of the README.
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
