//! Reading a zip as a list of the documents inside it.
//!
//! The fifth way to read a file, and the odd one out: the other four end on
//! screen, and this one ends in another document. An archive is not so much a
//! fourteenth format as the other thirteen multiplied — pick an entry and the
//! pipeline that opens a file opens it.
//!
//! What that buys is that almost nothing here is new. Opening reads the central
//! directory at the end of the file and nothing else, which is the cost model
//! Parquet's footer already established; taking an entry out is a streamed
//! decompression under the ceiling a `.gz` already has; and what comes out goes
//! through the same `ungzip` → `detect_kind` → `decode` a file from disk does.
//!
//! The names are the one part with no precedent. A zip written before 2007 —
//! and plenty written since — stores them in whatever code page the machine
//! that wrote it was using, with no field saying which. So they are guessed, by
//! the same rules the encoding detector follows for content, and the guess is
//! shown as a guess. It can be wrong without costing anything: an entry is
//! identified by its number in the central directory, so a name that comes out
//! as mojibake still opens the document it belongs to.

use std::io::{Cursor, Read};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use zip::read::HasZipMetadata;
use zip::ZipArchive;

use crate::bytes::DocBytes;
use crate::error::{Error, Result, Subject};
use crate::source::{self, MAX_DECOMPRESSED_BYTES};
use crate::state::DocKind;

/// How many entries the list will show.
///
/// Not a limit on what may be opened — an archive with more than this is read
/// and its entries still work; the list simply stops, and says how many it left
/// out. A hundred thousand rows is already well past the point where scrolling
/// is how anyone finds anything, and the number exists so that a malformed or
/// hostile central directory cannot make the app build an unbounded list.
pub const MAX_ENTRIES: usize = 100_000;

/// `Arc<DocBytes>` as something `Cursor` will read from.
///
/// `Cursor` wants an owner it can borrow a `&[u8]` from, and `Arc` does not
/// forward `AsRef` to what it holds. This line of glue is what lets the archive
/// reader share the mapping the document already has rather than copy it.
struct SharedBytes(Arc<DocBytes>);

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

type Reader = Cursor<SharedBytes>;

/// One document inside the archive, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Where the entry sits in the archive, and its identity.
    ///
    /// Central directory order, with one wrinkle worth knowing: the reader
    /// holds that directory in a map keyed by name, so a name used twice keeps
    /// only its last entry and the number counts what survived. Numbers stay
    /// stable for a given file either way, which is all that is asked of them.
    ///
    /// The name is not the identity — one whose encoding was guessed wrong is
    /// still a name this number opens. It is also what a tab dedupes on, so
    /// re-clicking an entry raises the tab already showing it.
    pub index: u32,
    /// For display, and frozen at the moment the list was built.
    pub name: String,
    /// What the archive says the entry weighs unpacked.
    ///
    /// A declaration, not a measurement. Nothing is refused on the strength of
    /// it — the ceiling is applied to what actually comes out, because this
    /// field is the part of a zip a hostile writer controls for free.
    pub size: u64,
    pub encrypted: bool,
    /// What the name alone says the entry would be read as, for the badge.
    pub kind: DocKind,
}

/// The whole list, plus what the reader should know about how it was read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntry>,
    /// Which encoding the names were read in.
    pub name_encoding: String,
    /// Whether that was a guess. Only then is it worth the reader's attention.
    pub names_guessed: bool,
    /// Entries past `MAX_ENTRIES`, which the list does not show.
    pub hidden: usize,
}

/// An open archive: its central directory, and a reader kept beside it.
///
/// The reader is held for the reason the database connection is. Everything
/// about an entry past its name lives in the local header next to its data, so
/// building the list walks the file — and re-parsing the central directory for
/// every entry someone clicks would pay that walk again to answer one click.
pub struct ArchiveDoc {
    archive: Mutex<ZipArchive<Reader>>,
    listing: ArchiveListing,
}

