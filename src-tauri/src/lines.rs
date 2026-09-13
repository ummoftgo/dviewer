//! Physical source lines, independent of table records and their display modes.

use std::sync::Arc;
use regex::RegexBuilder;
use serde::Serialize;
use crate::bytes::DocBytes;
use crate::error::{Error, Result, Subject};

pub const MAX_LINES: usize = 50_000_000;
pub const MAX_PAGE_LINES: u32 = 2000;
pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
const SCAN_STEP: usize = 4096;

pub struct Lines {
    bytes: Arc<DocBytes>,
    starts: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct LinePage {
    pub total: u32,
    pub lines: Vec<String>,
}

fn check_stop(stop: &impl Fn() -> bool) -> Result<()> {
    if stop() { Err(Error::Cancelled) } else { Ok(()) }
}

fn page_limit(bytes: usize) -> Error {
    Error::TooLarge {
        subject: Subject::Source,
        megabytes: bytes.div_ceil(1024 * 1024),
        limit_mb: MAX_PAGE_BYTES / 1024 / 1024,
    }
}

impl Lines {
    pub fn build(bytes: Arc<DocBytes>, stop: &impl Fn() -> bool) -> Result<Self> {
        Self::build_with_limit(bytes, MAX_LINES, stop)
    }

    fn build_with_limit(bytes: Arc<DocBytes>, limit: usize, stop: &impl Fn() -> bool) -> Result<Self> {
        check_stop(stop)?;
        if bytes.len() > u32::MAX as usize {
            return Err(Error::FileTooLarge { gigabytes: bytes.len().div_ceil(1 << 30), limit_gb: 4 });
        }
        let bom = if bytes.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
        let mut starts = vec![bom as u32];
        // Chunking also makes a single enormous line interruptible.
        for (block, chunk) in bytes[bom..].chunks(SCAN_STEP).enumerate() {
            check_stop(stop)?;
            for offset in memchr::memchr_iter(b'\n', chunk) {
                if starts.len() >= limit {
                    return Err(Error::TooManyLines { limit: limit as u32 });
                }
                starts.push((bom + block * SCAN_STEP + offset + 1) as u32);
            }
        }
        Ok(Self { bytes, starts })
    }

    pub fn total(&self) -> u32 { self.starts.len() as u32 }

    fn line(&self, row: u32) -> &[u8] {
        let start = self.starts[row as usize] as usize;
        let end = self.starts.get(row as usize + 1).map_or(self.bytes.len(), |&at| at as usize - 1);
        let raw = &self.bytes[start..end];
        // A bare CR at EOF is content; only CR immediately before LF is removed.
        if self.starts.get(row as usize + 1).is_some() {
            raw.strip_suffix(b"\r").unwrap_or(raw)
        } else { raw }
    }

    pub fn page(&self, start: u32, count: u32, stop: &impl Fn() -> bool) -> Result<LinePage> {
        check_stop(stop)?;
        let end = start.saturating_add(count.min(MAX_PAGE_LINES)).min(self.total());
        let mut lines = Vec::new();
        let mut used = 0;
        for row in start..end {
            check_stop(stop)?;
            let raw = self.line(row);
            if raw.len() > MAX_PAGE_BYTES - used { return Err(page_limit(used + raw.len())); }
            let text = String::from_utf8_lossy(raw);
            used += text.len();
            if used > MAX_PAGE_BYTES { return Err(page_limit(used)); }
            lines.push(text.into_owned());
        }
        Ok(LinePage { total: self.total(), lines })
    }

