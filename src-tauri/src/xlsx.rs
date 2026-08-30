//! Reading a spreadsheet.
//!
//! The second format that is not a run of bytes, and it arrives the way YAML
//! and TOML do: a library turns the file into values in memory, so there is a
//! ceiling on what may be opened. What it shares with SQLite is the shape —
//! one file holding several collections, one of which is on screen — so it
//! answers through the same `Grid` and is picked with the same control.
//!
//! Coordinates are the sheet's own. Columns are named `A`, `B`, … `AA`, and row
//! 1 is row 1, because the reader who opens a spreadsheet in a viewer is
//! usually checking something against the spreadsheet — and "row 15, column D"
//! has to mean the same thing in both. That is also why the first row is not
//! promoted to a header: it would shift every row number by one.

use std::path::{Path, PathBuf};

use calamine::{Data, Reader, Xlsx};
use parking_lot::RwLock;
use serde::Serialize;

use crate::error::{Error, Result, Subject};
use crate::grid::Grid;
use crate::query::{Interpretation, Matcher};
use crate::table::{
    CellText, TableCell, TableHit, TablePage, TableRow, TableSearch, CELL_PREVIEW_CHARS,
    MAX_SEARCH_HITS,
};
use crate::tree::text::push_display;

/// The most a workbook may be, in bytes of file.
///
/// The same bargain YAML and TOML take, at the same order of size but lower:
/// the reader materialises every value, and an xlsx expands on the way in —
/// shared strings are one index on disk and a whole string in memory, so a
/// modest file can be several times its size once open.
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// How many rows of one sheet are kept.
///
/// A sheet can declare a million rows and hold a hundred. This bounds the
/// pathological case where it really does hold a million.
const MAX_ROWS: usize = 1_000_000;

/// A sheet, as the collection picker lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub name: String,
}

/// An open workbook: the file, and the names of what is in it.
///
/// Sheets are not read here. A workbook with forty sheets must not read forty
/// sheets to show their names — the rows come later, and only for the one that
/// is chosen.
pub struct XlsxDoc {
    path: PathBuf,
    sheets: Vec<Sheet>,
}

impl XlsxDoc {
    pub fn open(path: &Path) -> Result<Self> {
        let size = std::fs::metadata(path)?.len() as usize;
        if size > MAX_INPUT_BYTES {
            return Err(Error::TooLarge {
                subject: Subject::Workbook,
                megabytes: size / 1024 / 1024,
                limit_mb: MAX_INPUT_BYTES / 1024 / 1024,
            });
        }
        let book = open(path)?;
        let sheets = book
            .sheet_names()
            .iter()
            .map(|name| Sheet { name: name.clone() })
            .collect();
        Ok(Self {
            path: path.to_path_buf(),
            sheets,
        })
    }

