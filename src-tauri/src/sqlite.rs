//! Reading a SQLite database.
//!
//! The first format here that is not text. Everything the other formats share —
//! memory mapping, encoding detection, byte search, the raw view — assumes a
//! document is a run of bytes someone could read. A database is not; it is a
//! file the reader gets at through queries, and none of that pipeline applies.
//!
//! What it does share is the grid. A table is rows and columns, which is the
//! same thing a CSV is, so the view, the sticky header, the column widths, the
//! cell copying and the virtual scroll are all reused. Only where the rows come
//! from changes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aho_corasick::{AhoCorasick, MatchKind};

use parking_lot::{Mutex, MutexGuard};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::grid::Grid;
use crate::table::{
    CellText, TableCell, TableHit, TablePage, TableRow, TableSearch, CELL_PREVIEW_CHARS,
    MAX_CELL_TEXT_BYTES, MAX_SEARCH_HITS,
};

/// A table or view in the database, as the collection picker shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub name: String,
    /// Views are readable but not tables, and the reader should know which is
    /// which before wondering why one of them has no rowid.
    pub is_view: bool,
}

/// An open database, and the file it came from.
///
/// The connection is behind a lock because a SQLite connection cannot be used
/// from two threads at once — and because the state every window shares has to
/// be `Sync`.
///
/// One shared connection answers the quick questions, and anything that takes
/// real time opens its own (`connect`). Holding the lock for the length of a
/// scan would make the viewport wait on a search, which is the one thing a
/// reader must always be able to do.
pub struct SqliteDoc {
    /// Kept so a second connection can be opened to the same database on the
    /// same terms. See `SqliteDoc::open` for what the terms mean.
    uri: String,
    connection: Mutex<Connection>,
    collections: Vec<Collection>,
}

impl SqliteDoc {
    /// Open `path` read-only.
    ///
    /// Two ways in, and which one depends on whether the database has company.
    /// `immutable=1` promises SQLite that the file cannot change, which lets it
    /// skip locking entirely — good for a viewer, and it opens databases that
    /// another process holds locked. But it also makes SQLite ignore the
    /// write-ahead log, so a database with a `-wal` beside it would be shown as
    /// it stood at the last checkpoint, quietly missing everything written
    /// since. A viewer that silently drops recent data is worse than one that
    /// takes a shared lock, so when there is a journal we read it.
    pub fn open(path: &Path) -> Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        let uri = connection_uri(path);
        let connection = Connection::open_with_flags(&uri, flags).map_err(open_failed)?;
        let collections = list_collections(&connection)?;
        Ok(Self {
            uri,
            connection: Mutex::new(connection),
            collections,
        })
    }

    /// Another connection to the same database, for work that takes long
    /// enough that the shared one must stay free.
    ///
    /// Read-only and cheap — SQLite opens a connection without reading the
    /// file beyond its header — and independent, so a scan on one does not
    /// block a viewport query on the other.
    pub fn connect(&self) -> Result<Connection> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        Connection::open_with_flags(&self.uri, flags).map_err(open_failed)
    }

    pub fn collections(&self) -> &[Collection] {
        &self.collections
    }

    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.connection.lock()
    }

    /// The statement that created a table or view, as the author wrote it.
    pub fn schema_of(&self, name: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        // A name nobody has is a question with an answer, not a failure.
        self.connection()
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = ?1",
                [name],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(query_failed)
            .map(Option::flatten)
    }
}

/// How many rows one checkpoint covers.
///
/// The index is what makes row 3,000,000 reachable without counting to it.
/// SQLite can seek to a rowid instantly but has no notion of "the millionth
/// row", so a jump would otherwise mean `OFFSET 3000000`, which walks every row
/// before it. One rowid every 1,024 rows turns that into a seek plus at most
/// 1,023 steps, and costs 8 bytes per 1,024 rows — a million-row table indexes
/// in under 8KB.
const CHECKPOINT_STRIDE: u32 = 1024;

/// How many rows the opening scan will walk before it stops counting.
///
/// The scan reads one integer per row and nothing else, so it is fast, but a
/// table can always be larger than any number chosen here. Stopping and saying
/// so beats an open-ended wait: the reader still gets a grid over the first
/// rows, and the status bar says it is not all of them.
const MAX_SCANNED_ROWS: u32 = 5_000_000;

/// Bytes of a BLOB shown as hex in the grid.
const BLOB_PREVIEW_BYTES: usize = 16;

