//! Reading a Parquet file.
//!
//! The format this viewer's whole design was already arguing for. A Parquet
//! file is written in row groups with an index at the end, so "do not load it
//! all" is not something to engineer — it is what the file is. Opening reads
//! the footer: how many rows, what the columns are, where the groups sit.
//! Nothing else is read until a row is asked for, and then only the group that
//! row is in.
//!
//! That is why there is no ceiling on the file here. xlsx has one because it is
//! converted whole; a database has none because it is queried; this has none
//! for the second reason. The only bound is on a single row group, which is the
//! unit that has to be decoded at once.
//!
//! Deliberately not using arrow. The arrow reader builds columnar batches,
//! which is the right shape for computing over a file and the wrong one for
//! showing a hundred rows of it — and it doubles the dependency footprint to
//! get there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::query::{Interpretation, Matcher};
use parking_lot::Mutex;
use parquet::basic::{ConvertedType, LogicalType};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Field, Row};
use parquet::schema::types::Type;

use crate::bytes::{DocBytes, SharedBytes};
use crate::error::{Error, Result, Subject};
use crate::grid::{hex_cell, Grid};
use crate::table::{
    CellText, TableCell, TableHit, TablePage, TableRow, TableSearch, CELL_PREVIEW_CHARS,
    MAX_SEARCH_HITS,
};
use crate::tree::text::push_display;

/// The most rows one row group may hold before the file is refused.
///
/// A row group is the unit the format is written in — its pages are compressed
/// together, so there is no half of one to show. That makes it the one place a
/// Parquet file can still ask for everything at once.
///
/// Measured on the machine this was written on, over a five-column file: 250k
/// rows in a group decode in 148ms, a million in 608ms, two million in 1.2s.
/// Linear, at roughly 0.6µs a row. So this ceiling is about two and a half
/// seconds of a frozen window the first time a reader scrolls into a group —
/// past that it stops being a viewer. Writers put 100k to 1M rows in a group,
/// so it refuses only files written to be awkward.
const MAX_GROUP_ROWS: i64 = 4_000_000;

/// How many decoded row groups are kept.
///
/// Two, because a viewport that straddles a boundary needs both — and a third
/// would only pay off when the reader reverses direction, which is exactly when
/// the group is about to be read again anyway.
const CACHED_GROUPS: usize = 2;

/// What the grid needs to know about a file, read from its footer.
pub struct ParquetDoc {
    /// The document's own bytes, kept because a search opens a second reader
    /// over them. Shared, not copied: a file is the map `open_path` made, an
    /// archive entry is the buffer it was unpacked into.
    bytes: Arc<DocBytes>,
    /// Held open so a page does not pay for the footer again. Behind a lock
    /// because decoding needs `&mut` access to what is underneath, and the
    /// state every window shares has to be `Sync`.
    reader: Mutex<SerializedFileReader<SharedBytes>>,
    columns: Vec<String>,
    /// The schema as the file declares it — physical type, logical type and
    /// repetition. A grid cannot show that a column is `TIMESTAMP(MILLIS)`
    /// rather than `INT64`, and it is the fact a reader checks most.
    schema: String,
    name: String,
    row_count: u32,
    /// The row index each group starts at, and how many rows it holds.
    groups: Vec<(u32, u32)>,
    cache: Mutex<Vec<(usize, Arc<Vec<Row>>)>>,
}

