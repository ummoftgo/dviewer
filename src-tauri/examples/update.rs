//! Exercise the same streaming verifier as the app with Tauri CLI signatures.
use dviewer_lib::update::{
    download::{download, fetch_manifest, verify},
    Flavor, UrlPolicy,
};
use std::{fs::File, sync::atomic::AtomicBool};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 3 && (args[0] == "--check" || args[0] == "--download") {
        let url = args[1].to_str().ok_or("invalid URL")?;
        let policy = UrlPolicy::development(url)?;
        let public = std::fs::read_to_string(&args[2])?;
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let manifest = fetch_manifest(url, &policy, &public, &cancel)?;
        let checked = started.elapsed().as_secs_f64() * 1000.0;
        let bytes = if args[0] == "--download" {
            let asset = manifest
                .asset(Flavor::PortableExe, "windows", "x86_64")
                .ok_or("missing portable")?;
            download(asset, &policy, &public, &cancel, |_, _| {})?.size()?
        } else {
            0
        };
        println!(
            "{}",
            serde_json::json!({"manifestMs":checked,"totalMs":started.elapsed().as_secs_f64()*1000.0,"bytes":bytes})
        );
        // Let an external sampler read the process high-water mark even when
        // a loopback manifest finishes between two samples. Excluded above.
        std::thread::sleep(std::time::Duration::from_millis(100));
        return Ok(());
    }
    if args.len() != 3 {
        return Err("usage: update <file> <public-key-file> <signature-file>".into());
    }
    let public = std::fs::read_to_string(&args[1])?;
    let signature = std::fs::read_to_string(&args[2])?;
    let mut file = File::open(&args[0])?;
    verify(&mut file, &public, &signature, &AtomicBool::new(false))?;
    println!("verified {} bytes", file.metadata()?.len());
    Ok(())
}
