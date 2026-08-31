//! What reading an archive's contents costs, with no window involved.
//!
//!   cargo run --release --example archive -- ../fixtures/archive.zip
//!
//! Prints how long the central directory took and what the list came out as —
//! the two things the design claims: that opening an archive is a footer read
//! rather than an unpacking, and that names with no declared encoding are
//! guessed rather than shown as CP437 line noise.

use std::sync::Arc;
use std::time::Instant;

use dviewer_lib::archive::ArchiveDoc;
use dviewer_lib::bytes::DocBytes;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: archive <path.zip> [entry-index]");
    let wanted: Option<u32> = args.next().and_then(|n| n.parse().ok());

    let bytes = Arc::new(DocBytes::map_file(std::path::Path::new(&path)).expect("map"));
    let file_size = bytes.len();

    let started = Instant::now();
    let doc = ArchiveDoc::open(bytes).expect("open");
    let listed = started.elapsed();

    let listing = doc.listing();
    println!(
        "{} MB file, {} entries listed in {listed:>8.0?}",
        file_size / 1024 / 1024,
        listing.entries.len()
    );
    if listing.hidden > 0 {
        println!("{} entries past the list's ceiling", listing.hidden);
    }
    println!(
        "names read as {}{}",
        listing.name_encoding,
        if listing.names_guessed { " (a guess)" } else { "" }
    );

    for entry in listing.entries.iter().take(40) {
        println!(
            "  {:>5}  {:>10}  {:<8?} {}{}",
            entry.index,
            entry.size,
            entry.kind,
            entry.name,
            if entry.encrypted { "  [locked]" } else { "" }
        );
    }
    if listing.entries.len() > 40 {
        println!("  … and {} more", listing.entries.len() - 40);
    }

    // Unpacking one entry is the other half of the claim: the ceiling is on
    // what comes out, so this is where a bomb would be caught.
    if let Some(index) = wanted {
        let started = Instant::now();
        match doc.read_entry(index) {
            Ok(body) => println!(
                "\nentry {index}: {} bytes in {:>8.0?}",
                body.len(),
                started.elapsed()
            ),
            Err(error) => println!("\nentry {index}: {error}"),
        }
    }
}