impl ParquetDoc {
    /// parquet reads through a `ChunkReader`, and the bytes are one.
    ///
    /// A file never had to be a file here: the reader wants a length and a way
    /// to get a range, which is what a mapped buffer is. So a columnar file
    /// opens from a download or out of an archive on the same code as from
    /// disk, and still without reading past the footer.
    pub fn open(bytes: Arc<DocBytes>) -> Result<Self> {
        let reader =
            SerializedFileReader::new(SharedBytes::new(Arc::clone(&bytes))).map_err(failed)?;
        let metadata = reader.metadata();
        let file = metadata.file_metadata();

        let descriptor = file.schema_descr();
        let columns = (0..descriptor.num_columns())
            .map(|index| descriptor.column(index).name().to_owned())
            .collect();

        let mut groups = Vec::with_capacity(metadata.num_row_groups());
        let mut at: u32 = 0;
        for index in 0..metadata.num_row_groups() {
            let rows = metadata.row_group(index).num_rows();
            if rows > MAX_GROUP_ROWS {
                return Err(Error::GroupTooLarge {
                    rows: rows.min(u32::MAX as i64) as u32,
                    limit: MAX_GROUP_ROWS as u32,
                });
            }
            groups.push((at, rows as u32));
            at = at.saturating_add(rows as u32);
        }

        let schema = describe(file.schema());
        let name = file.schema().name().to_owned();
        Ok(Self {
            bytes,
            reader: Mutex::new(reader),
            columns,
            schema,
            name,
            row_count: at,
            groups,
            cache: Mutex::new(Vec::new()),
        })
    }

    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    pub fn schema(&self) -> &str {
        &self.schema
    }

    /// What the one collection is called.
    ///
    /// The schema's root name, which writers set to something meaningful often
    /// enough to be worth showing — `spark_schema`, `arrow_schema`, or the name
    /// of the table that was exported.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    /// How many row groups are decoded right now. For the tests, which have to
    /// be able to say that nothing was read that nobody asked for.
    #[cfg(test)]
    pub fn cached(&self) -> usize {
        self.cache.lock().len()
    }

    /// Which group holds `row`, and which row of that group it is.
    fn locate(&self, row: u32) -> Option<(usize, usize)> {
        // Binary search over the starts: a file with ten thousand groups should
        // not be walked to reach the last one.
        let group = match self.groups.binary_search_by_key(&row, |(start, _)| *start) {
            Ok(exact) => exact,
            Err(0) => return None,
            Err(after) => after - 1,
        };
        let (start, count) = self.groups[group];
        (row < start + count).then(|| (group, (row - start) as usize))
    }

    /// The rows of one group, decoding it if it is not already held.
    fn group(&self, index: usize) -> Result<Arc<Vec<Row>>> {
        if let Some(held) = self
            .cache
            .lock()
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, rows)| Arc::clone(rows))
        {
            return Ok(held);
        }
        let rows = Arc::new(decode(&self.reader.lock(), index)?);
        let mut cache = self.cache.lock();
        cache.retain(|(at, _)| *at != index);
        cache.push((index, Arc::clone(&rows)));
        // Oldest out. Two is small enough that a list beats a map.
        while cache.len() > CACHED_GROUPS {
            cache.remove(0);
        }
        Ok(rows)
    }

    fn field(&self, rows: &[Row], row: usize, column: usize) -> Option<Field> {
        rows.get(row)?
            .get_column_iter()
            .nth(column)
            .map(|(_, field)| field.clone())
    }
}

/// Decode one row group into rows.
///
/// The whole group, because that is the unit Parquet is written in — its pages
/// are compressed together and a single row cannot be pulled out of the middle
/// without reading up to it.
fn decode(reader: &SerializedFileReader<SharedBytes>, index: usize) -> Result<Vec<Row>> {
    let group = reader.get_row_group(index).map_err(failed)?;
    let iterator = group.get_row_iter(None).map_err(failed)?;
    let mut rows = Vec::new();
    for row in iterator {
        rows.push(row.map_err(failed)?);
    }
    Ok(rows)
}

fn failed(error: parquet::errors::ParquetError) -> Error {
    Error::ParseFailed {
        subject: Subject::Columnar,
        detail: error.to_string(),
    }
}

impl Grid for ParquetDoc {
    fn row_count(&self) -> u32 {
        self.row_count
    }

    fn column_count(&self) -> u32 {
        self.columns.len() as u32
    }