/// One table or view, opened for reading.
///
/// Built when a collection is chosen and thrown away when another one is: the
/// index describes that collection's rows and means nothing for the next.
pub struct SqliteGrid {
    database: Arc<SqliteDoc>,
    /// Quoted and ready to interpolate. See `quote_identifier`.
    quoted: String,
    columns: Vec<String>,
    row_count: u32,
    truncated: bool,
    /// `rowid` of the first row of every `CHECKPOINT_STRIDE` rows. Empty when
    /// the collection has no rowid to seek by — see `SqliteGrid::open`.
    checkpoints: Vec<i64>,
}

impl SqliteGrid {
    /// Read enough about `name` to draw a grid over it: its columns, how many
    /// rows it has, and where to seek to reach a given one.
    pub fn open(database: Arc<SqliteDoc>, name: &str) -> Result<Self> {
        Self::open_to(database, name, MAX_SCANNED_ROWS)
    }

    /// Separated so the ceiling can be tested without writing five million rows.
    fn open_to(database: Arc<SqliteDoc>, name: &str, ceiling: u32) -> Result<Self> {
        let quoted = quote_identifier(name);
        // On its own connection: the scan below reads one integer per row, and
        // over millions of them that is long enough that nothing else should
        // have to wait behind it.
        let scanning = database.connect()?;
        let columns = column_names(&scanning, &quoted)?;

        // A view and a WITHOUT ROWID table have no rowid to seek by. Asking is
        // the only reliable way to find out — the catalogue does not say, and a
        // WITHOUT ROWID table is a table like any other in it.
        let seekable = scanning
            .prepare(&format!("SELECT rowid FROM {quoted} LIMIT 1"))
            .is_ok();

        let (row_count, truncated, checkpoints) = if seekable {
            scan_rowids(&scanning, &quoted, ceiling)?
        } else {
            let (count, truncated) = count_rows(&scanning, &quoted, ceiling)?;
            (count, truncated, Vec::new())
        };

        Ok(Self {
            database,
            quoted,
            columns,
            row_count,
            truncated,
            checkpoints,
        })
    }

    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Memory the checkpoints occupy, for the status bar.
    pub fn index_bytes(&self) -> usize {
        self.checkpoints.len() * std::mem::size_of::<i64>()
    }

    /// The statement that reads `count` rows starting at row `start`.
    ///
    /// With checkpoints this seeks: the nearest checkpoint at or before `start`
    /// bounds the scan, and the remainder is stepped over. Without them there
    /// is nothing to seek by and `OFFSET` does the walking — which is why the
    /// far end of a large view is slower to reach than the far end of a table.
    fn window(&self, start: u32, count: u32) -> (String, i64, i64) {
        match self.checkpoints.get((start / CHECKPOINT_STRIDE) as usize) {
            Some(&rowid) => (
                format!(
                    "SELECT * FROM {} WHERE rowid >= {rowid} ORDER BY rowid LIMIT ?1 OFFSET ?2",
                    self.quoted
                ),
                count as i64,
                (start % CHECKPOINT_STRIDE) as i64,
            ),
            None => (
                format!("SELECT * FROM {} LIMIT ?1 OFFSET ?2", self.quoted),
                count as i64,
                start as i64,
            ),
        }
    }

    /// Read one row and hand it to `read`.
    fn with_row<T>(
        &self,
        row: u32,
        read: impl FnOnce(&rusqlite::Row<'_>) -> Result<T>,
    ) -> Result<T> {
        let (sql, _, offset) = self.window(row, 1);
        let connection = self.database.connection();
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut answered = statement
            .query(rusqlite::params![1i64, offset])
            .map_err(query_failed)?;
        let found = answered
            .next()
            .map_err(query_failed)?
            .ok_or(Error::NoSuchRow)?;
        read(found)
    }

    /// Find every cell containing `query`.
    ///
    /// A whole pass over the collection, testing values in Rust rather than
    /// asking SQL to do it. `LIKE` would be faster at the filtering and would
    /// hand back matching rows — but a row is not what the grid needs. It needs
    /// which cell, at which row *number*, and a rowid says nothing about how
    /// many rows come before it. Counting them is the pass this already is.
    ///
    /// On its own connection, so the viewport stays answerable while it runs.
    pub fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        cancel: &AtomicBool,
    ) -> Result<TableSearch> {
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
            .map_err(|error| Error::BadQuery {
                detail: error.to_string(),
            })?;

        let searching = self.database.connect()?;
        let mut statement = searching
            .prepare(&format!("SELECT * FROM {} {}", self.quoted, self.order()))
            .map_err(query_failed)?;
        let mut answered = statement.query([]).map_err(query_failed)?;

        let mut hits = Vec::new();
        let mut capped = false;
        let mut index: u32 = 0;

        while let Some(row) = answered.next().map_err(query_failed)? {
            // Checked once per row rather than once per cell: a row is small
            // enough that finishing one costs nothing, and an atomic read per
            // cell would be the most expensive thing in the loop.
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            if hits.len() >= MAX_SEARCH_HITS {
                capped = true;
                break;
            }
            // Past the ceiling there are no row numbers, because the scan that
            // would have counted them stopped. A hit the grid cannot scroll to
            // is worse than no hit.
            if index >= self.row_count {
                break;
            }

            for column in 0..self.columns.len() {
                if matches(row, column, &finder)? {
                    hits.push(TableHit {
                        row: index,
                        column: column as u32,
                    });
                }
            }
            index += 1;
        }

        Ok(TableSearch { hits, capped })
    }

