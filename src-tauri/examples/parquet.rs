//! Writing the Parquet fixtures, and timing what reading them costs.
//!
//!   cargo run --release --example parquet -- write ../fixtures
//!   cargo run --release --example parquet -- write ../fixtures --huge
//!   cargo run --release --example parquet -- read ../fixtures/huge.parquet "항목 1999999"
//!
//! The fixtures are written here rather than by `scripts/gen-fixtures.mjs`
//! because a Parquet file is a thrift-encoded footer over compressed column
//! chunks — writing one by hand would be reimplementing the format to test the
//! reader against it, which proves nothing. The crate that reads them writes
//! them, and the assertion that matters is that what comes back is what the
//! grid should show.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use dviewer_lib::grid::Grid;
use dviewer_lib::query::Interpretation;
use dviewer_lib::parquet::ParquetDoc;
use parquet::basic::{Compression, Repetition, Type as PhysicalType};
use parquet::data_type::{ByteArray, ByteArrayType, DoubleType, Int32Type, Int64Type};
use parquet::file::properties::WriterProperties;
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::parser::parse_message_type;

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "write".into());
    let target = args.next().unwrap_or_else(|| "../fixtures".into());
    let rest: Vec<String> = args.collect();

    match command.as_str() {
        "write" => write_all(
            Path::new(&target),
            rest.iter().any(|a| a == "--huge"),
            rest.iter()
                .position(|a| a == "--group")
                .and_then(|at| rest.get(at + 1))
                .and_then(|n| n.parse().ok())
                .unwrap_or(250_000),
        ),
        "read" => read(Path::new(&target), rest.first().map(String::as_str)),
        other => eprintln!("unknown command {other:?}; try write or read"),
    }
}

fn write_all(dir: &Path, huge: bool, per_group: i64) {
    std::fs::create_dir_all(dir).expect("fixtures dir");
    sample(&dir.join("sample.parquet"));
    println!("  sample.parquet");
    if huge {
        let started = Instant::now();
        let path = dir.join("huge.parquet");
        huge_file(&path, per_group);
        let size = std::fs::metadata(&path).expect("size").len();
        println!(
            "  huge.parquet  {:.0}MB in {:.1?}",
            size as f64 / 1048576.0,
            started.elapsed()
        );
    }
}

/// Every shape the reader has to get right, in a file small enough to read by
/// eye — and three row groups, because a window that crosses a boundary is
/// where a row-group reader goes wrong.
fn sample(path: &Path) {
    let schema = Arc::new(
        parse_message_type(
            "message row {
               REQUIRED INT64 id;
               OPTIONAL BYTE_ARRAY name (STRING);
               OPTIONAL DOUBLE score;
               OPTIONAL INT64 at (TIMESTAMP(MILLIS, true));
               OPTIONAL INT32 day (DATE);
               OPTIONAL BYTE_ARRAY payload;
               OPTIONAL BOOLEAN active;
             }",
        )
        .expect("schema"),
    );
    let props = Arc::new(
        WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_max_row_group_row_count(Some(2))
            .build(),
    );
    let file = File::create(path).expect("create");
    let mut writer = SerializedFileWriter::new(file, schema, props).expect("writer");

    let names = ["가나다", "라마바", "사아자", "O'Brien", "Björn"];
    for group in 0..3usize {
        let base = group as i64 * 2;
        let mut rg = writer.next_row_group().expect("row group");

        column(&mut rg, |c| {
            c.typed::<Int64Type>()
                .write_batch(&[base, base + 1], None, None)
        });
        // The second row of the last group has no name: a null in the middle of
        // a column, not only at its end.
        let present: &[i16] = if group == 2 { &[1, 0] } else { &[1, 1] };
        let written: Vec<ByteArray> = names
            .iter()
            .skip(group * 2)
            .take(present.iter().filter(|d| **d == 1).count())
            .map(|name| ByteArray::from(*name))
            .collect();
        column(&mut rg, |c| {
            c.typed::<ByteArrayType>()
                .write_batch(&written, Some(present), None)
        });
        column(&mut rg, |c| {
            c.typed::<DoubleType>().write_batch(
                &[base as f64 + 0.5, base as f64 + 1.0],
                Some(&[1, 1]),
                None,
            )
        });
        column(&mut rg, |c| {
            c.typed::<Int64Type>().write_batch(
                &[1_788_000_000_000 + base * 1000, 1_788_000_000_500 + base * 1000],
                Some(&[1, 1]),
                None,
            )
        });
        column(&mut rg, |c| {
            c.typed::<Int32Type>()
                .write_batch(&[20693 + base as i32, 20694 + base as i32], Some(&[1, 1]), None)
        });
        column(&mut rg, |c| {
            c.typed::<ByteArrayType>().write_batch(
                &[
                    ByteArray::from(vec![0x01u8, 0x02, 0x03]),
                    // Longer than the preview, so the cell has to say how big.
                    ByteArray::from(vec![0xABu8; 40]),
                ],
                Some(&[1, 1]),
                None,
            )
        });
        column(&mut rg, |c| {
            c.typed::<parquet::data_type::BoolType>()
                .write_batch(&[group % 2 == 0, group % 2 == 1], Some(&[1, 1]), None)
        });

        rg.close().expect("row group");
    }
    writer.close().expect("close");
    let _ = Repetition::OPTIONAL;
    let _ = PhysicalType::BOOLEAN;
}

