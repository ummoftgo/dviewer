//! Exercise the same streaming verifier as the app with Tauri CLI signatures.
use dviewer_lib::update::download::verify;
use std::{fs::File, sync::atomic::AtomicBool};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
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