    /// How the rows are ordered when the whole collection is read.
    ///
    /// By rowid where there is one, so a search and the grid agree on which row
    /// is the thousandth. Without one there is nothing to order by, and both
    /// take whatever order the collection yields — the same order twice, which
    /// is all they have to agree on.
    fn order(&self) -> &'static str {
        if self.checkpoints.is_empty() {
            ""
        } else {
            "ORDER BY rowid"
        }
    }
}

/// Whether one value contains what is being looked for.
///
/// Text is tested as its own bytes rather than as the escaped line the grid
/// draws: the reader is looking for what is in the data. The other classes are
/// short enough that rendering them costs nothing, and a reader who searches
/// for `42` expects to find the number 42.
fn matches(row: &rusqlite::Row<'_>, column: usize, finder: &AhoCorasick) -> Result<bool> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(column).map_err(query_failed)? {
        ValueRef::Null => false,
        ValueRef::Text(bytes) => finder.find(bytes).is_some(),
        ValueRef::Integer(number) => finder.find(number.to_string().as_bytes()).is_some(),
        ValueRef::Real(number) => finder.find(format_real(number).as_bytes()).is_some(),
        // Not searched. A BLOB's bytes are not text, and the hex the grid shows
        // is this app's rendering rather than anything the file says — matching
        // against it would find cells whose data does not contain the query.
        ValueRef::Blob(_) => false,
    })
}

impl Grid for SqliteGrid {
    fn row_count(&self) -> u32 {
        self.row_count
    }

    fn column_count(&self) -> u32 {
        self.columns.len() as u32
    }

    fn page(&self, start: u32, count: u32) -> Result<TablePage> {
        let (sql, limit, offset) = self.window(start, count);
        let connection = self.database.connection();
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut answered = statement
            .query(rusqlite::params![limit, offset])
            .map_err(query_failed)?;

        let mut rows = Vec::new();
        let mut index = start;
        while let Some(row) = answered.next().map_err(query_failed)? {
            let mut cells = Vec::with_capacity(self.columns.len());
            for column in 0..self.columns.len() {
                cells.push(cell_of(row, column, CELL_PREVIEW_CHARS)?);
            }
            rows.push(TableRow { index, cells });
            index += 1;
        }
        Ok(TablePage { start, rows })
    }

    fn cell_text(&self, row: u32, column: u32) -> Result<CellText> {
        if column as usize >= self.columns.len() {
            return Err(Error::NoSuchCell);
        }
        let cell = self.with_row(row, |found| cell_of(found, column as usize, usize::MAX))?;
        Ok(CellText {
            text: cell.text,
            truncated: cell.truncated,
        })
    }

    fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        cancel: &AtomicBool,
    ) -> Result<TableSearch> {
        SqliteGrid::search(self, query, case_sensitive, cancel)
    }

    fn row_text(&self, row: u32) -> Result<CellText> {
        // Tab-separated, so a row pasted into a spreadsheet lands in cells. A
        // value can hold a tab of its own; the alternative is quoting the whole
        // row CSV-style, which is worse to paste anywhere else.
        let text = self.with_row(row, |found| {
            let mut text = String::new();
            for column in 0..self.columns.len() {
                if column > 0 {
                    text.push('\t');
                }
                text.push_str(&cell_of(found, column, usize::MAX)?.text);
            }
            Ok(text)
        })?;
        Ok(CellText {
            text,
            truncated: false,
        })
    }
}

/// Wrap an identifier so a name with a quote, a space or a keyword in it still
/// names one thing. SQLite doubles the quote, as SQL does everywhere else.
fn quote_identifier(name: &str) -> String {
    let doubled = name.replace('"', "\"\"");
    let mut quoted = String::with_capacity(doubled.len() + 2);
    quoted.push('"');
    quoted.push_str(&doubled);
    quoted.push('"');
    quoted
}