/// Two million rows over eight groups: the case the row-group reader exists for.
fn huge_file(path: &Path, per_group: i64) {
    let schema = Arc::new(
        parse_message_type(
            "message row {
               REQUIRED INT64 id;
               OPTIONAL BYTE_ARRAY name (STRING);
               OPTIONAL BYTE_ARRAY slug (STRING);
               OPTIONAL DOUBLE score;
               OPTIONAL INT64 at (TIMESTAMP(MILLIS, true));
             }",
        )
        .expect("schema"),
    );
    let props = Arc::new(
        WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_max_row_group_row_count(Some(per_group as usize))
            .build(),
    );
    let file = File::create(path).expect("create");
    let mut writer = SerializedFileWriter::new(file, schema, props).expect("writer");

    let total: i64 = std::env::var("PARQUET_ROWS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(2_000_000);
    let mut written = 0i64;
    while written < total {
        let count = per_group.min(total - written);
        let ids: Vec<i64> = (written..written + count).collect();
        let names: Vec<ByteArray> = ids
            .iter()
            .map(|id| ByteArray::from(format!("항목 {id}").as_str()))
            .collect();
        let slugs: Vec<ByteArray> = ids
            .iter()
            .map(|id| ByteArray::from(format!("item-{id}").as_str()))
            .collect();
        let scores: Vec<f64> = ids.iter().map(|id| *id as f64 / 7.0).collect();
        let stamps: Vec<i64> = ids.iter().map(|id| 1_788_000_000_000 + id * 1000).collect();
        let present = vec![1i16; count as usize];

        let mut rg = writer.next_row_group().expect("row group");
        column(&mut rg, |c| c.typed::<Int64Type>().write_batch(&ids, None, None));
        column(&mut rg, |c| {
            c.typed::<ByteArrayType>()
                .write_batch(&names, Some(&present), None)
        });
        column(&mut rg, |c| {
            c.typed::<ByteArrayType>()
                .write_batch(&slugs, Some(&present), None)
        });
        column(&mut rg, |c| {
            c.typed::<DoubleType>()
                .write_batch(&scores, Some(&present), None)
        });
        column(&mut rg, |c| {
            c.typed::<Int64Type>()
                .write_batch(&stamps, Some(&present), None)
        });
        rg.close().expect("row group");
        written += count;
    }
    writer.close().expect("close");
}

/// Take the next column, write it, and close it — the three steps every column
/// needs, so the writing above reads as what it writes.
fn column<W: std::io::Write + Send>(
    group: &mut parquet::file::writer::SerializedRowGroupWriter<'_, W>,
    write: impl FnOnce(&mut parquet::file::writer::SerializedColumnWriter<'_>) -> parquet::errors::Result<usize>,
) {
    let mut writer = group.next_column().expect("column").expect("a column");
    write(&mut writer).expect("write");
    writer.close().expect("close");
}

fn read(path: &Path, query: Option<&str>) {
    let started = Instant::now();
    let doc = ParquetDoc::open(path).expect("open");
    println!(
        "열기      {:>8.1?}  (푸터만)  {} 행 × {} 열, 행 그룹 {}",
        started.elapsed(),
        doc.row_count(),
        doc.column_count(),
        doc.group_count()
    );
    println!("스키마\n{}", indent(doc.schema()));

    for row in [0u32, doc.row_count() / 2, doc.row_count().saturating_sub(1)] {
        let started = Instant::now();
        let page = doc.page(row, 100).expect("page");
        let first = page.rows.first().map(|r| {
            r.cells
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join(" | ")
        });
        println!(
            "행 조회   {:>8.1?}  {row:>9}번부터 100행  {}",
            started.elapsed(),
            first.unwrap_or_default()
        );
    }
    // Again, to show what the cache is worth.
    let started = Instant::now();
    doc.page(doc.row_count() / 2, 100).expect("page");
    println!("같은 조회 {:>8.1?}  (캐시된 행 그룹)", started.elapsed());

    if let Some(query) = query {
        let idle = AtomicBool::new(false);
        let started = Instant::now();
        let found = doc.search(query, false, Interpretation::Literal, &idle).expect("search");
        println!(
            "검색      {:>8.1?}  {query:?} {}건{}",
            started.elapsed(),
            found.hits.len(),
            if found.capped { " (상한)" } else { "" }
        );
    }
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(dead_code)]
fn unused(_: PathBuf) {}
