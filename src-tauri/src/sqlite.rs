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

use parking_lot::{Mutex, MutexGuard};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::error::{Error, Result};

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
/// be `Sync`. Nothing is lost: a viewer asks one question at a time.
pub struct SqliteDoc {
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
            connection: Mutex::new(connection),
            collections,
        })
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
    // Percent-encode what a URI cannot carry literally. Windows paths bring
    // backslashes and drive letters, and a filename may hold a `?` or a `#`.
    let mut encoded = String::new();
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'?' | b'#' | b'%' => encoded.push_str(&format!("%{byte:02X}")),
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
/// SQLite's own bookkeeping tables are left out — `sqlite_sequence` and the
/// shadow tables of an FTS index are not what anyone opened the file to see.
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
}