/// The column names, taken from a statement that returns no rows.
///
/// `PRAGMA table_info` would answer for a table but not for a view, and the
/// grid has to draw both. Preparing the query the grid will actually run asks
/// the same question the rows will answer.
fn column_names(connection: &Connection, quoted: &str) -> Result<Vec<String>> {
    let statement = connection
        .prepare(&format!("SELECT * FROM {quoted} LIMIT 0"))
        .map_err(query_failed)?;
    Ok(statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect())
}

/// Walk the rowids, keeping one every `CHECKPOINT_STRIDE`.
fn scan_rowids(connection: &Connection, quoted: &str, ceiling: u32) -> Result<(u32, bool, Vec<i64>)> {
    let mut statement = connection
        .prepare(&format!("SELECT rowid FROM {quoted} ORDER BY rowid"))
        .map_err(query_failed)?;
    let mut answered = statement.query([]).map_err(query_failed)?;

    let mut checkpoints = Vec::new();
    let mut count: u32 = 0;
    while let Some(row) = answered.next().map_err(query_failed)? {
        if count % CHECKPOINT_STRIDE == 0 {
            checkpoints.push(row.get(0).map_err(query_failed)?);
        }
        count += 1;
        if count == ceiling {
            return Ok((count, true, checkpoints));
        }
    }
    Ok((count, false, checkpoints))
}

/// How many rows, for a collection with no rowid — and no more than the ceiling.
///
/// The inner `LIMIT` is what keeps this bounded: a plain `COUNT(*)` over a view
/// would run the view to the end, however long that takes.
fn count_rows(connection: &Connection, quoted: &str, ceiling: u32) -> Result<(u32, bool)> {
    let count: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM (SELECT 1 FROM {quoted} LIMIT ?1)"),
            [ceiling as i64],
            |row| row.get(0),
        )
        .map_err(query_failed)?;
    let count = count.max(0) as u32;
    Ok((count, count == ceiling))
}

/// One value, as the grid shows it.
///
/// SQLite's five storage classes do not all become text the same way, and the
/// difference matters to a reader: NULL is not an empty string, and a BLOB is
/// not the mojibake its bytes would make.
fn cell_of(row: &rusqlite::Row<'_>, column: usize, max_chars: usize) -> Result<TableCell> {
    use rusqlite::types::ValueRef;
    let value = row.get_ref(column).map_err(query_failed)?;
    Ok(match value {
        ValueRef::Null => TableCell {
            text: String::new(),
            truncated: false,
            null: true,
        },
        ValueRef::Integer(number) => TableCell {
            text: number.to_string(),
            truncated: false,
            null: false,
        },
        ValueRef::Real(number) => TableCell {
            text: format_real(number),
            truncated: false,
            null: false,
        },
        ValueRef::Text(bytes) => {
            let (text, truncated) = one_line(&String::from_utf8_lossy(bytes), max_chars);
            TableCell {
                text,
                truncated,
                null: false,
            }
        }
        ValueRef::Blob(bytes) => {
            // Copying takes the whole thing, up to the ceiling every other
            // value has; the grid takes a glance and says how big the rest is.
            let shown = if max_chars == usize::MAX {
                bytes.len().min(MAX_CELL_TEXT_BYTES / 2)
            } else {
                bytes.len().min(BLOB_PREVIEW_BYTES)
            };
            let mut text = String::with_capacity(shown * 2 + 3);
            text.push_str("x'");
            for byte in &bytes[..shown] {
                text.push_str(&format!("{byte:02X}"));
            }
            text.push('\'');
            if shown < bytes.len() && max_chars != usize::MAX {
                // The size is the useful fact about a value nobody can read.
                // Only where it was cut: a short one says everything already.
                text.push_str(&format!(" ({} B)", bytes.len()));
            }
            TableCell {
                text,
                truncated: shown < bytes.len(),
                null: false,
            }
        }
    })
}

/// A float as SQLite itself prints it: no trailing zeros, and a whole number
/// still reading as a float rather than as the integer it is not.
fn format_real(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{number:.1}")
    } else {
        format!("{number}")
    }
}

/// Flatten a value to the single line a grid row can hold.
///
/// A newline inside a value would otherwise break the row in two, and the
/// second half would draw over the row below it.
fn one_line(text: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut taken = 0usize;
    for character in text.chars() {
        if taken == max_chars {
            return (out, true);
        }
        match character {
            '\n' => out.push('\u{240a}'),
            '\r' => out.push('\u{240d}'),
            '\t' => out.push('\u{2409}'),
            _ => out.push(character),
        }
        taken += 1;
    }
    (out, false)
}