    fn page(&self, start: u32, count: u32) -> Result<TablePage> {
        let mut rows = Vec::new();
        let mut index = start;
        // Walked group by group: a window is almost always inside one, and at a
        // boundary it is two. Locating every row separately would look up the
        // same group a hundred times.
        while index < start.saturating_add(count) && index < self.row_count {
            let Some((group, offset)) = self.locate(index) else {
                break;
            };
            let held = self.group(group)?;
            let within = held.len().min(
                offset + (start.saturating_add(count) - index) as usize,
            );
            for at in offset..within {
                let cells = (0..self.columns.len())
                    .map(|column| match self.field(&held, at, column) {
                        Some(field) => cell_of(&field),
                        None => empty(),
                    })
                    .collect();
                rows.push(TableRow { index, cells });
                index += 1;
            }
            if within == offset {
                break;
            }
        }
        Ok(TablePage { start, rows })
    }

    fn cell_text(&self, row: u32, column: u32) -> Result<CellText> {
        if column as usize >= self.columns.len() {
            return Err(Error::NoSuchCell);
        }
        let (group, offset) = self.locate(row).ok_or(Error::NoSuchRow)?;
        let held = self.group(group)?;
        let field = self
            .field(&held, offset, column as usize)
            .ok_or(Error::NoSuchCell)?;
        Ok(CellText {
            text: full_text(&field),
            truncated: false,
        })
    }

    fn row_text(&self, row: u32) -> Result<CellText> {
        let (group, offset) = self.locate(row).ok_or(Error::NoSuchRow)?;
        let held = self.group(group)?;
        let row = held.get(offset).ok_or(Error::NoSuchRow)?;
        // Tab separated, like every other grid here.
        let text = row
            .get_column_iter()
            .map(|(_, field)| full_text(field))
            .collect::<Vec<_>>()
            .join("\t");
        Ok(CellText {
            text,
            truncated: false,
        })
    }

    fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        how: Interpretation,
        cancel: &AtomicBool,
    ) -> Result<TableSearch> {
        if query.is_empty() {
            return Ok(TableSearch {
                hits: Vec::new(),
                capped: false,
            });
        }
        let matcher = Matcher::new(query, case_sensitive, how)?;

        // Its own reader, so a search over a large file does not hold the lock
        // the viewport needs — and its own decoding, so the two groups the
        // reader is looking at are not evicted by the ones being searched.
        let searching = SerializedFileReader::new(SharedBytes::new(Arc::clone(&self.bytes)))
            .map_err(failed)?;

        let mut hits = Vec::new();
        let mut capped = false;
        for (group, &(start, count)) in self.groups.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            if hits.len() >= MAX_SEARCH_HITS {
                capped = true;
                break;
            }
            let rows = decode(&searching, group)?;
            for (offset, row) in rows.iter().enumerate().take(count as usize) {
                if cancel.load(Ordering::Relaxed) {
                    return Err(Error::Cancelled);
                }
                for (column, (_, field)) in row.get_column_iter().enumerate() {
                    // Searched as shown: a reader looking for a timestamp means
                    // the one on screen, not the integer behind it.
                    if matcher.matches(&full_text(field)) {
                        hits.push(TableHit {
                            row: start + offset as u32,
                            column: column as u32,
                        });
                    }
                }
            }
        }
        Ok(TableSearch { hits, capped })
    }
}

fn empty() -> TableCell {
    TableCell {
        text: String::new(),
        truncated: false,
        null: false,
    }
}

/// One value as the grid draws it.
fn cell_of(field: &Field) -> TableCell {
    if matches!(field, Field::Null) {
        return TableCell {
            text: String::new(),
            truncated: false,
            null: true,
        };
    }
    if let Field::Bytes(bytes) = field {
        let (text, truncated) = hex_cell(bytes.data(), true);
        return TableCell {
            text,
            truncated,
            null: false,
        };
    }

    let text = full_text(field);
    let mut out = String::with_capacity(text.len());
    let mut taken = 0usize;
    for character in text.chars() {
        if taken == CELL_PREVIEW_CHARS {
            return TableCell {
                text: out,
                truncated: true,
                null: false,
            };
        }
        // Quotes left alone: a cell is a value, not a quoted string.
        push_display(&mut out, character, false);
        taken += 1;
    }
    TableCell {
        text: out,
        truncated: false,
        null: false,
    }
}

