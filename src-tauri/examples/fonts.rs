//! Times the cold system-font scan — the one cost the settings panel pays.
//!
//!   cargo run --release --example fonts
//!
//! Must be a separate process per measurement: `fonts::families()` caches in a
//! OnceLock, so a second call in the same process measures nothing.

use std::time::Instant;

fn main() {
    let started = Instant::now();
    let families = dviewer_lib::fonts::families();
    let elapsed = started.elapsed();

    let monospace = families.iter().filter(|f| f.monospace).count();
    let payload: usize = families.iter().map(|f| f.name.len() + 24).sum();

    println!(
        "콜드 스캔 {:.0}ms — {}개 계열 (고정폭 {}개), 직렬화 약 {:.1}KB",
        elapsed.as_secs_f64() * 1000.0,
        families.len(),
        monospace,
        payload as f64 / 1024.0
    );

    let started = Instant::now();
    let _ = dviewer_lib::fonts::families();
    println!("두 번째 호출 {:.3}ms", started.elapsed().as_secs_f64() * 1000.0);

    // The cost scales with faces read, not families shown, so report the rate a
    // font-heavy machine would be extrapolated from.
    let started = Instant::now();
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let faces = db.len();
    let per_face = started.elapsed().as_secs_f64() * 1_000_000.0 / faces as f64;
    println!(
        "얼굴 {faces}개, 얼굴당 {per_face:.0}µs → 2000개 환경이면 약 {:.0}ms",
        per_face * 2000.0 / 1000.0
    );
}
