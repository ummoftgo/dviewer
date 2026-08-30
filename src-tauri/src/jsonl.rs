//! Reading one JSON object per line as a row of a table.
//!
//! A JSONL file and a logfmt log are the same document in different
//! punctuation: a line is a record, a record is named fields, and the columns
//! are the union of the names. So the rules here are the ones `log.rs` already
//! settled — columns in first-seen order, a missing key leaves the cell empty
//! because the field was not written, and the guess is only taken when most of
//! the sample agrees.
//!
//! What differs is where a value ends, which JSON says exactly. Nothing here
//! guesses at that: the document's own scanner reads each line, so a table cell
//! and a tree node are the same bytes.

use crate::tree::scanner::{scan, Kind, ScanLimits};

/// How much of the front of the document the guess is made from.
const SAMPLE_BYTES: usize = 1024 * 1024;
/// And no more lines than this, for a file whose lines are enormous.
const SAMPLE_LINES: usize = 2_000;
/// The share of sampled lines that must be objects for this to be a table.
///
/// The same figure logs use, for the same reason: a handful of odd lines must
/// not talk a real file out of being read, and a handful of good ones must not
/// talk a file into a shape it does not have.
const AGREEMENT: f64 = 0.7;
/// Past this many columns a grid stops being a way to read anything. A file
/// whose objects share no keys would otherwise produce one column per key in
/// the sample.
const MAX_COLUMNS: usize = 64;

/// The columns a JSONL file was found to have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonlLayout {
    /// Keys in the order they were first seen, which is the order the file
    /// itself puts them in — alphabetising would move `timestamp` away from
    /// the front of every row that starts with it.
    pub columns: Vec<String>,
}

impl JsonlLayout {
    pub fn column_count(&self) -> usize {
        self.columns.len()
    }
}

/// Whether this document reads as one object per line, and under what columns.
pub fn detect(bytes: &[u8]) -> Option<JsonlLayout> {
    let sample = sample_lines(bytes);
    if sample.is_empty() {
        return None;
    }

    let mut columns: Vec<String> = Vec::new();
    let mut agreeing = 0usize;

    for line in &sample {
        let Some(keys) = object_keys(line) else {
            continue;
        };
        agreeing += 1;
        for key in keys {
            if columns.len() < MAX_COLUMNS && !columns.iter().any(|seen| *seen == key) {
                columns.push(key);
            }
        }
    }

    if (agreeing as f64) < sample.len() as f64 * AGREEMENT || columns.is_empty() {
        return None;
    }
    Some(JsonlLayout { columns })
}

