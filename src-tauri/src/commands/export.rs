//! Bounded clipboard selections and streaming grid exports in displayed order.
use crate::error::{Error, Result, Subject};
use crate::grid::{order::Order, Grid, GridScalar, ScalarKind};
use crate::state::{AppState, DocId, Document};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::State;

const MAX_COPY_BYTES: usize = 8 * 1024 * 1024;
const MAX_COPY_CELLS: u64 = 100_000;
type Jobs = HashMap<DocId, (u64, Arc<AtomicBool>)>;
static JOBS: OnceLock<Mutex<Jobs>> = OnceLock::new();
fn jobs() -> &'static Mutex<Jobs> {
    JOBS.get_or_init(Default::default)
}
fn too_large() -> Error {
    Error::TooLarge {
        subject: Subject::Table,
        megabytes: 9,
        limit_mb: 8,
    }
}

#[derive(Deserialize)]
pub struct RangeRequest {
    start: u32,
    count: u32,
    columns: Vec<u32>,
    headers: Option<Vec<String>>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Jsonl,
}

struct Snapshot {
    doc: Arc<Document>,
    grid: Arc<dyn Grid>,
    order: Option<Arc<Order>>,
    generation: u32,
    revision: u32,
}
impl Snapshot {
    fn new(state: &State<'_, AppState>, id: DocId) -> Result<Self> {
        let doc = state.get(id)?;
        let generation = doc.generation();
        let revision = doc.grid_revision();
        let grid = doc.grid().ok_or(Error::NotReady {
            subject: Subject::Table,
        })?;
        let order = doc.order();
        Ok(Self {
            doc,
            grid,
            order,
            generation,
            revision,
        })
    }
    fn check(&self) -> Result<()> {
        if self.doc.generation() != self.generation
            || self.doc.grid_revision() != self.revision
            || !self.doc.grid().is_some_and(|g| Arc::ptr_eq(&g, &self.grid))
        {
            return Err(Error::Cancelled);
        }
        let now = self.doc.order();
        if !match (&now, &self.order) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        } {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    fn rows(&self) -> u32 {
        self.order
            .as_ref()
            .map_or_else(|| self.grid.row_count(), |o| o.rows.len() as u32)
    }
    fn source_row(&self, row: u32) -> Result<u32> {
        if row >= self.rows() {
            return Err(Error::NoSuchRow);
        }
        Ok(self.order.as_ref().map_or(row, |o| o.rows[row as usize]))
    }
    fn columns(&self, columns: &[u32]) -> Result<()> {
        if columns.is_empty()
            || columns.iter().any(|&c| c >= self.grid.column_count())
            || columns.iter().collect::<HashSet<_>>().len() != columns.len()
        {
            return Err(Error::NoSuchCell);
        }
        Ok(())
    }
}

fn field(text: &str, separator: char) -> String {
    if text.contains([separator, '\r', '\n', '"']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}
fn record(values: impl IntoIterator<Item = String>, separator: char) -> String {
    values
        .into_iter()
        .map(|v| field(&v, separator))
        .collect::<Vec<_>>()
        .join(&separator.to_string())
}
fn append_bounded(buffer: &mut String, value: &str) -> Result<()> {
    if buffer.len().saturating_add(value.len()) > MAX_COPY_BYTES {
        return Err(too_large());
    }
    buffer.push_str(value);
    Ok(())
}

#[tauri::command]
pub async fn grid_range_text(
    state: State<'_, AppState>,
    doc_id: DocId,
    request: RangeRequest,
) -> Result<String> {
    let snapshot = Snapshot::new(&state, doc_id)?;
    tauri::async_runtime::spawn_blocking(move || range_text(&snapshot, request))
        .await
        .map_err(Error::internal)?
}
fn range_text(snapshot: &Snapshot, request: RangeRequest) -> Result<String> {
    snapshot.columns(&request.columns)?;
    if u64::from(request.count) * request.columns.len() as u64 > MAX_COPY_CELLS {
        return Err(too_large());
    }
    if request
        .start
        .checked_add(request.count)
        .is_none_or(|end| end > snapshot.rows())
    {
        return Err(Error::NoSuchRow);
    }
    if request.headers.as_ref().is_some_and(|h| {
        h.len() != request.columns.len()
            || h.iter().map(String::len).sum::<usize>() > MAX_COPY_BYTES
    }) {
        return Err(too_large());
    }
    let mut output = String::new();
    let has_header = request.headers.is_some();
    if let Some(headers) = request.headers {
        append_bounded(&mut output, &record(headers, '\t'))?;
    }
    for row in request.start..request.start + request.count {
        snapshot.check()?;
        let source = snapshot.source_row(row)?;
        if has_header || row > request.start {
            append_bounded(&mut output, "\n")?;
        }
        for (at, &column) in request.columns.iter().enumerate() {
            let value = snapshot.grid.scalar(source, column)?;
            if at > 0 {
                append_bounded(&mut output, "\t")?;
            }
            append_bounded(&mut output, &field(&scalar_text(value), '\t'))?;
        }
    }
    snapshot.check()?;
    Ok(output)
}

fn unique_headers(headers: &[String]) -> Vec<String> {
    // Reserve all original labels first: a duplicate "a" must not steal "a (2)".
    let reserved: HashSet<&str> = headers.iter().map(String::as_str).collect();
    let mut used: HashSet<String> = HashSet::new();
    headers
        .iter()
        .map(|header| {
            let mut name = header.clone();
            let mut suffix = 2;
            while used.contains(&name) {
                name = format!("{header} ({suffix})");
                suffix += 1;
                if reserved.contains(name.as_str()) {
                    continue;
                }
                break;
            }
            while used.contains(&name) || (name != *header && reserved.contains(name.as_str())) {
                name = format!("{header} ({suffix})");
                suffix += 1;
            }
            used.insert(name.clone());
            name
        })
        .collect()
}
fn scalar_text(cell: GridScalar) -> String {
    match cell.kind {
        ScalarKind::Null | ScalarKind::Missing => String::new(),
        _ => cell.text,
    }
}
fn json_value(cell: GridScalar) -> Result<Option<String>> {
    Ok(Some(match cell.kind {
        ScalarKind::Missing => return Ok(None),
        ScalarKind::Null => "null".to_owned(),
        ScalarKind::Boolean => match cell.text.to_ascii_lowercase().as_str() {
            "true" => "true".into(),
            "false" => "false".into(),
            _ => return Err(Error::internal("invalid boolean scalar")),
        },
        ScalarKind::Number | ScalarKind::Structured => {
            // Validate without rebuilding numbers: integers and decimal tokens stay exact.
            serde_json::from_str::<serde::de::IgnoredAny>(&cell.text).map_err(Error::internal)?;
            cell.text
        }
        ScalarKind::Text | ScalarKind::Binary => {
            serde_json::to_string(&cell.text).map_err(Error::internal)?
        }
    }))
}
#[cfg(test)]
fn json_record(headers: &[String], cells: Vec<GridScalar>) -> Result<String> {
    let mut fields = Vec::new();
    for (header, cell) in headers.iter().zip(cells) {
        if let Some(value) = json_value(cell)? {
            fields.push(format!(
                "{}:{value}",
                serde_json::to_string(header).map_err(Error::internal)?
            ));
        }
    }
    Ok(format!("{{{}}}", fields.join(",")))
}

#[tauri::command]
pub fn grid_export_cancel(doc_id: DocId, request_id: u64) {
    if let Some((id, cancel)) = jobs().lock().unwrap().get(&doc_id) {
        if *id == request_id {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub async fn grid_export(
    state: State<'_, AppState>,
    doc_id: DocId,
    request_id: u64,
    path: String,
    format: ExportFormat,
    columns: Vec<u32>,
    headers: Vec<String>,
) -> Result<u32> {
    let snapshot = Snapshot::new(&state, doc_id)?;
    snapshot.columns(&columns)?;
    if headers.len() != columns.len()
        || headers.iter().map(String::len).sum::<usize>() > MAX_COPY_BYTES
    {
        return Err(too_large());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = jobs().lock().unwrap();
        if let Some((_, old)) = jobs.insert(doc_id, (request_id, Arc::clone(&cancel))) {
            old.store(true, Ordering::Relaxed);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Slot(DocId, u64);
        impl Drop for Slot {
            fn drop(&mut self) {
                let mut jobs = jobs().lock().unwrap();
                if jobs.get(&self.0).is_some_and(|(id, _)| *id == self.1) {
                    jobs.remove(&self.0);
                }
            }
        }
        let _slot = Slot(doc_id, request_id);
        snapshot.check()?;
        write_export(Path::new(&path), format, headers, |writer| {
            let check = || {
                snapshot.check()?;
                crate::grid::order::check_cancel(&cancel)
            };
            // Natural and filtered source order use each adapter's sequential scan.
            // A sorted permutation needs random access; no copied records are retained.
            let sequential = snapshot
                .order
                .as_ref()
                .is_none_or(|o| o.rows.windows(2).all(|r| r[0] < r[1]));
            if sequential && snapshot.rows() > 0 {
                let mut at = 0usize;
                let selected = snapshot.order.as_ref().map(|o| o.rows.as_slice());
                snapshot.grid.scan_selected_scalars(
                    &columns,
                    selected,
                    &cancel,
                    &mut |_source, _column, cell| {
                        if at == 0 {
                            check()?;
                            writer.begin_row()?;
                        }
                        writer.cell(at, cell.clone())?;
                        at += 1;
                        if at == columns.len() {
                            writer.end_row()?;
                            at = 0;
                        }
                        Ok(())
                    },
                )?;
            } else {
                for row in 0..snapshot.rows() {
                    check()?;
                    writer.begin_row()?;
                    let source = snapshot.source_row(row)?;
                    for (at, &column) in columns.iter().enumerate() {
                        check()?;
                        writer.cell(at, snapshot.grid.scalar(source, column)?)?;
                    }
                    writer.end_row()?;
                }
            }
            check()?;
            Ok(snapshot.rows())
        })
    })
    .await
    .map_err(Error::internal)?
}

/// Native smoke uses the production IPC implementation and isolated temporary files.
#[tauri::command]
pub async fn smoke_grid_export(
    state: State<'_, AppState>,
    _run: State<'_, crate::smoke::SmokeRun>,
    doc_id: DocId,
) -> Result<serde_json::Value> {
    let snapshot = Snapshot::new(&state, doc_id)?;
    let dir = tempfile::tempdir()?;
    let columns: Vec<u32> = (0..snapshot.grid.column_count()).rev().collect();
    let headers: Vec<String> = columns
        .iter()
        .map(|column| format!("column {column}"))
        .collect();
    let path = dir.path().join("rows.csv").to_string_lossy().into_owned();
    let count = grid_export(
        state.clone(),
        doc_id,
        1,
        path.clone(),
        ExportFormat::Csv,
        columns.clone(),
        headers.clone(),
    )
    .await?;
    let csv = std::fs::read_to_string(&path)?;
    if count != snapshot.rows() || !csv.starts_with(&record(headers.clone(), ',')) {
        return Err(Error::internal("export projection or row count changed"));
    }
    if grid_export(
        state.clone(),
        doc_id,
        2,
        path.clone(),
        ExportFormat::Csv,
        columns.clone(),
        headers.clone(),
    )
    .await
    .is_ok()
        || std::fs::read_to_string(&path)? != csv
    {
        return Err(Error::internal("export overwrote an existing destination"));
    }
    let path = dir.path().join("rows.jsonl").to_string_lossy().into_owned();
    grid_export(
        state.clone(),
        doc_id,
        3,
        path.clone(),
        ExportFormat::Jsonl,
        columns.clone(),
        headers.clone(),
    )
    .await?;
    let jsonl = std::fs::read_to_string(&path)?;
    if jsonl.lines().count() != count as usize {
        return Err(Error::internal("JSONL export lost rows"));
    }
    for line in jsonl.lines() {
        serde_json::from_str::<serde::de::IgnoredAny>(line).map_err(Error::internal)?;
    }
    let path = dir.path().join("cancel.csv").to_string_lossy().into_owned();
    let operation = grid_export(
        state,
        doc_id,
        4,
        path.clone(),
        ExportFormat::Csv,
        columns,
        headers,
    );
    let mut operation = std::pin::pin!(operation);
    use std::future::Future;
    let immediate = std::future::poll_fn(|cx| match operation.as_mut().poll(cx) {
        std::task::Poll::Ready(result) => std::task::Poll::Ready(Some(result)),
        std::task::Poll::Pending => std::task::Poll::Ready(None),
    })
    .await;
    grid_export_cancel(doc_id, 4);
    let result = if let Some(result) = immediate {
        result
    } else {
        operation.await
    };
    let cancelled = result == Err(Error::Cancelled);
    if cancelled && Path::new(&path).exists() {
        return Err(Error::internal("cancelled export left a partial file"));
    }
    if !cancelled {
        result?;
    } // A tiny export may complete before its cancel arrives.
    Ok(
        serde_json::json!({"rows":count,"csvBytes":csv.len(),"jsonlBytes":jsonl.len(),"cancelled":cancelled,"overwriteProtected":true}),
    )
}

struct RowWriter<'a> {
    output: &'a mut BufWriter<std::fs::File>,
    format: ExportFormat,
    names: Vec<String>,
    first: bool,
}
impl RowWriter<'_> {
    fn begin_row(&mut self) -> Result<()> {
        self.first = true;
        if matches!(self.format, ExportFormat::Jsonl) {
            self.output.write_all(b"{")?;
        }
        Ok(())
    }
    fn cell(&mut self, at: usize, cell: GridScalar) -> Result<()> {
        match self.format {
            ExportFormat::Csv => {
                if !self.first {
                    self.output.write_all(b",")?;
                }
                self.output
                    .write_all(field(&scalar_text(cell), ',').as_bytes())?;
            }
            ExportFormat::Jsonl => {
                let Some(value) = json_value(cell)? else {
                    return Ok(());
                };
                if !self.first {
                    self.output.write_all(b",")?;
                }
                self.output.write_all(
                    serde_json::to_string(&self.names[at])
                        .map_err(Error::internal)?
                        .as_bytes(),
                )?;
                self.output.write_all(b":")?;
                self.output.write_all(value.as_bytes())?;
            }
        }
        self.first = false;
        Ok(())
    }
    fn end_row(&mut self) -> Result<()> {
        if matches!(self.format, ExportFormat::Jsonl) {
            self.output.write_all(b"}")?;
        }
        self.output.write_all(b"\n")?;
        Ok(())
    }
}
fn write_export(
    path: &Path,
    format: ExportFormat,
    headers: Vec<String>,
    drive: impl FnOnce(&mut RowWriter<'_>) -> Result<u32>,
) -> Result<u32> {
    // create_new protects both the source and every existing destination.
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    struct PartialFile<'a> {
        path: &'a Path,
        complete: bool,
    }
    impl Drop for PartialFile<'_> {
        fn drop(&mut self) {
            if !self.complete {
                let _ = std::fs::remove_file(self.path);
            }
        }
    }
    let mut partial = PartialFile {
        path,
        complete: false,
    };
    let mut output = BufWriter::new(file);
    let result = (|| {
        if matches!(format, ExportFormat::Csv) {
            for (at, header) in headers.iter().enumerate() {
                if at > 0 {
                    output.write_all(b",")?;
                }
                output.write_all(field(header, ',').as_bytes())?;
            }
            output.write_all(b"\n")?;
        }
        let mut rows = RowWriter {
            output: &mut output,
            format,
            names: unique_headers(&headers),
            first: true,
        };
        let count = drive(&mut rows)?;
        output.flush()?;
        Ok(count)
    })();
    drop(output);
    partial.complete = result.is_ok();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn csv_snapshot(text: &str) -> Snapshot {
        let bytes = Arc::new(crate::bytes::DocBytes::Owned(text.as_bytes().to_vec()));
        let doc = Arc::new(Document::new(
            1,
            "range".into(),
            crate::state::DocSource::Text,
            None,
            crate::state::DocKind::Csv,
            bytes.clone(),
            crate::encoding::decode(bytes.clone()),
        ));
        let table = Arc::new(
            crate::table::TableDoc::build(
                bytes,
                crate::table::Records::Delimited { delimiter: b',' },
                |_| {},
                &|| false,
            )
            .unwrap(),
        );
        doc.set_table(0, table).unwrap();
        Snapshot {
            grid: doc.grid().unwrap(),
            order: None,
            generation: doc.generation(),
            revision: doc.grid_revision(),
            doc,
        }
    }
    #[test]
    fn range_copies_full_values_projection_and_empty_header_rows() {
        let long = "x".repeat(5000);
        let snapshot = csv_snapshot(&format!("id,value\n1,{long}\n2,\n3,\n"));
        assert_eq!(
            range_text(
                &snapshot,
                RangeRequest {
                    start: 0,
                    count: 1,
                    columns: vec![1, 0],
                    headers: Some(vec!["value".into(), "id".into()])
                }
            )
            .unwrap(),
            format!("value\tid\n{long}\t1")
        );
        assert_eq!(
            range_text(
                &snapshot,
                RangeRequest {
                    start: 1,
                    count: 2,
                    columns: vec![1],
                    headers: Some(vec!["".into()])
                }
            )
            .unwrap(),
            "\n\n"
        );
        let mut output = "x".repeat(MAX_COPY_BYTES);
        assert_eq!(append_bounded(&mut output, "😀"), Err(too_large()));
        assert_eq!(output.len(), MAX_COPY_BYTES);
    }
    #[test]
    fn range_uses_filtered_sorted_original_row_mapping() {
        let mut snapshot = csv_snapshot("id,value\n1,keep-a\n2,drop\n3,keep-c\n");
        let (revision, cancel) = snapshot.doc.start_order();
        let order = Arc::new(
            Order::build(
                snapshot.grid.as_ref(),
                Some(crate::grid::order::Sort {
                    column: 0,
                    descending: true,
                }),
                "keep",
                Some(1),
                &cancel,
                &mut |_, _| {},
            )
            .unwrap(),
        );
        snapshot
            .doc
            .finish_order(revision, Some(order.clone()))
            .unwrap();
        snapshot.order = Some(order);
        snapshot.revision = snapshot.doc.grid_revision();
        assert_eq!(
            range_text(
                &snapshot,
                RangeRequest {
                    start: 0,
                    count: 2,
                    columns: vec![1, 0],
                    headers: None
                }
            )
            .unwrap(),
            "keep-c\t3\nkeep-a\t1"
        );
    }
    #[test]
    fn selected_scan_skips_oversized_excluded_values() {
        let large = "x".repeat(crate::table::MAX_CELL_TEXT_BYTES + 1);
        let snapshot = csv_snapshot(&format!("value\n{large}\nkept\n"));
        let cancel = AtomicBool::new(false);
        let mut values = Vec::new();
        snapshot
            .grid
            .scan_selected_scalars(&[0], Some(&[1]), &cancel, &mut |row, _, cell| {
                values.push((row, cell.text.clone()));
                Ok(())
            })
            .unwrap();
        assert_eq!(values, vec![(1, "kept".into())]);
        assert!(snapshot
            .grid
            .scan_scalars(&[0], &cancel, &mut |_, _, _| Ok(()))
            .is_err());
        assert_eq!(
            snapshot.grid.scan_selected_scalars(
                &[0],
                Some(&[1, 0]),
                &cancel,
                &mut |_, _, _| Ok(())
            ),
            Err(Error::NoSuchRow)
        );
    }
    #[test]
    fn sqlite_selected_scan_skips_oversized_values_before_decode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("selected.sqlite");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE data(value TEXT);")
            .unwrap();
        connection
            .execute(
                "INSERT INTO data VALUES (?1)",
                ["x".repeat(crate::table::MAX_CELL_TEXT_BYTES + 1)],
            )
            .unwrap();
        connection
            .execute("INSERT INTO data VALUES ('kept')", [])
            .unwrap();
        drop(connection);
        let database = Arc::new(crate::sqlite::SqliteDoc::open(&path).unwrap());
        let grid = crate::sqlite::SqliteGrid::open(database, "data").unwrap();
        let cancel = AtomicBool::new(false);
        let mut values = Vec::new();
        grid.scan_selected_scalars(&[0], Some(&[1]), &cancel, &mut |row, _, cell| {
            values.push((row, cell.text.clone()));
            Ok(())
        })
        .unwrap();
        assert_eq!(values, vec![(1, "kept".into())]);
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            grid.scan_selected_scalars(&[0], Some(&[1]), &cancel, &mut |_, _, _| Ok(())),
            Err(Error::Cancelled)
        );
    }
    #[test]
    fn mode_scan_and_document_changes_invalidate_snapshot() {
        let snapshot = csv_snapshot("id,value\n1,a\n");
        snapshot
            .doc
            .change_table(|t| t.set_has_header(false))
            .unwrap();
        assert_eq!(snapshot.check(), Err(Error::Cancelled));
        let snapshot = csv_snapshot("id,value\n1,a\n");
        snapshot.doc.start_order();
        assert_eq!(snapshot.check(), Err(Error::Cancelled));
        let snapshot = csv_snapshot("id,value\n1,a\n");
        snapshot.doc.set_kind(crate::state::DocKind::Text);
        assert_eq!(snapshot.check(), Err(Error::Cancelled));
    }
    #[test]
    fn streaming_export_removes_cancelled_and_failed_files_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.csv");
        let result = write_export(&path, ExportFormat::Csv, vec!["n".into()], |writer| {
            writer.begin_row()?;
            writer.cell(
                0,
                GridScalar {
                    text: "one".into(),
                    kind: ScalarKind::Text,
                },
            )?;
            writer.end_row()?;
            Err(Error::Cancelled)
        });
        assert_eq!(result, Err(Error::Cancelled));
        assert!(!path.exists());
        assert!(
            write_export(&path, ExportFormat::Csv, vec!["n".into()], |_| Err(
                Error::NoSuchCell
            ))
            .is_err()
        );
        assert!(!path.exists());
        std::fs::write(&path, "original").unwrap();
        assert!(write_export(&path, ExportFormat::Csv, vec!["n".into()], |_| Ok(0)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    }
    #[test]
    fn streamed_rows_follow_projection_and_exact_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.jsonl");
        assert_eq!(
            write_export(
                &path,
                ExportFormat::Jsonl,
                vec!["number".into(), "value".into()],
                |writer| {
                    for row in 0..3 {
                        writer.begin_row()?;
                        writer.cell(
                            0,
                            GridScalar {
                                text: "9007199254740993".into(),
                                kind: ScalarKind::Number,
                            },
                        )?;
                        writer.cell(
                            1,
                            GridScalar {
                                text: format!("row {row}"),
                                kind: ScalarKind::Text,
                            },
                        )?;
                        writer.end_row()?;
                    }
                    Ok(3)
                }
            )
            .unwrap(),
            3
        );
        assert_eq!(
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .nth(2)
                .unwrap(),
            "{\"number\":9007199254740993,\"value\":\"row 2\"}"
        );
    }
    #[test]
    fn records_quote_real_tabs_newlines_and_quotes() {
        assert_eq!(
            record(vec!["a\tb".into(), "\"\n".into(), "".into()], '\t'),
            "\"a\tb\"\t\"\"\"\n\"\t"
        );
        assert_eq!(
            record(vec!["a,b".into(), "ordinary".into()], ','),
            "\"a,b\",ordinary"
        );
    }
    #[test]
    fn duplicate_labels_do_not_steal_existing_suffixed_labels() {
        assert_eq!(
            unique_headers(&["a".into(), "a".into(), "a (2)".into(), "a".into()]),
            vec!["a", "a (3)", "a (2)", "a (4)"]
        );
    }
    #[test]
    fn jsonl_keeps_numeric_tokens_exact() {
        let numbers = [
            "9007199254740993",
            "18446744073709551617",
            "0.12345678901234567890123456789",
        ];
        for number in numbers {
            assert_eq!(
                json_record(
                    &["n".into()],
                    vec![GridScalar {
                        text: number.into(),
                        kind: ScalarKind::Number
                    }]
                )
                .unwrap(),
                format!("{{\"n\":{number}}}")
            );
        }
    }
    #[test]
    fn jsonl_preserves_types_null_missing_and_empty() {
        let names = ["number", "bool", "nil", "absent", "empty"].map(str::to_owned);
        let cells = vec![
            GridScalar {
                text: "12.5".into(),
                kind: ScalarKind::Number,
            },
            GridScalar {
                text: "true".into(),
                kind: ScalarKind::Boolean,
            },
            GridScalar {
                text: "".into(),
                kind: ScalarKind::Null,
            },
            GridScalar {
                text: "".into(),
                kind: ScalarKind::Missing,
            },
            GridScalar {
                text: "".into(),
                kind: ScalarKind::Text,
            },
        ];
        let value: serde_json::Value =
            serde_json::from_str(&json_record(&names, cells).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"number":12.5,"bool":true,"nil":null,"empty":""})
        );
    }
}
