//! Dumps the rendered markdown for a file, so the stylesheet can be checked
//! against real pipeline output rather than hand-written sample HTML.
//!
//!   cargo run --release --example render -- ../fixtures/sample.md out.html

use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        eprintln!("사용법: cargo run --release --example render -- <문서.md> [출력.html]");
        std::process::exit(2);
    };

    let source = std::fs::read_to_string(&input).expect("파일을 읽을 수 없습니다");
    let rendered = dviewer_lib::markdown::render(&source);
    let css = dviewer_lib::highlight::highlight_css();

    let toc = rendered
        .toc
        .iter()
        .map(|e| format!("  h{} #{} {}", e.level, e.id, e.text))
        .collect::<Vec<_>>()
        .join("\n");
    eprintln!("목차 {}개:\n{toc}", rendered.toc.len());

    let page = format!(
        "<style data-theme-css=\"light\">{}</style>\
         <style data-theme-css=\"dark\" media=\"not all\">{}</style>\
         <article class=\"markdown-body\">{}</article>",
        css.light, css.dark, rendered.html
    );

    match args.next() {
        Some(out) => {
            std::fs::write(Path::new(&out), &page).expect("출력 파일을 쓸 수 없습니다");
            eprintln!("{} 바이트를 {out} 에 썼습니다", page.len());
        }
        None => println!("{page}"),
    }
}
