//! A disposable executable for the Windows self-replacement integration check.
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [mode, new_file] if mode == "replace" => {
            dviewer_lib::update::install::replace_portable(std::path::Path::new(new_file))?;
            println!("replacement complete");
        }
        [mode] if mode == "report" => {
            let exe = std::env::current_exe()?;
            println!("running {} bytes", std::fs::metadata(exe)?.len());
        }
        _ => return Err("usage: update_replace replace <new-file> | report".into()),
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("Windows portable replacement is the only supported target.");
}