    pub fn sheets(&self) -> &[Sheet] {
        &self.sheets
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

type Book = Xlsx<std::io::BufReader<std::fs::File>>;

fn open(path: &Path) -> Result<Book> {
    calamine::open_workbook::<Book, _>(path).map_err(|error| Error::ParseFailed {
        subject: Subject::Workbook,
        detail: error.to_string(),
    })
}

/// One sheet, in memory.
///
/// Values and formulas are separate readings of the same sheet. The values are
/// what a spreadsheet shows and are always loaded; the formulas behind them are
/// read only if the reader asks, because a sheet of a hundred thousand cells
/// would otherwise carry a second hundred thousand strings nobody looked at.
pub struct XlsxGrid {
    rows: Vec<Vec<Data>>,
    /// Where the values begin on the sheet.
    ///
    /// A range holds only the cells that were used, so a sheet whose data
    /// starts at C5 hands back a matrix whose first cell is C5 — and putting
    /// that at A1 would move every value two columns and four rows from where
    /// the spreadsheet has it. Coordinates here are the sheet's, so the offset
    /// is kept and applied rather than the empty space being stored.
    origin: (usize, usize),
    columns: usize,
    /// Filled the first time the reader turns formulas on, with an origin of
    /// its own: the first formula is rarely the first value.
    formulas: RwLock<Option<(Vec<Vec<String>>, (usize, usize))>>,
    showing_formulas: RwLock<bool>,
    path: PathBuf,
    name: String,
    truncated: bool,
}

impl XlsxGrid {
    pub fn open(document: &XlsxDoc, name: &str) -> Result<Self> {
        let mut book = open(document.path())?;
        let range = book
            .worksheet_range(name)
            .map_err(|error| Error::ParseFailed {
                subject: Subject::Workbook,
                detail: error.to_string(),
            })?;

        let origin = origin_of(range.start());
        let truncated = origin.0 + range.height() > MAX_ROWS;
        let rows: Vec<Vec<Data>> = range
            .rows()
            .take(MAX_ROWS.saturating_sub(origin.0))
            .map(<[Data]>::to_vec)
            .collect();
        let columns = origin.1 + rows.iter().map(Vec::len).max().unwrap_or(0);

        Ok(Self {
            rows,
            origin,
            columns,
            formulas: RwLock::new(None),
            showing_formulas: RwLock::new(false),
            path: document.path().to_path_buf(),
            name: name.to_owned(),
            truncated,
        })
    }

    /// Spreadsheet column names: `A`, `B`, … `Z`, `AA`.
    pub fn column_names(&self) -> Vec<String> {
        (0..self.columns).map(column_name).collect()
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn showing_formulas(&self) -> bool {
        *self.showing_formulas.read()
    }

    /// Memory the values occupy, near enough for the status bar.
    pub fn heap_bytes(&self) -> usize {
        let cells: usize = self.rows.iter().map(Vec::len).sum();
        let text: usize = self
            .rows
            .iter()
            .flatten()
            .map(|cell| match cell {
                Data::String(s) => s.len(),
                _ => 0,
            })
            .sum();
        cells * std::mem::size_of::<Data>() + text
    }

    /// Show the formulas behind the values, or the values again.
    ///
    /// A display switch, like a log's columns: the sheet is not read again for
    /// the values, only for the formulas, and only the first time.
    pub fn set_formulas(&self, on: bool) -> Result<()> {
        if on && self.formulas.read().is_none() {
            let mut book = open(&self.path)?;
            let range = book
                .worksheet_formula(&self.name)
                .map_err(|error| Error::ParseFailed {
                    subject: Subject::Workbook,
                    detail: error.to_string(),
                })?;
            let origin = origin_of(range.start());
            let rows: Vec<Vec<String>> = range
                .rows()
                .take(MAX_ROWS.saturating_sub(origin.0))
                .map(<[String]>::to_vec)
                .collect();
            *self.formulas.write() = Some((rows, origin));
        }
        *self.showing_formulas.write() = on;
        Ok(())
    }

    /// Whether any cell on this sheet was computed.
    ///
    /// Answered by loading the formulas, so it is asked once when the sheet is
    /// chosen and the answer decides whether the toggle is offered at all.
    pub fn has_formulas(&self) -> bool {
        self.formulas
            .read()
            .as_ref()
            .is_some_and(|(rows, _)| rows.iter().flatten().any(|f| !f.is_empty()))
    }

    fn formula_at(&self, row: usize, column: usize) -> Option<String> {
        if !*self.showing_formulas.read() {
            return None;
        }
        let formulas = self.formulas.read();
        let (rows, origin) = formulas.as_ref()?;
        let text = rows
            .get(row.checked_sub(origin.0)?)?
            .get(column.checked_sub(origin.1)?)?;
        (!text.is_empty()).then(|| format!("={text}"))
    }

    fn value_at(&self, row: usize, column: usize) -> Option<&Data> {
        self.rows
            .get(row.checked_sub(self.origin.0)?)?
            .get(column.checked_sub(self.origin.1)?)
    }

    /// One cell as text, whole.
    fn text_at(&self, row: usize, column: usize) -> String {
        if let Some(formula) = self.formula_at(row, column) {
            return formula;
        }
        self.value_at(row, column).map(cell_text).unwrap_or_default()
    }
}

impl Grid for XlsxGrid {
    fn row_count(&self) -> u32 {
        (self.origin.0 + self.rows.len()) as u32
    }

    fn column_count(&self) -> u32 {
        self.columns as u32
    }

    fn page(&self, start: u32, count: u32) -> Result<TablePage> {
        let mut rows = Vec::new();
        for index in start..start.saturating_add(count) {
            if index >= self.row_count() {
                break;
            }
            let cells = (0..self.columns)
                .map(|column| preview(&self.text_at(index as usize, column)))
                .collect();
            rows.push(TableRow { index, cells });
        }
        Ok(TablePage { start, rows })
    }

    fn cell_text(&self, row: u32, column: u32) -> Result<CellText> {
        if row >= self.row_count() || column as usize >= self.columns {
            return Err(Error::NoSuchCell);
        }
        Ok(CellText {
            text: self.text_at(row as usize, column as usize),
            truncated: false,
        })
    }

    fn row_text(&self, row: u32) -> Result<CellText> {
        if row >= self.row_count() {
            return Err(Error::NoSuchRow);
        }
        // Tab-separated, so a row pasted into a spreadsheet lands in cells
        // again — which is where a row of one usually came from.
        let text = (0..self.columns)
            .map(|column| self.text_at(row as usize, column))
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
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<TableSearch> {
        use std::sync::atomic::Ordering;

        if query.is_empty() {
            return Ok(TableSearch {
                hits: Vec::new(),
                capped: false,
            });
        }
        let matcher = Matcher::new(query, case_sensitive, how)?;

        let mut hits = Vec::new();
        let mut capped = false;
        for row in 0..self.row_count() as usize {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            if hits.len() >= MAX_SEARCH_HITS {
                capped = true;
                break;
            }
            for column in 0..self.columns {
                // Searched as shown: a reader looking for `2026-08-31` means
                // the date they can see, not the serial number behind it.
                if matcher.matches(&self.text_at(row, column)) {
                    hits.push(TableHit {
                        row: row as u32,
                        column: column as u32,
                    });
                }
            }
        }
        Ok(TableSearch { hits, capped })
    }
}

/// Where a range begins, as a zero-based row and column.
///
/// A sheet with nothing on it has no start at all, which is the same thing as
/// starting at the top left of nothing.
fn origin_of(start: Option<(u32, u32)>) -> (usize, usize) {
    start.map_or((0, 0), |(row, column)| (row as usize, column as usize))
}

/// The spreadsheet's name for a column: `A`, `Z`, `AA`, `AB`.
fn column_name(index: usize) -> String {
    let mut name = Vec::new();
    let mut at = index;
    loop {
        name.push(b'A' + (at % 26) as u8);
        if at < 26 {
            break;
        }
        at = at / 26 - 1;
    }
    name.reverse();
    String::from_utf8(name).expect("ascii")
}

/// One value as text.
///
/// Dates are ISO 8601. Reproducing the cell's own format would mean
/// reimplementing Excel's number-format language, which is a wide surface to be
/// subtly wrong on — and a subtly wrong date is worse than a plainly different
/// one. `30-Aug` also loses the year, which a viewer should not do.
fn cell_text(value: &Data) -> String {
    match value {
        // An empty cell and a cell holding "" both show as nothing, which is
        // what a spreadsheet shows for them too.
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Int(number) => number.to_string(),
        // Excel has one number type, so a whole number is written whole: `3`,
        // not `3.0`. That is the opposite of SQLite, where the two are
        // different storage classes and the difference is a fact.
        Data::Float(number) => format_number(*number),
        Data::Bool(flag) => if *flag { "TRUE" } else { "FALSE" }.to_owned(),
        Data::DateTime(stamp) => format_datetime(stamp),
        Data::DateTimeIso(text) => text.clone(),
        Data::DurationIso(text) => text.clone(),
        Data::Error(error) => format!("{error:?}"),
    }
}

fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{number:.0}")
    } else {
        format!("{number}")
    }
}

/// A date, a time, or both, depending on what the cell actually holds.
///
/// A serial below 1 is a time of day with no date behind it — the epoch it
/// would otherwise print (1899-12-31) is an artefact of the encoding, not
/// something anybody wrote.
fn format_datetime(stamp: &calamine::ExcelDateTime) -> String {
    let Some(moment) = stamp.as_datetime() else {
        return format_number(stamp.as_f64());
    };
    use chrono::{Datelike, Timelike};
    let time = format!(
        "{:02}:{:02}:{:02}",
        moment.hour(),
        moment.minute(),
        moment.second()
    );
    if stamp.as_f64().abs() < 1.0 {
        return time;
    }
    let date = format!(
        "{:04}-{:02}-{:02}",
        moment.year(),
        moment.month(),
        moment.day()
    );
    if time == "00:00:00" {
        date
    } else {
        format!("{date}T{time}")
    }
}

/// A cell as the grid draws it: one line, and no longer than a cell can hold.
fn preview(text: &str) -> TableCell {
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
        // Quotes are left alone: a cell is a value, not a quoted string, and a
        // spreadsheet's prose is full of them.
        push_display(&mut out, character, false);
        taken += 1;
    }
    TableCell {
        text: out,
        truncated: false,
        null: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_named_the_way_a_spreadsheet_names_them() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27), "AB");
        assert_eq!(column_name(51), "AZ");
        assert_eq!(column_name(52), "BA");
        assert_eq!(column_name(701), "ZZ");
        assert_eq!(column_name(702), "AAA");
    }

    /// A whole number is whole. Excel has one number type, so `3` is `3`.
    #[test]
    fn a_whole_number_is_written_whole() {
        assert_eq!(format_number(3.0), "3");
        assert_eq!(format_number(-1250.0), "-1250");
        assert_eq!(format_number(990.5), "990.5");
        assert_eq!(format_number(0.0), "0");
    }

    // --- against the fixture ------------------------------------------------
    //
    // These read `fixtures/sample.xlsx`, which `scripts/gen-fixtures.mjs`
    // writes and the repository does not keep. Without it there is nothing to
    // assert, so they step aside rather than fail — the same bargain the
    // benchmark examples take with the huge files.

    fn fixture() -> Option<XlsxDoc> {
        let path = std::path::Path::new("../fixtures/sample.xlsx");
        path.exists().then(|| XlsxDoc::open(path).expect("open"))
    }

    fn text_of(grid: &XlsxGrid, row: u32, column: u32) -> String {
        grid.cell_text(row, column).expect("cell").text
    }

    /// Every shape a spreadsheet cell can be, as the grid shows it.
    #[test]
    fn the_cells_read_as_a_spreadsheet_would_show_them() {
        let Some(book) = fixture() else { return };
        assert_eq!(
            book.sheets().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["매출", "비고"]
        );

        let sheet = XlsxGrid::open(&book, "매출").expect("sheet");
        assert_eq!(sheet.column_names(), ["A", "B", "C", "D", "E", "F", "G"]);

        // Row 1 is row 1: the first row is not taken as a header, because that
        // would move every row number away from the one the spreadsheet shows.
        assert_eq!(text_of(&sheet, 0, 0), "이름");
        assert_eq!(text_of(&sheet, 1, 0), "가나다 상사");

        // Excel has one number type, so a whole number is whole.
        assert_eq!(text_of(&sheet, 1, 1), "3");
        assert_eq!(text_of(&sheet, 2, 2), "990.5");
        assert_eq!(text_of(&sheet, 3, 2), "-1250");

        // Dates in ISO, and a cell holding only a time says only the time —
        // the 1899 epoch behind it is an artefact, not something anyone wrote.
        assert_eq!(text_of(&sheet, 1, 4), "2026-08-31");
        assert_eq!(text_of(&sheet, 1, 5), "2026-08-31T09:30:00");
        assert_eq!(text_of(&sheet, 2, 5), "12:00:00");

        assert_eq!(text_of(&sheet, 1, 6), "TRUE");
        assert_eq!(text_of(&sheet, 2, 6), "FALSE");

        // An empty cell is empty, and a newline inside a value does not break
        // the row it is drawn in.
        assert_eq!(text_of(&sheet, 3, 1), "");
        assert_eq!(text_of(&sheet, 3, 6), "줄바꿈\n이 든 값");
        assert_eq!(sheet.page(3, 1).expect("page").rows[0].cells[6].text, "줄바꿈\\n이 든 값");
    }

    /// A sheet that does not start at A1 is still read at the coordinates the
    /// spreadsheet gives it. Reading the used range as if it began at the top
    /// left is the mistake this is here to catch.
    #[test]
    fn a_sheet_that_starts_away_from_the_corner_keeps_its_coordinates() {
        let Some(book) = fixture() else { return };
        let sheet = XlsxGrid::open(&book, "비고").expect("sheet");

        // The fixture puts its first value in C4 and its last in D5.
        assert_eq!(sheet.row_count(), 5);
        assert_eq!(sheet.column_count(), 4);
        assert_eq!(sheet.column_names(), ["A", "B", "C", "D"]);

        assert_eq!(text_of(&sheet, 3, 2), "비고");
        assert_eq!(text_of(&sheet, 4, 3), "42");
        // And everything the sheet does not reach is empty rather than shifted.
        assert_eq!(text_of(&sheet, 0, 0), "");
        assert_eq!(text_of(&sheet, 3, 0), "");
    }

    /// Turning formulas on shows them where they are — in the cells they
    /// computed, not at the corner of the sheet.
    #[test]
    fn formulas_appear_in_the_cells_they_computed() {
        let Some(book) = fixture() else { return };
        let sheet = XlsxGrid::open(&book, "매출").expect("sheet");

        assert_eq!(text_of(&sheet, 1, 3), "37500", "the value Excel computed");
        sheet.set_formulas(true).expect("formulas");
        assert!(sheet.has_formulas());
        assert_eq!(text_of(&sheet, 1, 3), "=B2*C2");
        assert_eq!(text_of(&sheet, 3, 3), "=B4*C4");
        // A cell nobody computed still shows its value.
        assert_eq!(text_of(&sheet, 1, 1), "3");
        assert_eq!(text_of(&sheet, 0, 0), "이름");

        sheet.set_formulas(false).expect("values");
        assert_eq!(text_of(&sheet, 1, 3), "37500");
    }

    /// Searching finds what the reader can see, including a date they could
    /// never have found by its serial number.
    #[test]
    fn searching_finds_what_is_on_screen() {
        let Some(book) = fixture() else { return };
        let sheet = XlsxGrid::open(&book, "매출").expect("sheet");
        let idle = std::sync::atomic::AtomicBool::new(false);

        let hits = sheet.search("2026-08-31", false, Interpretation::Literal, &idle).expect("search").hits;
        assert_eq!(
            hits.iter().map(|h| (h.row, h.column)).collect::<Vec<_>>(),
            [(1, 4), (1, 5)]
        );

        // And a row is a row: copying one gives the cells, tab separated.
        let row = sheet.row_text(2).expect("row").text;
        assert!(row.starts_with("라마바 유통\t10\t990.5\t9905\t"));
    }
}