/// Lines from the front of the document that could be records.
///
/// Blank lines say nothing either way, so they are left out of both sides of
/// the count rather than held against the file.
fn sample_lines(bytes: &[u8]) -> Vec<&[u8]> {
    bytes[..bytes.len().min(SAMPLE_BYTES)]
        .split(|&byte| byte == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
        .take(SAMPLE_LINES)
        .collect()
}

/// The top-level keys of `line`, or None when it is not one JSON object.
fn object_keys(line: &[u8]) -> Option<Vec<String>> {
    let pairs = top_level_pairs(line)?;
    Some(
        pairs
            .into_iter()
            .map(|(key, _)| String::from_utf8_lossy(&line[key.0..key.1]).into_owned())
            .collect(),
    )
}

/// Where each of a line's fields is: the key's text, and the value's span.
///
/// Both are offsets into `line`. A string value's span excludes its quotes — a
/// table shows values, and `"error"` in a cell is punctuation the reader has to
/// look past on every row. Everything else is the bytes as written, so a number
/// stays a number and `null` says `null`.
fn top_level_pairs(line: &[u8]) -> Option<Vec<((usize, usize), (usize, usize))>> {
    // The document's own scanner rather than a second, smaller one. A line is
    // small, this runs only over the sample and over rows on screen, and a
    // reading of the file that disagreed with the tree would be worse than
    // slow.
    let scanned = scan(line, &ScanLimits::default(), |_| {}, &|| false).ok()?;
    let root = scanned.nodes.first()?;
    if root.kind != Kind::Object || scanned.synthetic_root {
        return None;
    }

    let mut pairs = Vec::with_capacity(root.child_count as usize);
    for node in &scanned.nodes[1..] {
        if node.depth != 1 {
            continue;
        }
        let key = (
            node.key_start as usize,
            (node.key_start + node.key_len) as usize,
        );
        let mut start = node.val_start as usize;
        let mut end = start + node.val_len as usize;
        if node.kind == Kind::String && end - start >= 2 {
            start += 1;
            end -= 1;
        }
        pairs.push((key, (start, end)));
    }
    Some(pairs)
}

/// The value spans of one record, one per column.
///
/// A key the record does not have gets an empty span — the honest reading, the
/// same as logfmt's. A line that is not an object at all keeps its whole text
/// in the first column: it is data the file contains, and a row that vanished
/// would be worse than a row in the wrong place. The one-column view has it
/// verbatim either way.
pub fn split(bytes: &[u8], start: u32, end: u32, layout: &JsonlLayout) -> Vec<(u32, u32)> {
    let line = &bytes[start as usize..end as usize];
    let mut spans = vec![(start, start); layout.column_count()];

    let Some(pairs) = top_level_pairs(line) else {
        if let Some(first) = spans.first_mut() {
            *first = (start, end);
        }
        return spans;
    };

    for (key, value) in pairs {
        let name = &line[key.0..key.1];
        // Compared as bytes: a key is matched, not decoded, and a name with an
        // escape in it is rare enough to be left to the tree.
        if let Some(column) = layout
            .columns
            .iter()
            .position(|column| column.as_bytes() == name)
        {
            spans[column] = (start + value.0 as u32, start + value.1 as u32);
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(source: &str) -> JsonlLayout {
        detect(source.as_bytes()).expect("should read as JSONL")
    }

    fn cells(source: &str, layout: &JsonlLayout, line: usize) -> Vec<String> {
        let bytes = source.as_bytes();
        let mut at = 0usize;
        for _ in 0..line {
            at += bytes[at..].iter().position(|&b| b == b'\n').expect("line") + 1;
        }
        let end = bytes[at..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |offset| at + offset);
        split(bytes, at as u32, end as u32, layout)
            .into_iter()
            .map(|(s, e)| String::from_utf8_lossy(&bytes[s as usize..e as usize]).into_owned())
            .collect()
    }

    /// Columns are the union of the keys, in the order the file put them.
    #[test]
    fn columns_are_the_keys_in_the_order_they_appear() {
        let source = "{\"at\":\"1\",\"level\":\"info\"}\n\
                      {\"at\":\"2\",\"msg\":\"두 번째\"}\n\
                      {\"level\":\"warn\",\"at\":\"3\"}\n";
        assert_eq!(layout(source).columns, ["at", "level", "msg"]);
    }

    /// A key a record does not have leaves an empty cell, and a key written out
    /// of order still lands in its own column.
    #[test]
    fn a_missing_key_is_an_empty_cell() {
        let source = "{\"a\":1,\"b\":2}\n{\"b\":3}\n{\"b\":4,\"a\":5}\n";
        let layout = layout(source);
        assert_eq!(layout.columns, ["a", "b"]);
        assert_eq!(cells(source, &layout, 0), ["1", "2"]);
        assert_eq!(cells(source, &layout, 1), ["", "3"]);
        assert_eq!(cells(source, &layout, 2), ["5", "4"]);
    }

    /// A table shows values. Strings lose their quotes; nothing else changes,
    /// so a number stays a number and `null` says so.
    #[test]
    fn a_string_loses_its_quotes_and_nothing_else_does() {
        let source = "{\"s\":\"글자\",\"n\":42,\"f\":1.5,\"b\":true,\"z\":null,\"e\":\"\"}\n";
        let layout = layout(source);
        assert_eq!(
            cells(source, &layout, 0),
            ["글자", "42", "1.5", "true", "null", ""]
        );
    }

    /// A nested value is its own JSON text. Splitting it into more columns
    /// would be guessing at a shape the file did not commit to.
    #[test]
    fn a_nested_value_stays_as_written() {
        let source = "{\"id\":1,\"tags\":[\"a\",\"b\"],\"meta\":{\"x\":1}}\n";
        let layout = layout(source);
        assert_eq!(layout.columns, ["id", "tags", "meta"]);
        assert_eq!(
            cells(source, &layout, 0),
            ["1", "[\"a\",\"b\"]", "{\"x\":1}"]
        );
    }

    /// A line that is not an object keeps its text where it can be seen.
    #[test]
    fn a_line_that_is_not_an_object_is_still_shown() {
        let source = "{\"a\":1,\"b\":2}\n{\"a\":3,\"b\":4}\n{\"a\":5,\"b\":6}\n\
                      {\"a\":7,\"b\":8}\n{\"a\":9,\"b\":0}\n{\"a\":1,\"b\"\n";
        let layout = layout(source);
        assert_eq!(cells(source, &layout, 5), ["{\"a\":1,\"b\"", ""]);
    }

    /// Not everything with lines is a table.
    #[test]
    fn a_file_that_is_not_objects_is_not_a_table() {
        // Arrays, scalars, and a plain log: none of them name their fields.
        assert!(detect(b"[1,2]\n[3,4]\n[5,6]\n").is_none());
        assert!(detect(b"1\n2\n3\n").is_none());
        assert!(detect(b"2026-08-30 INFO started\n2026-08-30 WARN slow\n").is_none());
        assert!(detect(b"").is_none());
        // One object among many lines that are not.
        assert!(detect(b"{\"a\":1}\nplain\nplain\nplain\n").is_none());
    }

    /// A single JSON document that happens to be pretty-printed is not JSONL,
    /// however object-shaped its first line looks.
    #[test]
    fn a_pretty_printed_document_is_not_lines() {
        let source = "{\n  \"a\": 1,\n  \"b\": 2\n}\n";
        assert!(detect(source.as_bytes()).is_none());
    }

    /// Objects with no keys at all leave nothing to make columns from.
    #[test]
    fn empty_objects_make_no_columns() {
        assert!(detect(b"{}\n{}\n{}\n").is_none());
    }
}