/// One value, whole — what copying it gives.
///
/// `Field` has a `Display` of its own, and it is right about numbers and dates
/// and wrong about everything this app has already decided: it quotes strings,
/// writes timestamps as `2026-08-29 10:40:00.000 +00:00`, and prints bytes as a
/// list of decimals. So the types that matter are written here and the rest
/// falls through to it.
fn full_text(field: &Field) -> String {
    match field {
        Field::Null => String::new(),
        // Unquoted: the same call the other grids make, for the same reason —
        // a table shows values, and quotes on every row are a tax on the eye.
        Field::Str(text) => text.clone(),
        Field::Bytes(bytes) => hex_cell(bytes.data(), false).0,
        // Its own Display writes 0.0 as `0E0`. Parquet has a float and an
        // integer, so a whole float stays a float — the same rule SQLite gets,
        // and the opposite of a spreadsheet's single number type.
        Field::Float(number) => real(*number as f64),
        Field::Double(number) => real(*number),
        Field::TimestampMillis(millis) => timestamp(*millis, 1_000),
        Field::TimestampMicros(micros) => timestamp(*micros, 1_000_000),
        // A list, a map or a struct in one cell, in the shape every other
        // format here uses for a nested value.
        Field::Group(_) | Field::ListInternal(_) | Field::MapInternal(_) => nested(field),
        other => other.to_string(),
    }
}

/// A float, written whole when it is whole.
fn real(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{number:.1}")
    } else {
        format!("{number}")
    }
}

/// A moment as ISO 8601, the way every other timestamp in this app is written.
///
/// Without a zone. The `Field` says milliseconds or microseconds and nothing
/// else; whether the file meant UTC is in the schema, which the schema panel
/// shows. Writing `Z` on a stamp that might be local would be inventing the one
/// fact the value does not carry.
fn timestamp(value: i64, per_second: i64) -> String {
    use chrono::{DateTime, Datelike, Timelike};
    let seconds = value.div_euclid(per_second);
    let remainder = value.rem_euclid(per_second);
    let nanos = (remainder * (1_000_000_000 / per_second)) as u32;
    let Some(moment) = DateTime::from_timestamp(seconds, nanos) else {
        return value.to_string();
    };
    let moment = moment.naive_utc();
    let mut text = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        moment.year(),
        moment.month(),
        moment.day(),
        moment.hour(),
        moment.minute(),
        moment.second()
    );
    // Fractions only when there are any: a whole second should not carry three
    // zeros that say nothing.
    let millis = moment.nanosecond() / 1_000_000;
    let micros = moment.nanosecond() / 1_000 % 1_000;
    if micros > 0 {
        text.push_str(&format!(".{:06}", moment.nanosecond() / 1_000));
    } else if millis > 0 {
        text.push_str(&format!(".{millis:03}"));
    }
    text
}

