//! CSV and TSV as a virtualised grid.
//!
//! Same bargain as the JSON indexer: one sequential pass over the bytes records
//! where every record *starts*, and nothing else is parsed until something asks
//! for it. A 500MB export costs 4 bytes per row up front, and the hundred rows
//! actually on screen are the only ones ever split into fields.
//!
//! Delimited text is not a tree, so it does not go through the tree engine —
//! flattening a grid into `row[3].column[7]` would be a worse way to read a
//! spreadsheet than the spreadsheet.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use aho_corasick::{AhoCorasick, MatchKind};
use parking_lot::RwLock;
use serde::Serialize;

use crate::bytes::DocBytes;
use crate::error::{Error, Result};
use crate::json::text::push_display;

/// Record offsets are `u32`, which caps a document at 4GiB — the same ceiling
/// the JSON indexer works under, for the same reason.
pub const MAX_DOC_BYTES: usize = u32::MAX as usize;
pub const MAX_RECORDS: usize = 50_000_000;

/// Characters of a cell kept for the on-screen grid.
pub const CELL_PREVIEW_CHARS: usize = 500;
/// Ceiling on the text handed back for "copy cell".
pub const MAX_CELL_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// Past this the hit list stops being something a person steps through.
pub const MAX_SEARCH_HITS: usize = 20_000;

const PROGRESS_STEP: usize = 8 * 1024 * 1024;

/// Candidates for delimiter sniffing, in the order ties are broken.
pub const DELIMITERS: [u8; 4] = [b',', b'\t', b';', b'|'];

pub fn delimiter_name(delimiter: u8) -> &'static str {
    match delimiter {
        b',' => "쉼표",
        b'\t' => "탭",
        b';' => "세미콜론",
        b'|' => "파이프",
        _ => "구분자",
    }
}