impl ArchiveDoc {
    /// Read the central directory. Nothing is decompressed here.
    pub fn open(bytes: Arc<DocBytes>) -> Result<Self> {
        let mut archive =
            ZipArchive::new(Cursor::new(SharedBytes(bytes))).map_err(|e| Error::ParseFailed {
                subject: Subject::Archive,
                detail: e.to_string(),
            })?;
        let listing = list(&mut archive)?;
        Ok(Self {
            archive: Mutex::new(archive),
            listing,
        })
    }

    pub fn listing(&self) -> &ArchiveListing {
        &self.listing
    }

    /// The entry at `index`, or nothing when the archive has no such row.
    pub fn entry(&self, index: u32) -> Option<&ArchiveEntry> {
        self.listing.entries.iter().find(|entry| entry.index == index)
    }

    /// Unpack one entry into memory.
    ///
    /// The ceiling is the one a `.gz` already has, applied the same way and for
    /// the same reason: `size` is a claim made by whoever wrote the archive, and
    /// the only honest moment to refuse is while the bytes are coming out. The
    /// buffer is never sized from that claim either — a zip that says four
    /// gigabytes and holds four kilobytes must not be able to ask for the
    /// allocation on the strength of saying so.
    pub fn read_entry(&self, index: u32) -> Result<Vec<u8>> {
        let entry = self.entry(index).ok_or(Error::NoSuchEntry { index })?;
        // Said out loud rather than handled. Asking for a password would mean
        // holding one, and a viewer that unlocks archives is a different
        // program from one that reads documents.
        if entry.encrypted {
            return Err(Error::EntryEncrypted);
        }

        let mut archive = self.archive.lock();
        let file = archive
            .by_index(index as usize)
            .map_err(|e| Error::ParseFailed {
                subject: Subject::Archive,
                detail: e.to_string(),
            })?;

        let mut out = Vec::new();
        // One byte past the limit is enough to know, and stops the read there
        // rather than after the whole thing has been built.
        file.take(MAX_DECOMPRESSED_BYTES as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| Error::ParseFailed {
                subject: Subject::Archive,
                detail: e.to_string(),
            })?;
        if out.len() > MAX_DECOMPRESSED_BYTES {
            return Err(Error::TooLarge {
                subject: Subject::Decompressed,
                megabytes: out.len() / 1024 / 1024,
                limit_mb: MAX_DECOMPRESSED_BYTES / 1024 / 1024,
            });
        }
        Ok(out)
    }
}

/// One entry's raw name, and where in the list it landed.
///
/// Kept only for the entries that might be read again in another encoding: a
/// name the archive flagged as UTF-8, or one that is plain ASCII, is already
/// right whatever the rest of the archive turns out to be.
struct RawName {
    at: usize,
    bytes: Box<[u8]>,
}

fn list(archive: &mut ZipArchive<Reader>) -> Result<ArchiveListing> {
    let total = archive.len();
    let shown = total.min(MAX_ENTRIES);

    let mut entries = Vec::with_capacity(shown);
    let mut undeclared: Vec<RawName> = Vec::new();

    for index in 0..shown {
        let file = archive.by_index_raw(index).map_err(|e| Error::ParseFailed {
            subject: Subject::Archive,
            detail: e.to_string(),
        })?;
        let meta = file.get_metadata();
        // A directory is a zero-byte entry whose name ends in a slash. It holds
        // no document, so it is not a row of its own — the paths on the rows
        // below still carry it, and the list is shaped from those.
        if meta.is_dir() {
            continue;
        }
        // The crate has already decoded this: UTF-8 where the archive said so,
        // and the zip specification's CP437 where it did not. The second is a
        // default rather than a reading, which is what the guess below is for.
        let name = meta.file_name.to_string();
        if !meta.is_utf8 && !meta.file_name_raw.is_ascii() {
            undeclared.push(RawName {
                at: entries.len(),
                bytes: meta.file_name_raw.clone(),
            });
        }
        entries.push(ArchiveEntry {
            index: index as u32,
            kind: source::kind_from_name(&name),
            name,
            size: meta.uncompressed_size,
            encrypted: meta.encrypted,
        });
    }

    let guess = guess_name_encoding(&undeclared);
    if let Some(encoding) = guess {
        for raw in &undeclared {
            let entry = &mut entries[raw.at];
            entry.name = encoding.decode(&raw.bytes).0.into_owned();
            entry.kind = source::kind_from_name(&entry.name);
        }
    }

    Ok(ArchiveListing {
        entries,
        name_encoding: guess.map_or_else(|| "CP437".to_owned(), crate::encoding::label),
        names_guessed: guess.is_some(),
        hidden: total - shown,
    })
}

