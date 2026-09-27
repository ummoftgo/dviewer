/**
 * Writes dist/THIRD-PARTY-NOTICES.md, which the app opens from Settings → About.
 *
 *   node scripts/notices.mjs          (npm run build runs it last)
 *
 * The parts: dviewer's own LICENSE; notices/static.md for what no package list
 * describes (KaTeX fonts, zstd, SQLite, the WebView2 loader); the licence files
 * PDF.js ships in dist/pdfjs; cargo-about for the Rust crates; and the npm
 * packages the Vite plugin found in the bundle.
 *
 * cargo-about is a separate tool (`cargo install --locked cargo-about`, or the
 * release binary). Without it a local build still succeeds with the Rust part
 * marked as missing, so nobody is stopped from working; with
 * DVIEWER_NOTICES=required, which CI sets for every build it ships or smokes,
 * a missing or failing cargo-about fails the build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assembleNotices, npmSection } from "../src/lib/notices.ts";

const required = process.env.DVIEWER_NOTICES === "required";
const cache = "node_modules/.cache/dviewer-notices";
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function rust() {
  mkdirSync(cache, { recursive: true });
  const out = path.join(cache, "rust.md");
  // -o rather than stdout: cargo-about refuses redirected output in PowerShell.
  const run = spawnSync("cargo", ["about", "generate", "--manifest-path", "src-tauri/Cargo.toml", "-c", "notices/about.toml",
    "--features", "custom-protocol", "-o", out, "notices/about.hbs"], { stdio: ["ignore", "inherit", "inherit"] });
  if (run.status === 0) return read(out);
  const why = run.error ? `cargo-about could not be started (${run.error.code})` : `cargo-about exited with ${run.status}`;
  if (required) {
    console.error(`THIRD-PARTY-NOTICES: ${why}, and DVIEWER_NOTICES=required.`);
    process.exit(1);
  }
  console.warn(`THIRD-PARTY-NOTICES: ${why}; the Rust crates are left out of this build's notices.`);
  return `## Rust crates\n\nNot generated in this build: ${why}.\n`;
}

function npm() {
  const list = path.join(cache, "npm.json");
  if (!existsSync(list)) throw new Error(`${list} is missing: run vite build first (npm run build does).`);
  const packages = JSON.parse(read(list)).map(({ dir }) => {
    const manifest = JSON.parse(read(path.join(dir, "package.json")));
    const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
    const files = readdirSync(dir).filter((name) => /^(licen[cs]e|notice|copying)/i.test(name)).sort()
      .map((name) => ({ name, text: read(path.join(dir, name)) }));
    const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type
      ?? (files.length ? "see the licence file" : "unstated");
    return { name: manifest.name, version: manifest.version, license, author, files };
  });
  return npmSection(packages);
}

function pdfjs() {
  const root = "dist/pdfjs";
  const version = read(path.join(root, "build/pdf.mjs")).match(/pdfjsVersion = ([\d.]+)/)?.[1] ?? "unknown";
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^licen[cs]e/i.test(entry.name)) files.push({ name: path.relative(root, full).split(path.sep).join("/"), text: read(full) });
    }
  };
  walk(root);
  if (!files.length) throw new Error(`${root} has no licence files: run scripts/prepare-pdfjs.mjs first.`);
  return { version, files };
}

const version = JSON.parse(read("package.json")).version;
const notices = assembleNotices({
  version, license: read("LICENSE"), staticPart: read("notices/static.md"), pdfjs: pdfjs(), rust: rust(), npm: npm(),
});
writeFileSync("dist/THIRD-PARTY-NOTICES.md", notices);
console.log(`THIRD-PARTY-NOTICES.md: ${Math.round(Buffer.byteLength(notices) / 1024)} KiB`);