    /// Literal Unicode simple case folding, matching the frontend's /iu highlight.
    /// The starting line is included and every line is visited at most once.
    pub fn find(&self, query: &str, from: u32, backward: bool, stop: &impl Fn() -> bool) -> Result<Option<u32>> {
        check_stop(stop)?;
        if query.is_empty() { return Ok(None); }
        if query.len() > MAX_PAGE_BYTES { return Err(page_limit(query.len())); }
        let finder = RegexBuilder::new(&regex::escape(query)).case_insensitive(true).build()
            .map_err(|error| Error::BadQuery { detail: error.to_string() })?;
        // A simple-folded code point can occupy up to four UTF-8 bytes.
        let overlap = query.chars().count() * 4;
        let total = self.total();
        let from = from.min(total - 1);
        for step in 0..total {
            if (step as usize).is_multiple_of(SCAN_STEP) { check_stop(stop)?; }
            let row = if backward { (from + total - step) % total } else { (from + step) % total };
            let raw = self.line(row);
            for at in (0..raw.len()).step_by(SCAN_STEP) {
                check_stop(stop)?;
                // Keep chunk boundaries outside a UTF-8 character, including a
                // match crossing the window boundary. Invalid bytes remain visible.
                let mut start = at;
                for _ in 0..3 {
                    if start == 0 || raw[start] & 0xC0 != 0x80 { break; }
                    start -= 1;
                }
                let mut end = (at + SCAN_STEP + overlap).min(raw.len());
                for _ in 0..3 {
                    if end == raw.len() || raw[end] & 0xC0 != 0x80 { break; }
                    end += 1;
                }
                if finder.is_match(&String::from_utf8_lossy(&raw[start..end])) { return Ok(Some(row)); }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn lines(text: &str) -> Lines {
        Lines::build(Arc::new(DocBytes::from(text.as_bytes().to_vec())), &|| false).unwrap()
    }

    #[test]
    fn physical_lines_keep_empty_files_trailing_blanks_and_bare_cr() {
        for (text, expected) in [
            ("", vec![""]), ("a", vec!["a"]), ("a\n", vec!["a", ""]),
            ("a\n\n", vec!["a", "", ""]), ("\n", vec!["", ""]),
            ("a\r\n\r\nb\r", vec!["a", "", "b\r"]),
        ] {
            let doc = lines(text);
            assert_eq!(doc.page(0, 100, &|| false).unwrap().lines, expected, "{text:?}");
        }
    }

    #[test]
    fn only_the_document_bom_is_removed() {
        assert_eq!(lines("\u{feff}a\n\u{feff}b").page(0, 10, &|| false).unwrap().lines, ["a", "\u{feff}b"]);
        assert_eq!(lines("\u{feff}").page(0, 1, &|| false).unwrap().lines, [""]);
    }

    #[test]
    fn utf16_uses_the_documents_already_decoded_bytes() {
        for little in [true, false] {
            let mut raw = if little { vec![0xff, 0xfe] } else { vec![0xfe, 0xff] };
            for unit in "가나다\r\n😀\n".encode_utf16() {
                raw.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            let decoded = crate::encoding::decode(Arc::new(DocBytes::from(raw)));
            let doc = Lines::build(decoded.bytes, &|| false).unwrap();
            assert_eq!(doc.page(0, 10, &|| false).unwrap().lines, ["가나다", "😀", ""]);
        }
    }

    #[test]
    fn pages_clamp_counts_and_accept_empty_out_of_range_requests() {
        let doc = lines(&"x\n".repeat(3000));
        assert_eq!(doc.page(0, u32::MAX, &|| false).unwrap().lines.len(), 2000);
        assert_eq!(doc.page(2999, u32::MAX, &|| false).unwrap().lines, ["x", ""]);
        assert!(doc.page(u32::MAX, 10, &|| false).unwrap().lines.is_empty());
        assert!(doc.page(0, 0, &|| false).unwrap().lines.is_empty());
        assert_eq!(doc.total(), 3001);
    }

    #[test]
    fn the_page_budget_counts_all_decoded_lines_and_never_truncates() {
        let doc = lines(&format!("{}\nb", "a".repeat(MAX_PAGE_BYTES)));
        assert_eq!(doc.page(0, 1, &|| false).unwrap().lines[0].len(), MAX_PAGE_BYTES);
        assert!(matches!(doc.page(0, 2, &|| false), Err(Error::TooLarge { limit_mb: 8, .. })));
        assert!(matches!(lines(&"a".repeat(MAX_PAGE_BYTES + 1)).page(0, 1, &|| false), Err(Error::TooLarge { .. })));
        let invalid = Arc::new(DocBytes::from(vec![0xff; MAX_PAGE_BYTES / 3 + 1]));
        assert!(matches!(Lines::build(invalid, &|| false).unwrap().page(0, 1, &|| false), Err(Error::TooLarge { .. })));
    }

    #[test]
    fn exceeding_the_line_budget_is_an_error_instead_of_a_partial_index() {
        let bytes = Arc::new(DocBytes::from(b"a\nb\n".to_vec()));
        assert!(matches!(Lines::build_with_limit(bytes.clone(), 2, &|| false), Err(Error::TooManyLines { limit: 2 })));
        assert_eq!(Lines::build_with_limit(bytes, 3, &|| false).unwrap().total(), 3);
    }

    #[test]
    fn find_is_inclusive_bidirectional_circular_and_literal() {
        let doc = lines("hit\nnone\nHIT\n[a]+\n");
        for (from, backward, expected) in [(0, false, 0), (1, false, 2), (3, false, 0), (1, true, 0), (4, true, 2), (0, true, 0)] {
            assert_eq!(doc.find("hit", from, backward, &|| false).unwrap(), Some(expected));
        }
        assert_eq!(doc.find("[A]+", 0, false, &|| false).unwrap(), Some(3));
        assert_eq!(doc.find("missing", 0, false, &|| false).unwrap(), None);
        assert_eq!(doc.find("", 0, false, &|| false).unwrap(), None);
        assert_eq!(doc.find("hit\nnone", 0, false, &|| false).unwrap(), None);
        assert_eq!(lines("x\nhit\nx").find("hit", 0, true, &|| false).unwrap(), Some(1));
    }

    #[test]
    fn unicode_folding_and_matches_across_scan_boundaries_agree_with_display() {
        let doc = lines("ÄPFEL\nΣς\nK ſ\n😀");
        for (query, row) in [("äpfel", 0), ("σσ", 1), ("k s", 2), ("😀", 3)] {
            assert_eq!(doc.find(query, 0, false, &|| false).unwrap(), Some(row));
        }
        let doc = lines(&format!("{}😀ÄPFEL", "x".repeat(SCAN_STEP - 2)));
        assert_eq!(doc.find("😀äpfel", 0, false, &|| false).unwrap(), Some(0));
        assert_eq!(doc.find("�", 0, false, &|| false).unwrap(), None);
    }

    #[test]
    fn no_newlines_and_no_matches_still_observe_cancellation() {
        let calls = Cell::new(0);
        let stop = || { calls.set(calls.get() + 1); calls.get() > 2 };
        let bytes = Arc::new(DocBytes::from(vec![b'x'; SCAN_STEP * 5]));
        assert!(matches!(Lines::build(bytes, &stop), Err(Error::Cancelled)));
        calls.set(0);
        assert!(matches!(lines(&"x".repeat(SCAN_STEP * 5)).find("absent", 0, false, &stop), Err(Error::Cancelled)));
        calls.set(0);
        assert!(matches!(lines(&"\n".repeat(SCAN_STEP * 5)).find("absent", 0, true, &stop), Err(Error::Cancelled)));
    }
}