/// A nested value as JSON-shaped text, like the other grids write one.
fn nested(field: &Field) -> String {
    match field {
        Field::Null => "null".into(),
        Field::Str(text) => format!("{:?}", text),
        Field::Bytes(bytes) => format!("{:?}", hex_cell(bytes.data(), false).0),
        Field::TimestampMillis(millis) => format!("{:?}", timestamp(*millis, 1_000)),
        Field::TimestampMicros(micros) => format!("{:?}", timestamp(*micros, 1_000_000)),
        Field::Date(_) => format!("{:?}", field.to_string()),
        Field::ListInternal(list) => {
            let items: Vec<String> = list.elements().iter().map(nested).collect();
            format!("[{}]", items.join(","))
        }
        Field::MapInternal(map) => {
            let pairs: Vec<String> = map
                .entries()
                .iter()
                .map(|(key, value)| format!("{}:{}", nested(key), nested(value)))
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        Field::Group(row) => {
            let pairs: Vec<String> = row
                .get_column_iter()
                .map(|(name, value)| format!("{:?}:{}", name, nested(value)))
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        other => other.to_string(),
    }
}

/// The schema as the file declares it.
///
/// The library can print its own, but that form nests by indentation across
/// many lines; what a reader wants beside a grid is one line per column saying
/// what that column is.
fn describe(schema: &Type) -> String {
    let mut out = String::new();
    for field in schema.get_fields() {
        describe_into(&mut out, field, 0);
    }
    out
}

fn describe_into(out: &mut String, field: &Arc<Type>, depth: usize) {
    let info = field.get_basic_info();
    for _ in 0..depth {
        out.push_str("  ");
    }
    out.push_str(info.name());
    if field.is_primitive() {
        out.push_str(&format!(" {}", field.get_physical_type()));
    }
    match info.logical_type_ref() {
        Some(logical) => out.push_str(&format!(" {}", describe_logical(logical))),
        None if info.converted_type() != ConvertedType::NONE => {
            out.push_str(&format!(" {}", info.converted_type()));
        }
        None => {}
    }
    if info.has_repetition() {
        out.push_str(&format!(" ({})", info.repetition()));
    }
    out.push('\n');
    // Asking a primitive for its fields is a panic, not an empty answer.
    if field.is_group() {
        for child in field.get_fields() {
            describe_into(out, child, depth + 1);
        }
    }
}

/// The logical type, short enough to sit at the end of a line.
fn describe_logical(logical: &LogicalType) -> String {
    // Debug, because that is the only rendering the type has — and it reads
    // close enough to the schema language: `Timestamp { is_adjusted_to_u_t_c:
    // true, unit: MILLIS }` becomes `TIMESTAMP(MILLIS, UTC)`.
    match logical {
        LogicalType::Timestamp(stamp) => format!(
            "TIMESTAMP({:?}, {})",
            stamp.unit,
            if stamp.is_adjusted_to_u_t_c {
                "UTC"
            } else {
                "local"
            }
        ),
        LogicalType::Decimal(decimal) => {
            format!("DECIMAL({},{})", decimal.precision, decimal.scale)
        }
        other => {
            let debug = format!("{other:?}");
            debug
                .split([' ', '{'])
                .next()
                .unwrap_or(&debug)
                .to_uppercase()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Milliseconds and microseconds both become the same shape, and a whole
    /// second does not carry zeros that say nothing.
    #[test]
    fn a_timestamp_is_written_the_way_every_other_one_here_is() {
        assert_eq!(timestamp(1_788_000_000_000, 1_000), "2026-08-29T10:40:00");
        assert_eq!(timestamp(1_788_000_000_500, 1_000), "2026-08-29T10:40:00.500");
        assert_eq!(
            timestamp(1_788_000_000_000_123, 1_000_000),
            "2026-08-29T10:40:00.000123"
        );
        // Before the epoch, where a truncating division would round the wrong
        // way and put the moment a second late.
        assert_eq!(timestamp(-1, 1_000), "1969-12-31T23:59:59.999");
    }

    // --- against the fixture ------------------------------------------------
    //
    // `cargo run --release --example parquet -- write ../fixtures` writes it,
    // and the repository does not keep it. Without it there is nothing to
    // assert, so these step aside rather than fail.

    fn fixture() -> Option<ParquetDoc> {
        Some(ParquetDoc::open(Arc::new(mapped()?)).expect("open"))
    }

    fn fixture_path() -> Option<std::path::PathBuf> {
        let path = std::path::PathBuf::from("../fixtures/sample.parquet");
        path.exists().then_some(path)
    }

    /// Mapped, which is how a file arrives.
    fn mapped() -> Option<DocBytes> {
        Some(DocBytes::map_file(&fixture_path()?).expect("map"))
    }

    fn text_of(doc: &ParquetDoc, row: u32, column: u32) -> String {
        doc.cell_text(row, column).expect("cell").text
    }

    fn shown(doc: &ParquetDoc, row: u32, column: usize) -> TableCell {
        doc.page(row, 1).expect("page").rows[0].cells[column].clone()
    }

    /// Every type the sample carries, as the grid draws it — and the decisions
    /// this app made before Parquet existed for it, applied again.
    #[test]
    fn the_values_read_the_way_this_app_has_always_read_them() {
        let Some(doc) = fixture() else { return };
        assert_eq!(doc.row_count(), 6);
        assert_eq!(doc.column_count(), 7);
        assert_eq!(
            doc.columns(),
            ["id", "name", "score", "at", "day", "payload", "active"]
        );

        assert_eq!(text_of(&doc, 0, 0), "0");
        assert_eq!(text_of(&doc, 0, 1), "가나다");
        // Parquet has a double and an integer, so a whole double stays a
        // double — the opposite of a spreadsheet, where there is one number.
        assert_eq!(text_of(&doc, 0, 2), "0.5");
        assert_eq!(text_of(&doc, 1, 2), "1.0");
        assert_eq!(text_of(&doc, 0, 3), "2026-08-29T10:40:00");
        assert_eq!(text_of(&doc, 1, 3), "2026-08-29T10:40:00.500");
        assert_eq!(text_of(&doc, 0, 4), "2026-08-28");
        assert_eq!(text_of(&doc, 0, 6), "true");

        // A null is not an empty string, and it says so with the flag every
        // other format here uses.
        let missing = shown(&doc, 5, 1);
        assert!(missing.null);
        assert_eq!(missing.text, "");
        assert_eq!(text_of(&doc, 5, 1), "");

        // Bytes are hex, cut with their size, and whole when copied.
        assert_eq!(shown(&doc, 0, 5).text, "x'010203'");
        let long = shown(&doc, 1, 5);
        assert!(long.text.ends_with(" (40 B)"), "got {:?}", long.text);
        assert!(long.truncated);
        assert_eq!(text_of(&doc, 1, 5).len(), 40 * 2 + 3, "every byte, no size");
    }

    /// The point of the format: a window that crosses a row-group boundary is
    /// still a window, and the rows on either side of it are the right ones.
    #[test]
    fn a_window_crossing_row_groups_is_still_in_order() {
        let Some(doc) = fixture() else { return };
        assert_eq!(doc.group_count(), 3, "the fixture is written two rows a group");

        let page = doc.page(0, 6).expect("page");
        assert_eq!(page.rows.len(), 6);
        let ids: Vec<&str> = page.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        assert_eq!(ids, ["0", "1", "2", "3", "4", "5"]);
        for (at, row) in page.rows.iter().enumerate() {
            assert_eq!(row.index, at as u32, "a row knows which row it is");
        }

        // Starting inside a group, and reaching past the end of the file.
        let page = doc.page(3, 10).expect("page");
        let ids: Vec<&str> = page.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        assert_eq!(ids, ["3", "4", "5"]);
        assert_eq!(page.rows[0].index, 3);

        // And past the end entirely.
        assert!(doc.page(6, 10).expect("page").rows.is_empty());
        assert!(matches!(doc.cell_text(6, 0), Err(Error::NoSuchRow)));
        assert!(matches!(doc.cell_text(0, 9), Err(Error::NoSuchCell)));
    }

    /// Only the groups a request touches are decoded, and at most two are kept.
    #[test]
    fn only_what_is_asked_for_is_decoded() {
        let Some(doc) = fixture() else { return };
        assert_eq!(doc.cached(), 0, "opening reads the footer and nothing else");

        doc.page(0, 1).expect("page");
        assert_eq!(doc.cached(), 1);

        doc.page(0, 1).expect("page");
        assert_eq!(doc.cached(), 1, "the same group is not decoded twice");

        // A window across a boundary needs both sides.
        doc.page(1, 2).expect("page");
        assert_eq!(doc.cached(), 2);

        // A third pushes the oldest out rather than growing.
        doc.page(5, 1).expect("page");
        assert_eq!(doc.cached(), 2);
    }

    /// The schema is what the grid cannot show: which INT64 is a timestamp.
    #[test]
    fn the_schema_says_what_the_columns_are() {
        let Some(doc) = fixture() else { return };
        let schema = doc.schema();
        assert!(schema.contains("id INT64 (REQUIRED)"), "got {schema}");
        assert!(
            schema.contains("at INT64 TIMESTAMP(MILLIS, UTC) (OPTIONAL)"),
            "got {schema}"
        );
        assert!(schema.contains("name BYTE_ARRAY STRING"), "got {schema}");
        assert!(schema.contains("day INT32 DATE"), "got {schema}");
    }

    /// Searching finds what is on screen, at the row number the grid shows —
    /// which for a row group past the first is not the row number inside it.
    #[test]
    fn searching_reports_the_row_the_grid_shows() {
        let Some(doc) = fixture() else { return };
        let idle = AtomicBool::new(false);

        let hits = doc.search("Björn", false, Interpretation::Literal, &idle).expect("search").hits;
        assert_eq!(
            hits.iter().map(|h| (h.row, h.column)).collect::<Vec<_>>(),
            [(4, 1)]
        );

        // A timestamp is searched as it is written, not as the integer behind
        // it — and as a substring, so a whole second matches the fraction that
        // follows it too. Both rows in the last group are that second.
        let hits = doc.search("2026-08-29T10:40:04", false, Interpretation::Literal, &idle).expect("search").hits;
        assert_eq!(
            hits.iter().map(|h| (h.row, h.column)).collect::<Vec<_>>(),
            [(4, 3), (5, 3)]
        );
        let hits = doc.search("10:40:04.500", false, Interpretation::Literal, &idle).expect("search").hits;
        assert_eq!(hits.len(), 1, "the fraction narrows it to one");

        // A cancelled search says so rather than answering "nothing found".
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            doc.search("가", false, Interpretation::Literal, &cancelled),
            Err(Error::Cancelled)
        ));
        assert!(doc.search("", false, Interpretation::Literal, &idle).expect("search").hits.is_empty());
    }

    /// A columnar file read out of a buffer is the same file.
    ///
    /// `Owned` is the variant an archive entry and a download arrive as, and
    /// the only one either can be, so this is the path those two actually take.
    /// The assertions are the ones seeking has to get right: where each row
    /// group starts, what is in the one after a boundary, and that a search —
    /// which opens a second reader over the same bytes — finds the same cell.
    #[test]
    fn a_columnar_file_read_from_a_buffer_is_the_same_file() {
        let Some(path) = fixture_path() else { return };
        let owned = Arc::new(DocBytes::Owned(std::fs::read(&path).expect("read")));
        let doc = ParquetDoc::open(owned).expect("open");

        assert_eq!(doc.row_count(), 6);
        assert_eq!(doc.group_count(), 3);

        // The first row of the second group: the one a wrong offset would miss.
        assert_eq!(text_of(&doc, 2, 0), "2");
        assert_eq!(text_of(&doc, 0, 1), "가나다");
        assert_eq!(text_of(&doc, 1, 3), "2026-08-29T10:40:00.500");

        let idle = AtomicBool::new(false);
        let hits = doc
            .search("2026-08-29T10:40:04", false, Interpretation::Literal, &idle)
            .expect("search")
            .hits;
        assert_eq!(
            hits.iter().map(|h| (h.row, h.column)).collect::<Vec<_>>(),
            [(4, 3), (5, 3)]
        );
    }
}