/// Guess the delimiter from the first few lines.
///
/// A `.csv` that is really semicolon-separated is common enough — European
/// exports do it as a matter of course — that trusting the extension alone
/// would show those files as a single column and look like a bug.
///
/// Counting is restricted to text outside quotes, so a comma inside a quoted
/// field cannot outvote the real delimiter.
pub fn sniff_delimiter(bytes: &[u8]) -> u8 {
    const SAMPLE: usize = 64 * 1024;
    let head = &bytes[..bytes.len().min(SAMPLE)];

    let mut counts = [0usize; DELIMITERS.len()];
    let mut in_quotes = false;
    let mut lines = 0;

    for (i, &b) in head.iter().enumerate() {
        if in_quotes {
            if b == b'"' {
                // A doubled quote is an escaped quote, not the end of the field.
                if head.get(i + 1) == Some(&b'"') {
                    continue;
                }
                in_quotes = false;
            }
            continue;
        }
        match b {
            b'"' => in_quotes = true,
            b'\n' => {
                lines += 1;
                if lines >= 20 {
                    break;
                }
            }
            _ => {
                if let Some(slot) = DELIMITERS.iter().position(|&d| d == b) {
                    counts[slot] += 1;
                }
            }
        }
    }

    let best = counts
        .iter()
        .enumerate()
        .max_by_key(|(i, &count)| (count, std::cmp::Reverse(*i)));
    match best {
        Some((slot, &count)) if count > 0 => DELIMITERS[slot],
        // A single-column file has no delimiter to find. Comma keeps it one
        // column, which is the right answer.
        _ => b',',
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStats {
    /// Data rows, so the header is excluded when there is one.
    pub row_count: u32,
    pub column_count: u32,
    pub byte_len: usize,
    /// Memory the record index occupies.
    pub index_bytes: usize,
    /// The delimiter as a display string, e.g. "쉼표".
    pub delimiter: &'static str,
    pub has_header: bool,
    /// True when the scan stopped at `MAX_RECORDS`.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    /// Data row index, matching what the grid's row numbers show.
    pub index: u32,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCell {
    /// Single-line, escaped, and capped at `CELL_PREVIEW_CHARS`.
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub start: u32,
    pub rows: Vec<TableRow>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableHit {
    pub row: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSearch {
    pub hits: Vec<TableHit>,
    pub capped: bool,
}

pub struct TableDoc {
    pub bytes: Arc<DocBytes>,
    pub delimiter: u8,
    /// Byte offset where each record begins, in document order.
    starts: Vec<u32>,
    column_count: u32,
    truncated: bool,
    has_header: RwLock<bool>,
}

impl TableDoc {
    pub fn build(
        bytes: Arc<DocBytes>,
        delimiter: u8,
        mut progress: impl FnMut(usize),
        should_stop: &dyn Fn() -> bool,
    ) -> Result<Self> {
        if bytes.len() > MAX_DOC_BYTES {
            return Err(Error::Parse(format!(
                "파일이 너무 큽니다 ({}GB). 최대 4GB까지 열 수 있습니다.",
                bytes.len() / 1024 / 1024 / 1024
            )));
        }

        let scan = scan_records(&bytes, delimiter, &mut progress, should_stop)?;
        progress(bytes.len());

        Ok(Self {
            bytes,
            delimiter,
            starts: scan.starts,
            column_count: scan.column_count,
            truncated: scan.truncated,
            has_header: RwLock::new(true),
        })
    }

    fn record_count(&self) -> u32 {
        self.starts.len() as u32
    }

    fn header_offset(&self) -> u32 {
        u32::from(*self.has_header.read() && self.record_count() > 0)
    }

    pub fn stats(&self) -> TableStats {
        TableStats {
            row_count: self.record_count().saturating_sub(self.header_offset()),
            column_count: self.column_count,
            byte_len: self.bytes.len(),
            index_bytes: self.starts.capacity() * std::mem::size_of::<u32>(),
            delimiter: delimiter_name(self.delimiter),
            has_header: *self.has_header.read(),
            truncated: self.truncated,
        }
    }

    /// Treating the first record as a header or as data. Everything else is
    /// derived from this, so nothing has to be re-scanned when it changes.
    pub fn set_has_header(&self, on: bool) {
        *self.has_header.write() = on;
    }

    /// Column names, or empty strings when the file has no header row.
    pub fn header(&self) -> Vec<String> {
        let mut names = vec![String::new(); self.column_count as usize];
        if !*self.has_header.read() {
            return names;
        }
        for (i, cell) in self.record_cells(0).into_iter().enumerate() {
            if i < names.len() {
                names[i] = cell.text;
            }
        }
        names
    }

    pub fn page(&self, start: u32, count: u32) -> TablePage {
        let offset = self.header_offset();
        let total = self.record_count();
        let mut rows = Vec::new();

        for index in start..start.saturating_add(count) {
            let record = match index.checked_add(offset) {
                Some(record) if record < total => record,
                _ => break,
            };
            rows.push(TableRow {
                index,
                cells: self.record_cells(record),
            });
        }
        TablePage { start, rows }
    }

    /// A cell's actual text, for copying — escapes resolved, quotes stripped.
    pub fn cell_text(&self, row: u32, column: u32) -> Option<(String, bool)> {
        let record = row.checked_add(self.header_offset())?;
        let (start, end) = self.record_span(record)?;
        let span = record_fields(&self.bytes, start, end, self.delimiter)
            .into_iter()
            .nth(column as usize)?;
        Some(decode_cell(&self.bytes, span, usize::MAX, MAX_CELL_TEXT_BYTES))
    }

    /// A whole record, verbatim — the line as the file wrote it.
    pub fn row_text(&self, row: u32) -> Option<String> {
        let record = row.checked_add(self.header_offset())?;
        let (start, end) = self.record_span(record)?;
        let raw = &self.bytes[start as usize..end as usize];
        Some(String::from_utf8_lossy(&raw[..raw.len().min(MAX_CELL_TEXT_BYTES)]).into_owned())
    }

    pub fn search(&self, query: &str, case_sensitive: bool, cancel: &AtomicBool) -> Result<TableSearch> {
        if query.is_empty() {
            return Ok(TableSearch {
                hits: Vec::new(),
                capped: false,
            });
        }
        let finder = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostFirst)
            .ascii_case_insensitive(!case_sensitive)
            .build([query.as_bytes()])
            .map_err(|e| Error::Parse(format!("검색어를 처리하지 못했습니다: {e}")))?;

        let offset = self.header_offset();
        let mut hits: Vec<TableHit> = Vec::new();
        let mut capped = false;

        // Hits arrive in ascending offset order, so the record they fall in
        // only ever moves forward and one cached split serves a run of them.
        let mut cached: Option<(u32, Vec<(u32, u32)>)> = None;

        for found in finder.find_iter(&self.bytes[..]) {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            if hits.len() >= MAX_SEARCH_HITS {
                capped = true;
                break;
            }
            let at = found.start() as u32;
            let Some(record) = self.record_at(at) else {
                continue;
            };
            // Matches in the header are not data rows; the header is always on
            // screen anyway, so there is nothing to scroll to.
            if record < offset {
                continue;
            }
            let fields = match &cached {
                Some((cached_record, fields)) if *cached_record == record => fields,
                _ => {
                    let Some((start, end)) = self.record_span(record) else {
                        continue;
                    };
                    let fields = record_fields(&self.bytes, start, end, self.delimiter);
                    cached = Some((record, fields));
                    &cached.as_ref().expect("just set").1
                }
            };
            let Some(column) = fields.iter().position(|&(s, e)| at >= s && at < e) else {
                // The match straddles a delimiter or a quote, so it is not
                // inside any one cell and there is nothing to point at.
                continue;
            };
            let row = record - offset;
            // One hit per cell: a query occurring twice in the same cell is one
            // place to look, not two.
            if hits.last().map(|h| (h.row, h.column)) == Some((row, column as u32)) {
                continue;
            }
            hits.push(TableHit {
                row,
                column: column as u32,
            });
        }

        Ok(TableSearch { hits, capped })
    }

    fn record_span(&self, record: u32) -> Option<(u32, u32)> {
        let start = *self.starts.get(record as usize)?;
        let end = match self.starts.get(record as usize + 1) {
            // The next record starts just past the newline that ended this one.
            Some(&next) => next.saturating_sub(1),
            None => self.bytes.len() as u32,
        };
        // Two ways a line ending can still be attached: the carriage return of
        // a CRLF pair, and the newline itself on the file's last record, which
        // has no following start to measure against.
        let mut end = end;
        while end > start
            && matches!(self.bytes.get(end as usize - 1), Some(b'\r') | Some(b'\n'))
        {
            end -= 1;
        }
        Some((start, end))
    }

    /// Which record a byte offset falls in.
    fn record_at(&self, offset: u32) -> Option<u32> {
        if self.starts.is_empty() {
            return None;
        }
        let index = self.starts.partition_point(|&start| start <= offset);
        Some(index.saturating_sub(1) as u32)
    }

    fn record_cells(&self, record: u32) -> Vec<TableCell> {
        let Some((start, end)) = self.record_span(record) else {
            return Vec::new();
        };
        let mut cells: Vec<TableCell> = record_fields(&self.bytes, start, end, self.delimiter)
            .into_iter()
            .map(|span| {
                let (text, truncated) =
                    decode_cell(&self.bytes, span, CELL_PREVIEW_CHARS, usize::MAX);
                TableCell { text, truncated }
            })
            .collect();
        // A ragged record still has to line up with the columns beside it.
        cells.resize_with(self.column_count as usize, || TableCell {
            text: String::new(),
            truncated: false,
        });
        cells
    }
}

struct RecordScan {
    starts: Vec<u32>,
    column_count: u32,
    truncated: bool,
}

/// One pass over the bytes, recording where each record begins.
///
/// Quoting is what makes this more than `split('\n')`: a newline inside a
/// quoted field is part of the value, not the end of the row.
fn scan_records(
    bytes: &[u8],
    delimiter: u8,
    progress: &mut impl FnMut(usize),
    should_stop: &dyn Fn() -> bool,
) -> Result<RecordScan> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let bom = (bytes.len() - body.len()) as u32;

    let mut starts: Vec<u32> = Vec::new();
    let mut column_count: u32 = 0;
    let mut fields: u32 = 1;
    let mut truncated = false;
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut next_progress = PROGRESS_STEP;
    let mut i = 0usize;

    if !body.is_empty() {
        starts.push(bom);
    }

    while i < body.len() {
        if i >= next_progress {
            if should_stop() {
                return Err(Error::Cancelled);
            }
            progress(i);
            next_progress = i + PROGRESS_STEP;
        }

        let b = body[i];
        if in_quotes {
            if b == b'"' {
                if body.get(i + 1) == Some(&b'"') {
                    i += 2;
                    continue;
                }
                in_quotes = false;
            }
            i += 1;
            continue;
        }

        if b == b'"' && at_field_start {
            in_quotes = true;
            at_field_start = false;
        } else if b == delimiter {
            fields += 1;
            at_field_start = true;
        } else if b == b'\n' {
            column_count = column_count.max(fields);
            fields = 1;
            at_field_start = true;
            if i + 1 < body.len() {
                if starts.len() >= MAX_RECORDS {
                    truncated = true;
                    break;
                }
                starts.push(bom + i as u32 + 1);
            }
        } else {
            at_field_start = false;
        }
        i += 1;
    }
    column_count = column_count.max(fields);

    // A file ending in a newline has no record after it, and a run of blank
    // lines at the end is padding rather than data.
    while starts.len() > 1 {
        let last = *starts.last().expect("non-empty");
        let end = bytes.len() as u32;
        let empty = bytes[last as usize..end as usize]
            .iter()
            .all(|&b| b == b'\r' || b == b'\n');
        if empty {
            starts.pop();
        } else {
            break;
        }
    }

    Ok(RecordScan {
        starts,
        column_count: column_count.max(1),
        truncated,
    })
}

/// Byte spans of each field in one record, quotes included.
fn record_fields(bytes: &[u8], start: u32, end: u32, delimiter: u8) -> Vec<(u32, u32)> {
    let mut spans = Vec::new();
    let mut field_start = start;
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut i = start as usize;
    let end_usize = end as usize;

    while i < end_usize {
        let b = bytes[i];
        if in_quotes {
            if b == b'"' {
                if bytes.get(i + 1) == Some(&b'"') {
                    i += 2;
                    continue;
                }
                in_quotes = false;
            }
            i += 1;
            continue;
        }
        if b == b'"' && at_field_start {
            in_quotes = true;
            at_field_start = false;
        } else if b == delimiter {
            spans.push((field_start, i as u32));
            field_start = i as u32 + 1;
            at_field_start = true;
        } else {
            at_field_start = false;
        }
        i += 1;
    }
    spans.push((field_start, end));
    spans
}

/// One field's text: surrounding quotes removed and doubled quotes collapsed.
///
/// `max_chars` bounds the preview so a cell holding a megabyte cannot stall the
/// IPC channel; `max_bytes` bounds the source instead, for copying. Exactly one
/// of the two is ever a real limit.
fn decode_cell(bytes: &[u8], span: (u32, u32), max_chars: usize, max_bytes: usize) -> (String, bool) {
    let (start, end) = span;
    let raw = &bytes[start as usize..end as usize];
    let mut cut = raw.len() > max_bytes;
    let raw = &raw[..raw.len().min(max_bytes)];

    let quoted = raw.first() == Some(&b'"');
    let inner = if quoted {
        let tail = if !cut && raw.len() > 1 && raw.last() == Some(&b'"') {
            raw.len() - 1
        } else {
            raw.len()
        };
        &raw[1..tail]
    } else {
        raw
    };

    let text = String::from_utf8_lossy(inner);
    let mut out = String::with_capacity(text.len());
    let mut chars = 0usize;
    let mut pending_quote = false;

    for ch in text.chars() {
        if chars >= max_chars {
            cut = true;
            break;
        }
        // Inside a quoted field, "" stands for one quote.
        if quoted && ch == '"' {
            if pending_quote {
                pending_quote = false;
            } else {
                pending_quote = true;
                continue;
            }
        } else {
            pending_quote = false;
        }
        if max_chars == usize::MAX {
            out.push(ch);
        } else {
            push_display(&mut out, ch, false);
        }
        chars += 1;
    }
    (out, cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(src: &str, delimiter: u8) -> TableDoc {
        TableDoc::build(
            Arc::new(DocBytes::from(src.as_bytes().to_vec())),
            delimiter,
            |_| {},
            &|| false,
        )
        .expect("scan failed")
    }

    fn texts(row: &TableRow) -> Vec<&str> {
        row.cells.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn a_plain_file_splits_into_rows_and_columns() {
        let doc = doc("a,b,c\n1,2,3\n4,5,6\n", b',');
        let stats = doc.stats();
        assert_eq!(stats.row_count, 2);
        assert_eq!(stats.column_count, 3);
        assert_eq!(doc.header(), vec!["a", "b", "c"]);

        let page = doc.page(0, 10);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(texts(&page.rows[0]), ["1", "2", "3"]);
        assert_eq!(texts(&page.rows[1]), ["4", "5", "6"]);
    }

    /// The whole reason this is not `split('\n')`.
    #[test]
    fn a_newline_inside_quotes_stays_in_its_cell() {
        let doc = doc("a,b\n\"line one\nline two\",x\n", b',');
        assert_eq!(doc.stats().row_count, 1);
        let page = doc.page(0, 10);
        assert_eq!(texts(&page.rows[0]), ["line one\\nline two", "x"]);
    }

    /// Rows are drawn at a fixed height and positioned by index, so a cell
    /// carrying a newline would paint over the rows beneath it.
    #[test]
    fn no_cell_preview_spans_more_than_one_line() {
        let doc = doc("a,b\n\"x\ny\",\"p\tq\"\n", b',');
        for row in doc.page(0, 10).rows {
            for cell in row.cells {
                assert_eq!(cell.text.lines().count().max(1), 1, "{:?}", cell.text);
                assert!(!cell.text.contains(['\n', '\r', '\t']));
            }
        }
    }

    #[test]
    fn doubled_quotes_collapse_to_one() {
        let doc = doc("a\n\"he said \"\"hi\"\"\"\n", b',');
        let page = doc.page(0, 10);
        assert_eq!(texts(&page.rows[0]), [r#"he said "hi""#]);
    }

    /// Copying is a different job from previewing: the grid shows `x\ny` so it
    /// stays on one line, but the clipboard gets the newline.
    #[test]
    fn copying_a_cell_gives_its_real_text() {
        let doc = doc("a,b\n\"x\ny\",2\n", b',');
        let (text, truncated) = doc.cell_text(0, 0).expect("cell");
        assert_eq!(text, "x\ny");
        assert!(!truncated);
    }

    #[test]
    fn copying_a_row_gives_the_source_line() {
        let doc = doc("a,b\n1,\"x,y\"\n", b',');
        assert_eq!(doc.row_text(0).as_deref(), Some("1,\"x,y\""));
    }

    #[test]
    fn crlf_endings_do_not_leak_into_cells() {
        let doc = doc("a,b\r\n1,2\r\n3,4\r\n", b',');
        assert_eq!(doc.stats().row_count, 2);
        let page = doc.page(0, 10);
        assert_eq!(texts(&page.rows[0]), ["1", "2"]);
        assert_eq!(texts(&page.rows[1]), ["3", "4"]);
        assert_eq!(doc.header(), vec!["a", "b"]);
    }

    #[test]
    fn a_ragged_row_is_padded_to_the_widest() {
        let doc = doc("a,b,c\n1\n2,3,4,5\n", b',');
        assert_eq!(doc.stats().column_count, 4);
        let page = doc.page(0, 10);
        assert_eq!(texts(&page.rows[0]), ["1", "", "", ""]);
        assert_eq!(texts(&page.rows[1]), ["2", "3", "4", "5"]);
    }

    #[test]
    fn a_missing_trailing_newline_still_yields_the_last_row() {
        let doc = doc("a,b\n1,2", b',');
        assert_eq!(doc.stats().row_count, 1);
        assert_eq!(texts(&doc.page(0, 10).rows[0]), ["1", "2"]);
    }

    #[test]
    fn blank_lines_at_the_end_are_not_rows() {
        let doc = doc("a,b\n1,2\n\n\n", b',');
        assert_eq!(doc.stats().row_count, 1);
    }

    #[test]
    fn turning_the_header_off_promotes_it_to_data() {
        let doc = doc("a,b\n1,2\n", b',');
        assert_eq!(doc.stats().row_count, 1);
        doc.set_has_header(false);
        assert_eq!(doc.stats().row_count, 2);
        assert_eq!(texts(&doc.page(0, 10).rows[0]), ["a", "b"]);
        assert!(doc.header().iter().all(|name| name.is_empty()));
    }

    #[test]
    fn tabs_separate_a_tsv() {
        let doc = doc("a\tb\n1\t2\n", b'\t');
        assert_eq!(doc.stats().column_count, 2);
        assert_eq!(texts(&doc.page(0, 10).rows[0]), ["1", "2"]);
    }

    #[test]
    fn the_delimiter_is_sniffed_from_the_content() {
        assert_eq!(sniff_delimiter(b"a;b;c\n1;2;3\n"), b';');
        assert_eq!(sniff_delimiter(b"a\tb\tc\n1\t2\t3\n"), b'\t');
        assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3\n"), b',');
        assert_eq!(sniff_delimiter(b"a|b\n1|2\n"), b'|');
        // Nothing to find; one column is the right answer.
        assert_eq!(sniff_delimiter(b"alpha\nbeta\n"), b',');
    }

    /// A quoted field full of commas must not outvote the real delimiter.
    #[test]
    fn sniffing_ignores_delimiters_inside_quotes() {
        let src = b"a;b\n\"x,y,z,w,v,u,t,s\";2\n\"p,q,r,s,t,u,v,w\";3\n";
        assert_eq!(sniff_delimiter(src), b';');
    }

    #[test]
    fn search_reports_the_cell_a_match_landed_in() {
        let doc = doc("a,b,c\n1,needle,3\n4,5,needle\n", b',');
        let found = doc.search("needle", false, &AtomicBool::new(false)).expect("search");
        assert!(!found.capped);
        assert_eq!(found.hits.len(), 2);
        assert_eq!((found.hits[0].row, found.hits[0].column), (0, 1));
        assert_eq!((found.hits[1].row, found.hits[1].column), (1, 2));
    }

    #[test]
    fn search_is_case_insensitive_by_default() {
        let doc = doc("a\nNeedle\n", b',');
        let insensitive = doc.search("needle", false, &AtomicBool::new(false)).expect("search");
        assert_eq!(insensitive.hits.len(), 1);
        let sensitive = doc.search("needle", true, &AtomicBool::new(false)).expect("search");
        assert!(sensitive.hits.is_empty());
    }

    /// The header is on screen at all times, so a hit there is not somewhere to
    /// scroll to and would only clutter the step-through.
    #[test]
    fn search_skips_the_header_row() {
        let doc = doc("needle,b\n1,2\n", b',');
        let found = doc.search("needle", false, &AtomicBool::new(false)).expect("search");
        assert!(found.hits.is_empty());
    }

    #[test]
    fn search_counts_a_cell_once() {
        let doc = doc("a\nxx-xx\n", b',');
        let found = doc.search("xx", false, &AtomicBool::new(false)).expect("search");
        assert_eq!(found.hits.len(), 1);
    }

    #[test]
    fn a_cancelled_search_stops() {
        let doc = doc(&"a\n".repeat(1000), b',');
        let cancel = AtomicBool::new(true);
        assert!(doc.search("a", false, &cancel).is_err());
    }

    #[test]
    fn an_empty_document_has_no_rows() {
        let doc = doc("", b',');
        assert_eq!(doc.stats().row_count, 0);
        assert!(doc.page(0, 10).rows.is_empty());
        assert!(doc.cell_text(0, 0).is_none());
    }

    #[test]
    fn a_byte_order_mark_does_not_become_part_of_the_first_header() {
        let doc = doc("\u{feff}a,b\n1,2\n", b',');
        assert_eq!(doc.header(), vec!["a", "b"]);
    }

    #[test]
    fn an_oversized_cell_is_cut_and_flagged() {
        let long = "x".repeat(CELL_PREVIEW_CHARS + 50);
        let doc = doc(&format!("a\n{long}\n"), b',');
        let page = doc.page(0, 10);
        assert!(page.rows[0].cells[0].truncated);
        assert_eq!(page.rows[0].cells[0].text.chars().count(), CELL_PREVIEW_CHARS);
    }

    #[test]
    fn paging_past_the_end_stops_rather_than_wrapping() {
        let doc = doc("a\n1\n2\n3\n", b',');
        let page = doc.page(2, 10);
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].index, 2);
        assert!(doc.page(99, 10).rows.is_empty());
    }
}
