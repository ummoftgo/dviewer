# dviewer

[한국어](README.md) | [English](README.en.md)

A desktop viewer for Markdown, JSON, YAML, TOML, XML, CSV, TSV, plain text or logs, and SQLite. Tauri v2 + Rust backend + Svelte 5 frontend. The interface is available in Korean, English, Japanese and Simplified Chinese.

Nine formats, but only **four** ways of reading. Build a screen per format and you maintain nine of them — eight of which are always behind.

| View | Formats | What it does |
| --- | --- | --- |
| Prose | Markdown | GitHub-grade rendering (tables, checkboxes, footnotes, alert blocks), syntax highlighting, Mermaid, KaTeX. Raw/rendered toggle |
| Tree | JSON · JSONL/NDJSON · YAML · TOML · XML | Fold/unfold, key·value·path search, per-depth guide lines, key/value table, path popover, right-click copy |
| Table | CSV · TSV · text/logs | Pinned header and row numbers, drag-to-resize columns, per-cell search and copy. **Logs are read into columns** — time, level, source, message, and `key=value` pairs on request |
| Database | SQLite | Pick a table or a view and read it in the same grid. Read-only connection, the statement that created it, search over values. NULL is drawn as the different thing it is |

- Handles 500MB-class JSON and CSV, and 200MB-class logs, without loading the whole file into memory. The numbers are in [Verification and performance](doc/verification.md).
- Four ways in — file picker, drag and drop, URL, paste — with multiple documents open in tabs.
- The format is decided by extension (text when nothing else matches); the character encoding (UTF-8 · CP949/EUC-KR · UTF-16, …) is detected from the content. Both can be changed from the toolbar at any time.
- **Logs become columns.** The leading time, level and `[source]` are recognised and everything else stays in one message column. A line that does not start with a timestamp — a stack trace — joins the record above it. `key=value` pairs can be expanded from the toolbar, and the whole thing folds back to one line at any time. ERROR and WARN are tinted, in the level cell only. When the guess is not confident, nothing is split.
- **SQLite is read by querying.** The first format that is not a run of bytes. The file is opened read-only, its tables and views are listed, and the chosen one is drawn in the **same grid** the CSVs use. A position is written down every 1,024 rows, so the three-millionth row is one seek away.
- **gzip files just open.** `access.log.gz` is decompressed and read under its inner name (`access.log`). The raw view shows the decompressed content.
- Dark/light (auto by default), interface scale, separate interface and content font sizes, and content/code fonts picked from the fonts installed on the system.

## Requirements

- Node.js 20 or later (developed on 24), npm
- Rust 1.85 or later — the floor set by comrak and ureq (developed on 1.94)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) — WebView2 and the MSVC build tools on Windows, `webkit2gtk` on Linux

## Running

```bash
npm install && npm run tauri dev
```

To produce a release build:

```bash
npm run tauri build
```

The executable lands in `src-tauri/target/release/`, installers in `bundle/msi` and `bundle/nsis`.

## Command line

```bash
dviewer report.md                      # positional argument
dviewer --open="C:/data/big-file.json"
dviewer --open-url=https://example.com/data.json
dviewer --new --open=a.csv             # a new window instead of a tab
```

A second invocation does not draw a window: it hands its arguments to the process already running, and the file arrives **as a tab in the current window**. Pass `--new` to get another window. How this works is covered in [Design and structure](doc/architecture.md#명령줄-그리고-이미-열려-있는-창).

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl O` | Open a file |
| `Ctrl T` | New tab (start screen) |
| `Ctrl W` | Close tab |
| `Ctrl Tab` / `Ctrl Shift Tab` | Switch tabs |
| `Ctrl E` | Toggle Markdown raw/rendered |
| `Enter` / `Shift Enter` | Next / previous search hit |
| `Ctrl F` | Tree search (all / keys / values / paths), table search |
| `Ctrl +` `Ctrl -` `Ctrl 0` | Interface scale |
| `←` `→` `Enter` in the tree | Fold / unfold |
| Clicking `{ 3 }` `[ 3 ]` `< 3 >` in the tree | Fold / unfold |
| `←` `↑` `↓` `→` `PgUp` `PgDn` `Home` `End` in the table | Move between cells |
| `Ctrl C` in tree and table | Copy the selected value |
| Right-click in the tree | Copy path / key / value, detach to a new window |
| Clicking a truncated value in the key/value table · `Enter` | Expand the full value in place |
| Right-click in the table | Copy value / row / column name |
| `Esc` in a detached window | Back to the previous position |
| Mouse back / forward buttons | Previous / next selected node |

## Documentation

The technical documentation lives in `doc/` (Korean).

| Document | Contents |
| --- | --- |
| [Design and structure](doc/architecture.md) | Directory layout, the tree engine and per-format design, encoding, i18n, virtual scrolling, security boundary |
| [Verification and performance](doc/verification.md) | Tests, benchmark numbers and how to reproduce them, fixtures |
| [Build and release](doc/release.md) | CI setup, per-OS artifacts, signing constraints, repository rules |
| [Dependencies](doc/dependencies.md) | Why each package was chosen, and vulnerability checks |

## Known limits

- JSON files up to 4GB (offsets are `u32`).
- Search is literal; case-insensitivity works in the ASCII range only. No regular expressions or JSONPath expressions yet — path search is a substring match against path strings like `$.items[3].name`.
- Markdown rendering up to 16MB. Larger files do not open.
- The expand-depth presets go up to 9, which is also the default. Deeper levels are opened node by node.
- Files are mmap-ed, so a file changed externally while open needs to be reopened. Edited content only mixes old and new bytes, but **truncating the file kills the process outright on Linux and macOS** (SIGBUS). Windows is unaffected: the OS refuses to shrink a file that has a mapping open.
- Remote images in markdown are allowed. `img-src` includes `https:`, so badges and the like render as they would on the web — at the cost of telling the server that hosts them that the document was opened. A deliberate choice in favour of showing documents as they are written.
- SQLite views and WITHOUT ROWID tables have no rowid, so their row positions cannot be written down in advance. The beginning is as fast as anywhere else; the further in you scroll, the longer a screenful takes. Ordinary tables are constant whatever their size.
- Scanning a SQLite database stops at five million rows. A larger table shows its first five million, and the status bar says so.
- SQLite cannot be opened from a URL. A database is read by querying a file, so it has to be downloaded and then opened.
- SQLite is opened read-only. A database left with a rollback journal (`-journal`) by an interrupted transaction cannot have that journal replayed read-only, so the first query fails. The program that wrote it has to open it once and settle it first.
- No editing or saving. This is a read-only viewer.