/// Whether a journal sits beside the database. See `SqliteDoc::open`.
fn has_journal(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    ["-wal", "-journal"]
        .iter()
        .any(|suffix| sibling(path, &format!("{name}{suffix}")).exists())
}

fn sibling(path: &Path, name: &str) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join(name)
}

/// The `file:` URI to open the database with.
fn connection_uri(path: &Path) -> String {
    // Percent-encode everything a URI cannot carry literally. Windows paths
    // bring backslashes and drive letters, and a filename may hold a `?` or a
    // `#`.
    //
    // Non-ASCII bytes go the same way, and this is the part that is easy to get
    // wrong: pushing a byte as a `char` turns 0x80..=0xFF into U+0080..U+00FF,
    // which the string then writes back out as two UTF-8 bytes each. The URI
    // would name a path that does not exist, and only for readers whose
    // directories are not in English — every ASCII test would pass. Percent
    // escapes are bytes, and SQLite turns them back into the same bytes.
    let mut encoded = String::new();
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'?' | b'#' | b'%' | 0x80..=0xFF => encoded.push_str(&format!("%{byte:02X}")),
            b'\\' => encoded.push('/'),
            _ => encoded.push(byte as char),
        }
    }
    if has_journal(path) {
        format!("file:{encoded}?mode=ro")
    } else {
        format!("file:{encoded}?mode=ro&immutable=1")
    }
}

/// Every table and view, in the order a reader would look for them.
///
/// SQLite's own bookkeeping is left out: `sqlite_sequence` and friends are not
/// what anyone opened the file to see. The shadow tables an extension makes —
/// FTS5's `<name>_data`, `<name>_idx` — do show up, because they are named
/// after their owner and nothing in the schema marks them as internal. Telling
/// them apart from a real table would mean guessing, and a guess that hides a
/// reader's own table is worse than a list with a few rows they will not open.
fn list_collections(connection: &Connection) -> Result<Vec<Collection>> {
    let mut statement = connection
        .prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY type = 'view', name",
        )
        .map_err(query_failed)?;

    let rows = statement
        .query_map([], |row| {
            Ok(Collection {
                name: row.get(0)?,
                is_view: row.get::<_, String>(1)? == "view",
            })
        })
        .map_err(query_failed)?;

    let mut collections = Vec::new();
    for row in rows {
        collections.push(row.map_err(query_failed)?);
    }
    Ok(collections)
}

fn open_failed(error: rusqlite::Error) -> Error {
    Error::ParseFailed {
        subject: crate::error::Subject::Database,
        detail: error.to_string(),
    }
}

