//! Getting a document's bytes into UTF-8 before anything else looks at them.
//!
//! Everything downstream — the scanners, the record index, search, the byte
//! offsets that tie a node back to its source — assumes UTF-8. That is the
//! right assumption to build on, but it is not always true of the file: a
//! Korean Windows spreadsheet writes CSV as CP949 by default, and "Unicode
//! text" exports are UTF-16. Read as UTF-8 those come out as replacement
//! characters: the structure survives and every word is unreadable.
//!
//! So a document that is not already UTF-8 is transcoded **once, at open time**
//! and the result becomes the document. The original bytes are kept beside it
//! so a different encoding can be chosen later without re-reading the file.
//!
//! Detection is only ever a guess — a short file can be valid in several
//! encodings at once — which is why the answer is shown in the toolbar and can
//! be overridden there. The guess is what saves the common case; the override
//! is what makes being wrong survivable.

use std::sync::Arc;

use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};

use crate::bytes::DocBytes;

/// How much of the file the detector looks at. Legacy encodings are decided by
/// byte-pair statistics, and a megabyte is far more than enough for that.
const SAMPLE_BYTES: usize = 1024 * 1024;

/// Transcoding materialises the whole document, and a CP949 file grows by half
/// on the way to UTF-8 (two bytes per Hangul syllable become three). Past this
/// the memory cost stops being worth it, and a legacy-encoded file that large
/// is a machine's output, not a document someone is reading.
pub const MAX_DECODE_BYTES: usize = 256 * 1024 * 1024;