/// Which encoding the names that declared none were written in.
///
/// `None` means CP437 — the zip specification's own answer, and the one the
/// crate has already applied. It is the result when there is nothing to guess
/// from, and when the detector returns the answer it gives for input it cannot
/// place.
///
/// Every undeclared name in the archive is fed in together rather than one at a
/// time. A file name is a dozen bytes and byte-pair statistics need more than
/// that, but one zip is written by one machine in one code page, so the whole
/// list is a single sample — and a hundred names make a sample worth having.
fn guess_name_encoding(names: &[RawName]) -> Option<&'static encoding_rs::Encoding> {
    if names.is_empty() {
        return None;
    }
    // The same two denials `encoding::detect` makes, for the same reasons:
    // ISO-2022-JP can turn otherwise inert bytes into markup, and UTF-8 is not
    // a candidate because a name the archive did not flag, and that is not
    // valid UTF-8, is by definition not UTF-8.
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    let last = names.len() - 1;
    for (at, name) in names.iter().enumerate() {
        detector.feed(&name.bytes, at == last);
    }
    let guess = detector.guess(None, chardetng::Utf8Detection::Deny);
    // windows-1252 is what the detector answers when nothing in the bytes
    // points anywhere: every byte is a valid character in it, so it can never
    // be ruled out and it is never positive evidence either. For a zip that is
    // exactly the case CP437 was specified for, so the specification wins.
    (guess != encoding_rs::WINDOWS_1252).then_some(guess)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A zip built byte by byte, because the parts under test are the ones a
    /// writing library hides: the raw name bytes, the flag that says whether
    /// they are UTF-8, and the sizes the central directory claims.
    struct Entry {
        name: Vec<u8>,
        body: Vec<u8>,
        raw_len: u32,
        method: u16,
        flags: u16,
    }

    fn stored(name: &[u8], content: &[u8], flags: u16) -> Entry {
        Entry {
            name: name.to_vec(),
            body: content.to_vec(),
            raw_len: content.len() as u32,
            method: 0,
            flags,
        }
    }

    fn deflated(name: &[u8], content: &[u8]) -> Entry {
        use flate2::{write::DeflateEncoder, Compression};
        use std::io::Write;
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content).expect("compress");
        Entry {
            name: name.to_vec(),
            body: encoder.finish().expect("finish"),
            raw_len: content.len() as u32,
            method: 8,
            flags: 0,
        }
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    0xedb8_8320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn zip_of(entries: &[(Entry, u32)]) -> Arc<DocBytes> {
        zip_of_with(entries, false)
    }

    /// `zip64` writes the end of the directory in its 64-bit form, with the
    /// classic record left holding the escape values that say to look there.
    /// The numbers still fit in the classic one, which is what makes this a
    /// test of the parser rather than of the arithmetic.
    fn zip_of_with(entries: &[(Entry, u32)], zip64: bool) -> Arc<DocBytes> {
        let mut locals: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();
        let mut offsets: Vec<u32> = Vec::new();

        for (entry, crc) in entries {
            offsets.push(locals.len() as u32);
            locals.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            locals.extend_from_slice(&20u16.to_le_bytes());
            locals.extend_from_slice(&entry.flags.to_le_bytes());
            locals.extend_from_slice(&entry.method.to_le_bytes());
            locals.extend_from_slice(&0u16.to_le_bytes());
            locals.extend_from_slice(&0x21u16.to_le_bytes());
            locals.extend_from_slice(&crc.to_le_bytes());
            locals.extend_from_slice(&(entry.body.len() as u32).to_le_bytes());
            locals.extend_from_slice(&entry.raw_len.to_le_bytes());
            locals.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            locals.extend_from_slice(&0u16.to_le_bytes());
            locals.extend_from_slice(&entry.name);
            locals.extend_from_slice(&entry.body);
        }

        for ((entry, crc), offset) in entries.iter().zip(&offsets) {
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&entry.flags.to_le_bytes());
            central.extend_from_slice(&entry.method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0x21u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(entry.body.len() as u32).to_le_bytes());
            central.extend_from_slice(&entry.raw_len.to_le_bytes());
            central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            // extra, comment, disk, internal attributes — none of them used.
            central.extend_from_slice(&[0u8; 8]);
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(&entry.name);
        }

        let mut out = locals;
        let directory_at = out.len() as u32;
        let directory_len = central.len() as u32;
        out.extend_from_slice(&central);

        if zip64 {
            let record_at = out.len() as u64;
            out.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
            out.extend_from_slice(&44u64.to_le_bytes());
            out.extend_from_slice(&45u16.to_le_bytes());
            out.extend_from_slice(&45u16.to_le_bytes());
            out.extend_from_slice(&[0u8; 8]);
            out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
            out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
            out.extend_from_slice(&(directory_len as u64).to_le_bytes());
            out.extend_from_slice(&(directory_at as u64).to_le_bytes());

            out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&record_at.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
        }

        let count = if zip64 { 0xffff } else { entries.len() as u16 };
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0u8; 4]);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&if zip64 { u32::MAX } else { directory_len }.to_le_bytes());
        out.extend_from_slice(&if zip64 { u32::MAX } else { directory_at }.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        Arc::new(DocBytes::Owned(out))
    }

    /// The checksum is over what went in, which for a stored entry is also what
    /// came out and for a deflated one is not.
    fn archive_of(entries: Vec<Entry>) -> ArchiveDoc {
        let with_crc: Vec<(Entry, u32)> = entries
            .into_iter()
            .map(|entry| {
                let crc = if entry.method == 0 {
                    crc32(&entry.body)
                } else {
                    0
                };
                (entry, crc)
            })
            .collect();
        ArchiveDoc::open(zip_of(&with_crc)).expect("open")
    }

    /// The flag says UTF-8, so the names are taken at their word.
    #[test]
    fn a_declared_name_is_not_guessed_at() {
        const UTF8_FLAG: u16 = 1 << 11;
        let doc = archive_of(vec![
            stored("보고서.json".as_bytes(), b"{}", UTF8_FLAG),
            stored("readme.md".as_bytes(), b"# hi", UTF8_FLAG),
        ]);
        let listing = doc.listing();
        assert!(!listing.names_guessed, "nothing here needed guessing");
        assert_eq!(listing.entries[0].name, "보고서.json");
        assert_eq!(listing.entries[0].kind, DocKind::Json);
        assert_eq!(listing.entries[1].kind, DocKind::Markdown);
    }

    /// A zip written by a Korean Windows machine says nothing about its code
    /// page, and CP437 renders every name as line-drawing characters. The names
    /// are read together so that there is enough of a sample to go on.
    #[test]
    fn undeclared_names_are_guessed_from_the_whole_archive() {
        // CP949 for 보고서.json, 자료.csv and 읽어보기.txt, with no UTF-8 flag.
        let names: [&[u8]; 3] = [
            b"\xba\xb8\xb0\xed\xbc\xad.json",
            b"\xc0\xda\xb7\xe1.csv",
            b"\xc0\xd0\xbe\xee\xba\xb8\xb1\xe2.txt",
        ];
        let doc = archive_of(names.iter().map(|name| stored(name, b"x", 0)).collect());
        let listing = doc.listing();

        assert!(listing.names_guessed, "an undeclared name is a guess");
        assert_eq!(listing.entries[0].name, "보고서.json");
        assert_eq!(listing.entries[1].name, "자료.csv");
        assert_eq!(listing.entries[2].name, "읽어보기.txt");
        // The badge follows the name it ended up with, not the one CP437 gave.
        assert_eq!(listing.entries[1].kind, DocKind::Csv);
    }

    /// Nothing to go on means the specification's answer, and no claim to have
    /// worked anything out.
    #[test]
    fn ascii_names_are_never_a_guess() {
        let doc = archive_of(vec![stored(b"logs/app.log", b"x", 0)]);
        assert!(!doc.listing().names_guessed);
        assert_eq!(doc.listing().name_encoding, "CP437");
        assert_eq!(doc.listing().entries[0].name, "logs/app.log");
    }

    /// A directory is not a document, so it is not a row — but the path it
    /// names still reaches the rows below it.
    #[test]
    fn a_directory_is_a_path_and_not_a_row() {
        let doc = archive_of(vec![
            stored(b"logs/", b"", 0),
            stored(b"logs/app.log", b"first\n", 0),
        ]);
        let entries = &doc.listing().entries;
        assert_eq!(entries.len(), 1, "only the file is a row");
        assert_eq!(entries[0].name, "logs/app.log");
        // The number is a position in the central directory, so the directory
        // that was skipped leaves a gap rather than shifting the file up.
        assert_eq!(entries[0].index, 1);
    }

    /// Two entries under one name is a valid zip, and the reader keeps the
    /// last. Pinned here because it is a limit rather than a choice: the crate
    /// holds the directory in a map keyed by name, so the shadowed entry is not
    /// reachable by any number. A viewer that showed both rows and opened the
    /// same bytes for each would be lying about what it had.
    #[test]
    fn a_shadowed_entry_is_not_shown_twice() {
        let doc = archive_of(vec![
            stored(b"same.txt", b"first", 0),
            stored(b"same.txt", b"second", 0),
        ]);
        let entries = &doc.listing().entries;
        assert_eq!(entries.len(), 1, "one name, one row");
        assert_eq!(doc.read_entry(entries[0].index).expect("read"), b"second");
    }

    /// The size in the directory is a claim by whoever wrote the file. What is
    /// refused is what actually came out.
    #[test]
    fn a_compression_bomb_is_refused_by_what_comes_out() {
        let doc = archive_of(vec![deflated(
            b"bomb.txt",
            &vec![b'0'; MAX_DECOMPRESSED_BYTES + 1024],
        )]);
        match doc.read_entry(0) {
            Err(Error::TooLarge {
                subject, limit_mb, ..
            }) => {
                assert_eq!(subject, Subject::Decompressed);
                assert_eq!(limit_mb, MAX_DECOMPRESSED_BYTES / 1024 / 1024);
            }
            other => panic!("expected a size refusal, got {:?}", other.map(|b| b.len())),
        }
    }

    /// A locked entry is marked in the list and refused on the way in, rather
    /// than prompting for a password this program has no business holding.
    #[test]
    fn an_encrypted_entry_is_marked_and_refused() {
        const ENCRYPTED: u16 = 1;
        let doc = archive_of(vec![stored(b"secret.txt", b"x", ENCRYPTED)]);
        assert!(doc.listing().entries[0].encrypted);
        assert!(matches!(doc.read_entry(0), Err(Error::EntryEncrypted)));
    }

    /// The 64-bit end record is where a modern writer puts the truth, and the
    /// classic one then holds only escape values. A reader that stops at the
    /// classic record finds 0xFFFF entries in an archive that holds two.
    #[test]
    fn the_zip64_end_record_is_read() {
        let entries = vec![
            (stored(b"first.json", b"{\"a\":1}", 0), 0u32),
            (stored(b"second.txt", b"second\n", 0), 0u32),
        ];
        let with_crc: Vec<(Entry, u32)> = entries
            .into_iter()
            .map(|(entry, _)| {
                let crc = crc32(&entry.body);
                (entry, crc)
            })
            .collect();
        let doc = ArchiveDoc::open(zip_of_with(&with_crc, true)).expect("open");

        let listing = doc.listing();
        assert_eq!(listing.entries.len(), 2, "two entries, not 0xFFFF of them");
        assert_eq!(listing.entries[0].name, "first.json");
        assert_eq!(doc.read_entry(1).expect("read"), b"second\n");
    }

    /// A list is a snapshot, and the file it was taken from can be rewritten.
    #[test]
    fn an_entry_that_is_not_there_is_said_out_loud() {
        let doc = archive_of(vec![stored(b"a.txt", b"x", 0)]);
        assert!(matches!(
            doc.read_entry(7),
            Err(Error::NoSuchEntry { index: 7 })
        ));
    }
}