fn query_failed(error: rusqlite::Error) -> Error {
    Error::ParseFailed {
        subject: crate::error::Subject::Database,
        detail: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_db(dir: &Path, name: &str, setup: &str) -> PathBuf {
        let path = dir.join(name);
        let connection = Connection::open(&path).expect("create");
        connection.execute_batch(setup).expect("setup");
        path
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dviewer-sqlite-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Tables first, then views, each in name order — and SQLite's own
    /// bookkeeping stays out of the list.
    #[test]
    fn collections_are_tables_then_views() {
        let dir = temp_dir("list");
        let path = write_db(
            &dir,
            "app.sqlite",
            "CREATE TABLE zebra (id INTEGER PRIMARY KEY);
             CREATE TABLE alpha (id INTEGER PRIMARY KEY AUTOINCREMENT);
             CREATE VIEW recent AS SELECT * FROM alpha;",
        );
        let doc = SqliteDoc::open(&path).expect("open");
        let names: Vec<(&str, bool)> = doc
            .collections()
            .iter()
            .map(|c| (c.name.as_str(), c.is_view))
            .collect();
        assert_eq!(
            names,
            [("alpha", false), ("zebra", false), ("recent", true)],
            "sqlite_sequence must not appear"
        );
    }

    /// The database is opened read-only: writing through it fails.
    #[test]
    fn the_connection_cannot_write() {
        let dir = temp_dir("readonly");
        let path = write_db(&dir, "app.sqlite", "CREATE TABLE t (id INTEGER);");
        let doc = SqliteDoc::open(&path).expect("open");
        assert!(
            doc.connection().execute("INSERT INTO t VALUES (1)", []).is_err(),
            "a viewer must not be able to write"
        );
    }

    /// A journal beside the database means the write-ahead log has to be read,
    /// so `immutable` — which would ignore it — must not be used.
    #[test]
    fn a_journal_decides_how_the_file_is_opened() {
        let dir = temp_dir("wal");
        let path = write_db(&dir, "app.sqlite", "CREATE TABLE t (id INTEGER);");
        assert!(connection_uri(&path).contains("immutable=1"));

        std::fs::write(dir.join("app.sqlite-wal"), b"").expect("wal");
        let uri = connection_uri(&path);
        assert!(uri.contains("mode=ro"));
        assert!(
            !uri.contains("immutable"),
            "a database with a WAL must not be read as if it could not change"
        );
    }

/// A path outside ASCII has to survive the trip through the URI.
    ///
    /// Every other test here writes to a directory named in English, which is
    /// exactly the reading under which the encoding bug this guards against was
    /// invisible: the file opened, the list came back, and only a reader whose
    /// folders are named in their own language ever saw the failure.
    #[test]
    fn a_path_outside_ascii_opens() {
        let dir = temp_dir("한글-경로");
        let path = write_db(
            &dir,
            "내역.sqlite",
            "CREATE TABLE 주문 (번호 INTEGER PRIMARY KEY, 이름 TEXT);",
        );

        let uri = connection_uri(&path);
        assert!(
            uri.is_ascii(),
            "every non-ASCII byte must leave as a percent escape: {uri}"
        );

        let doc = SqliteDoc::open(&path).expect("a database under a Korean path opens");
        assert_eq!(doc.collections().len(), 1);
        assert_eq!(doc.collections()[0].name, "주문");
    }

    /// The schema comes back as it was written.
    #[test]
    fn the_schema_is_the_authors_own_statement() {
        let dir = temp_dir("schema");
        let path = write_db(&dir, "app.sqlite", "CREATE TABLE t (id INTEGER, name TEXT)");
        let doc = SqliteDoc::open(&path).expect("open");
        let sql = doc.schema_of("t").expect("query").expect("some");
        assert!(sql.contains("CREATE TABLE t"));
        assert!(sql.contains("name TEXT"));
        assert!(doc.schema_of("absent").expect("query").is_none());
    }

    // --- the grid over a collection -----------------------------------------

    fn grid_over(dir: &Path, setup: &str, name: &str) -> SqliteGrid {
        let path = write_db(dir, "grid.sqlite", setup);
        let database = Arc::new(SqliteDoc::open(&path).expect("open"));
        SqliteGrid::open(database, name).expect("grid")
    }

    /// The names come from the query the grid will actually run, which is what
    /// lets a view — with no `table_info` to ask — have columns at all.
    #[test]
    fn a_view_has_columns_like_a_table() {
        let dir = temp_dir("grid-columns");
        let path = write_db(
            &dir,
            "grid.sqlite",
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL);
             INSERT INTO t VALUES (1, 'a', 1.5);
             CREATE VIEW v AS SELECT name AS 이름, score * 2 AS doubled FROM t;",
        );
        let database = Arc::new(SqliteDoc::open(&path).expect("open"));

        let table = SqliteGrid::open(Arc::clone(&database), "t").expect("table grid");
        assert_eq!(table.columns(), ["id", "name", "score"]);

        let view = SqliteGrid::open(database, "v").expect("view grid");
        assert_eq!(view.columns(), ["이름", "doubled"]);
        assert_eq!(view.row_count(), 1);
    }

    /// The checkpoints are the whole point: a row past the first stride has to
    /// come back correct, and by seeking rather than by counting to it.
    #[test]
    fn a_row_past_the_first_checkpoint_is_the_right_row() {
        let dir = temp_dir("grid-checkpoints");
        // Generated in one statement: three thousand separate INSERTs spend
        // more time in the SQL parser than the test spends testing.
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT);
             INSERT INTO t
               WITH RECURSIVE counter(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM counter WHERE id < 3000
               )
               SELECT id, 'row-' || id FROM counter;",
            "t",
        );
        assert_eq!(grid.row_count(), 3000);
        // 3000 rows over a stride of 1024 is three checkpoints.
        assert_eq!(grid.index_bytes(), 3 * 8);

        for (row, expected) in [(0u32, "row-1"), (1023, "row-1024"), (1024, "row-1025"), (2500, "row-2501")] {
            let page = grid.page(row, 1).expect("page");
            assert_eq!(page.rows[0].index, row);
            assert_eq!(page.rows[0].cells[1].text, expected, "at row {row}");
        }

        // And a window that straddles a checkpoint stays in step.
        let page = grid.page(1022, 4).expect("page");
        let labels: Vec<&str> = page.rows.iter().map(|r| r.cells[1].text.as_str()).collect();
        assert_eq!(labels, ["row-1023", "row-1024", "row-1025", "row-1026"]);
    }

    /// A table with no rowid cannot be seeked into, so it is walked. The rows
    /// still have to be the right ones.
    #[test]
    fn a_collection_without_a_rowid_still_pages() {
        let dir = temp_dir("grid-norowid");
        // Zero-padded: a WITHOUT ROWID table is stored in primary-key order,
        // and for a text key that order is the text's, where "k1000" comes
        // before "k200". Padding makes the two orders the same so the test is
        // about paging rather than about collation.
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
             INSERT INTO t
               WITH RECURSIVE counter(id) AS (
                 SELECT 100 UNION ALL SELECT id + 1 FROM counter WHERE id < 1199
               )
               SELECT 'k' || printf('%04d', id), 'v' || id FROM counter;",
            "t",
        );
        assert_eq!(grid.row_count(), 1100);
        assert_eq!(grid.index_bytes(), 0, "nothing to seek by, so nothing stored");

        let page = grid.page(1050, 2).expect("page");
        let keys: Vec<&str> = page.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        assert_eq!(keys, ["k1150", "k1151"]);
    }

    /// NULL and the empty string are different facts and must not arrive as the
    /// same cell. A BLOB arrives as hex rather than as the mojibake its bytes
    /// would make.
    #[test]
    fn the_five_storage_classes_each_read_as_themselves() {
        let dir = temp_dir("grid-values");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a, b, c, d, e);
             INSERT INTO t VALUES (NULL, '', 42, 1.0, x'00FF10');
             INSERT INTO t VALUES ('two
lines', 'tab\there', -7, 0.5, x'');",
            "t",
        );

        let page = grid.page(0, 2).expect("page");
        let first = &page.rows[0].cells;
        assert!(first[0].null, "NULL must say so");
        assert_eq!(first[0].text, "");
        assert!(!first[1].null, "an empty string is not NULL");
        assert_eq!(first[2].text, "42");
        assert_eq!(first[3].text, "1.0", "a whole float still reads as a float");
        assert_eq!(first[4].text, "x'00FF10'");

        let second = &page.rows[1].cells;
        assert_eq!(
            second[0].text, "two\u{240a}lines",
            "a newline inside a value must not break the row in two"
        );
        assert_eq!(second[1].text, "tab\u{2409}here");
        assert_eq!(second[3].text, "0.5");
        assert_eq!(second[4].text, "x''");
    }

    /// Copying takes the value whole, where the grid's cell was shortened.
    #[test]
    fn copying_a_cell_is_not_the_shortened_preview() {
        let dir = temp_dir("grid-copy");
        let long = "가".repeat(CELL_PREVIEW_CHARS + 50);
        let grid = grid_over(
            &dir,
            &format!("CREATE TABLE t (a TEXT, b INTEGER); INSERT INTO t VALUES ('{long}', 7);"),
            "t",
        );

        let shown = &grid.page(0, 1).expect("page").rows[0].cells[0];
        assert_eq!(shown.text.chars().count(), CELL_PREVIEW_CHARS);
        assert!(shown.truncated);

        let copied = grid.cell_text(0, 0).expect("cell text");
        assert_eq!(copied.text.chars().count(), CELL_PREVIEW_CHARS + 50);
        assert!(!copied.truncated);

        let row = grid.row_text(0).expect("row text");
        assert!(row.text.ends_with("\t7"), "a row pastes as columns");

        assert!(matches!(grid.cell_text(0, 9), Err(Error::NoSuchCell)));
        assert!(matches!(grid.row_text(500), Err(Error::NoSuchRow)));
    }

    /// A table whose name needs quoting is still one name.
    #[test]
    fn an_awkward_name_is_still_one_name() {
        let dir = temp_dir("grid-quoting");
        let grid = grid_over(
            &dir,
            "CREATE TABLE \"order by\" (\"a\"\"b\" TEXT); INSERT INTO \"order by\" VALUES ('x');",
            "order by",
        );
        assert_eq!(grid.columns(), ["a\"b"]);
        assert_eq!(grid.row_count(), 1);
    }

    /// Past the ceiling the grid says so rather than counting forever.
    #[test]
    fn the_scan_stops_at_its_ceiling_and_admits_it() {
        let dir = temp_dir("grid-ceiling");
        let path = write_db(
            &dir,
            "grid.sqlite",
            "CREATE TABLE t (id INTEGER PRIMARY KEY);
             INSERT INTO t
               WITH RECURSIVE counter(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM counter WHERE id < 200
               )
               SELECT id FROM counter;",
        );
        let database = Arc::new(SqliteDoc::open(&path).expect("open"));

        let whole = SqliteGrid::open_to(Arc::clone(&database), "t", 500).expect("grid");
        assert_eq!(whole.row_count(), 200);
        assert!(!whole.truncated());

        let capped = SqliteGrid::open_to(database, "t", 50).expect("grid");
        assert_eq!(capped.row_count(), 50);
        assert!(capped.truncated(), "a count that stopped early must say so");
    }

    // --- searching ----------------------------------------------------------

    fn found(grid: &SqliteGrid, query: &str, case_sensitive: bool) -> Vec<(u32, u32)> {
        let idle = AtomicBool::new(false);
        grid.search(query, case_sensitive, &idle)
            .expect("search")
            .hits
            .into_iter()
            .map(|hit| (hit.row, hit.column))
            .collect()
    }

    /// Hits are cells, at the row number the grid shows — which is the point of
    /// walking the rows rather than asking SQL which ones match.
    #[test]
    fn a_hit_names_the_cell_and_the_row_number() {
        let dir = temp_dir("search-hits");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a TEXT, b TEXT, c INTEGER);
             INSERT INTO t VALUES ('빨강', 'nothing', 1);
             INSERT INTO t VALUES ('파랑', '빨강 or so', 42);
             INSERT INTO t VALUES ('초록', 'green', 420);",
            "t",
        );

        assert_eq!(found(&grid, "빨강", false), [(0, 0), (1, 1)]);
        // A number is searched as the number it is, not as bytes nobody sees.
        assert_eq!(found(&grid, "42", false), [(1, 2), (2, 2)]);
        assert_eq!(found(&grid, "없는 말", false), []);
    }

    /// Case folding is ASCII-only, the same rule the rest of the app follows.
    #[test]
    fn case_folding_matches_the_rest_of_the_app() {
        let dir = temp_dir("search-case");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a TEXT);
             INSERT INTO t VALUES ('ERROR at start');
             INSERT INTO t VALUES ('error at start');",
            "t",
        );
        assert_eq!(found(&grid, "error", true), [(1, 0)]);
        assert_eq!(found(&grid, "error", false), [(0, 0), (1, 0)]);
    }

    /// NULL matches nothing, and a BLOB is not searched as the hex the grid
    /// happens to draw — that rendering is this app's, not the file's.
    #[test]
    fn nothing_and_bytes_are_not_text_to_search() {
        let dir = temp_dir("search-null");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a, b);
             INSERT INTO t VALUES (NULL, x'AB1234');
             INSERT INTO t VALUES ('AB1234', NULL);",
            "t",
        );
        assert_eq!(found(&grid, "AB1234", false), [(1, 0)]);
        assert_eq!(found(&grid, "NULL", false), []);
    }

    /// A cancelled search ends as cancelled rather than as an empty answer,
    /// which would look like "nothing found" to whoever asked.
    #[test]
    fn a_cancelled_search_says_so() {
        let dir = temp_dir("search-cancel");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a TEXT);
             INSERT INTO t
               WITH RECURSIVE counter(i) AS (
                 SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 5000
               )
               SELECT 'row ' || i FROM counter;",
            "t",
        );
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            grid.search("row", false, &cancelled),
            Err(Error::Cancelled)
        ));
    }

    /// An empty query is not a search that found everything.
    #[test]
    fn an_empty_query_finds_nothing() {
        let dir = temp_dir("search-empty");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x');",
            "t",
        );
        let idle = AtomicBool::new(false);
        let result = grid.search("", false, &idle).expect("search");
        assert!(result.hits.is_empty());
        assert!(!result.capped);
    }

    /// A BLOB says how big it is where the grid had to cut it, and copying it
    /// takes the whole thing.
    #[test]
    fn a_blob_shows_its_size_and_copies_whole() {
        let dir = temp_dir("blob");
        let grid = grid_over(
            &dir,
            "CREATE TABLE t (a BLOB, b BLOB);
             INSERT INTO t VALUES (x'0102', randomblob(100));",
            "t",
        );
        let cells = &grid.page(0, 1).expect("page").rows[0].cells;
        assert_eq!(cells[0].text, "x'0102'", "a short one needs no size");
        assert!(!cells[0].truncated);

        assert!(cells[1].text.ends_with(" (100 B)"), "got {:?}", cells[1].text);
        assert!(cells[1].truncated);
        assert_eq!(
            cells[1].text.matches(|c: char| c.is_ascii_hexdigit()).count(),
            BLOB_PREVIEW_BYTES * 2 + 4,
            "16 bytes of hex, plus the digits of the size"
        );

        let copied = grid.cell_text(0, 1).expect("cell text");
        assert_eq!(copied.text.len(), 100 * 2 + 3, "every byte, and no size");
        assert!(!copied.truncated);
    }
}