/// The encodings offered in the picker.
///
/// Deliberately short. Every entry here is one a person might actually have to
/// pick — the CJK legacy encodings, the two UTF-16 orderings, and the Western
/// single-byte set — rather than the whole Encoding Standard, which would make
/// the menu a worse tool than the guess it exists to correct.
pub const CHOICES: &[(&str, &str)] = &[
    ("UTF-8", "UTF-8"),
    ("EUC-KR", "EUC-KR / CP949"),
    ("UTF-16LE", "UTF-16 LE"),
    ("UTF-16BE", "UTF-16 BE"),
    ("Shift_JIS", "Shift_JIS"),
    ("gb18030", "GB18030 / GBK"),
    ("Big5", "Big5"),
    ("windows-1252", "windows-1252"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncodingSource {
    /// A byte-order mark said so, which is not a guess.
    Bom,
    /// The bytes are valid UTF-8.
    Utf8,
    /// Statistics over the content. This is the one that can be wrong.
    Guessed,
    /// The reader picked it.
    Chosen,
}

/// Something the reader should know about how the document was decoded.
///
/// A code and its parameters, like `Error` — the sentence is built in the
/// frontend so it follows the chosen language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", content = "params", rename_all = "camelCase")]
pub enum DecodeWarning {
    /// Detected as something other than UTF-8, but too large to transcode.
    #[serde(rename_all = "camelCase")]
    TooLargeToDecode { encoding: String, limit_mb: usize },
    /// Decoded, but some bytes the encoding cannot represent were replaced.
    UndecodableBytes { encoding: String },
}

pub struct Decoded {
    /// UTF-8 bytes. The same allocation as the source when it already was.
    pub bytes: Arc<DocBytes>,
    pub encoding: &'static Encoding,
    pub source: EncodingSource,
    /// Set when the reading did not go entirely cleanly.
    pub warning: Option<DecodeWarning>,
}

pub fn by_name(name: &str) -> Option<&'static Encoding> {
    Encoding::for_label(name.as_bytes())
}

/// The label shown in the toolbar.
pub fn label(encoding: &'static Encoding) -> String {
    let name = encoding.name();
    CHOICES
        .iter()
        .find(|(id, _)| *id == name)
        .map(|(_, label)| (*label).to_owned())
        .unwrap_or_else(|| name.to_owned())
}

/// Decode `source` to UTF-8, detecting the encoding.
pub fn decode(source: Arc<DocBytes>) -> Decoded {
    let (encoding, from) = detect(&source);
    transcode(source, encoding, from)
}

/// Decode `source` as `encoding`, whatever detection would have said.
pub fn decode_as(source: Arc<DocBytes>, encoding: &'static Encoding) -> Decoded {
    transcode(source, encoding, EncodingSource::Chosen)
}

fn detect(bytes: &[u8]) -> (&'static Encoding, EncodingSource) {
    // A BOM is a statement, not evidence to weigh.
    if let Some((encoding, _)) = Encoding::for_bom(bytes) {
        return (encoding, EncodingSource::Bom);
    }
    // Valid UTF-8 is almost never valid in a legacy encoding by accident, so
    // this is checked before the statistical guess rather than after it.
    if std::str::from_utf8(bytes).is_ok() {
        return (encoding_rs::UTF_8, EncodingSource::Utf8);
    }

    let sample = &bytes[..bytes.len().min(SAMPLE_BYTES)];
    // ISO-2022-JP is denied for the same reason browsers deny it: it can turn
    // otherwise inert bytes into markup, and this document may be rendered.
    let mut detector =
        chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(sample, sample.len() == bytes.len());
    // UTF-8 is denied because it was already ruled out above, and the detector
    // would otherwise offer it back for input we know is invalid.
    (
        detector.guess(None, chardetng::Utf8Detection::Deny),
        EncodingSource::Guessed,
    )
}

fn transcode(
    source: Arc<DocBytes>,
    encoding: &'static Encoding,
    from: EncodingSource,
) -> Decoded {
    // Already UTF-8: hand the mapping straight through. This is the common
    // case and it must stay free — a 500MB JSON cannot afford a copy.
    if encoding == encoding_rs::UTF_8 {
        return Decoded {
            bytes: source,
            encoding,
            source: from,
            warning: None,
        };
    }

    if source.len() > MAX_DECODE_BYTES {
        return Decoded {
            bytes: source,
            encoding: encoding_rs::UTF_8,
            source: EncodingSource::Utf8,
            warning: Some(DecodeWarning::TooLargeToDecode {
                encoding: label(encoding),
                limit_mb: MAX_DECODE_BYTES / 1024 / 1024,
            }),
        };
    }

    // `decode` strips the BOM and substitutes U+FFFD for bytes the encoding
    // cannot represent, which is what a viewer wants: show the rest.
    let (text, _, had_errors) = encoding.decode(&source);
    let warning = had_errors.then(|| DecodeWarning::UndecodableBytes {
        encoding: label(encoding),
    });

    Decoded {
        bytes: Arc::new(DocBytes::from(text.into_owned().into_bytes())),
        encoding,
        source: from,
        warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(raw: &[u8]) -> Arc<DocBytes> {
        Arc::new(DocBytes::from(raw.to_vec()))
    }

    fn text_of(decoded: &Decoded) -> String {
        String::from_utf8_lossy(&decoded.bytes).into_owned()
    }

    /// The whole point: a Korean Windows spreadsheet writes this by default.
    #[test]
    fn cp949_is_detected_and_decoded() {
        // "id,이름\n1,가나다\n2,라마바\n" as CP949.
        let raw = b"id,\xc0\xcc\xb8\xa7\n1,\xb0\xa1\xb3\xaa\xb4\xd9\n2,\xb6\xf3\xb8\xb6\xb9\xd9\n";
        let decoded = decode(bytes(raw));
        assert_eq!(decoded.encoding.name(), "EUC-KR");
        assert_eq!(decoded.source, EncodingSource::Guessed);
        assert_eq!(text_of(&decoded), "id,이름\n1,가나다\n2,라마바\n");
        assert!(decoded.warning.is_none());
    }

    #[test]
    fn utf16_is_decided_by_its_bom_not_guessed() {
        let mut raw = vec![0xff, 0xfe];
        for unit in "id\t이름\n".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode(bytes(&raw));
        assert_eq!(decoded.encoding.name(), "UTF-16LE");
        assert_eq!(decoded.source, EncodingSource::Bom);
        assert_eq!(text_of(&decoded), "id\t이름\n");
    }

    /// A 500MB JSON must not pay for a copy on the way in.
    #[test]
    fn utf8_passes_through_without_a_copy() {
        let source = bytes("이름,값\n가,1\n".as_bytes());
        let before = source.as_ptr();
        let decoded = decode(Arc::clone(&source));
        assert_eq!(decoded.encoding.name(), "UTF-8");
        assert_eq!(decoded.source, EncodingSource::Utf8);
        assert_eq!(decoded.bytes.as_ptr(), before, "the buffer was copied");
    }

    #[test]
    fn a_utf8_bom_is_recognised_as_utf8() {
        let decoded = decode(bytes("\u{feff}a,b\n".as_bytes()));
        assert_eq!(decoded.encoding.name(), "UTF-8");
        assert_eq!(decoded.source, EncodingSource::Bom);
        // The scanners strip the mark themselves, so it is left in place here
        // rather than forcing a copy of an otherwise untouched file.
        assert_eq!(text_of(&decoded), "\u{feff}a,b\n");
    }

    /// Pure ASCII is valid in every encoding here; UTF-8 is the useful answer.
    #[test]
    fn plain_ascii_stays_utf8() {
        let decoded = decode(bytes(b"id,name\n1,alpha\n"));
        assert_eq!(decoded.encoding.name(), "UTF-8");
    }

    #[test]
    fn a_chosen_encoding_overrides_detection() {
        let raw = b"id,\xc0\xcc\xb8\xa7\n";
        let guessed = decode(bytes(raw));
        assert_eq!(guessed.encoding.name(), "EUC-KR");

        let forced = decode_as(bytes(raw), by_name("Shift_JIS").expect("known"));
        assert_eq!(forced.encoding.name(), "Shift_JIS");
        assert_eq!(forced.source, EncodingSource::Chosen);
        assert_ne!(text_of(&forced), text_of(&guessed));
    }

    /// Choosing the wrong encoding still shows the document, and says so.
    #[test]
    fn undecodable_bytes_produce_a_warning_not_a_failure() {
        let decoded = decode_as(bytes(b"a\xff\xfeb"), by_name("EUC-KR").expect("known"));
        assert!(decoded.warning.is_some(), "no warning");
        assert!(!decoded.bytes.is_empty());
    }

    #[test]
    fn every_offered_encoding_resolves() {
        for (id, _) in CHOICES {
            let encoding = by_name(id).unwrap_or_else(|| panic!("unknown encoding {id}"));
            assert_eq!(encoding.name(), *id, "label must be the canonical name");
            assert!(!label(encoding).is_empty());
        }
    }

    #[test]
    fn an_empty_document_is_utf8() {
        let decoded = decode(bytes(b""));
        assert_eq!(decoded.encoding.name(), "UTF-8");
        assert!(decoded.bytes.is_empty());
    }
}
