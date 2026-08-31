# dviewer

[한국어](README.md) | [English](README.en.md)

A desktop viewer for Markdown, JSON, JSONC, JSONL, YAML, TOML, XML, CSV, TSV, plain text or logs, SQLite, Excel, Parquet, and ZIP. Tauri v2 + Rust backend + Svelte 5 frontend. The interface is available in Korean, English, Japanese and Simplified Chinese.

Fourteen formats, but only **five** ways of reading. Build a screen per format and you maintain fourteen of them — thirteen of which are always behind.

| View | Formats | What it does |
| --- | --- | --- |
| Prose | Markdown | GitHub-grade rendering (tables, checkboxes, footnotes, alert blocks), syntax highlighting, Mermaid, KaTeX. Raw/rendered toggle |
| Tree | JSON · JSONC · YAML · TOML · XML | Fold/unfold, key·value·path search, per-depth guide lines, key/value table, path popover, right-click copy |
| Table | CSV · TSV · text/logs · JSONL/NDJSON | Pinned header and row numbers, drag-to-resize columns, per-cell search and copy. **Logs are read into columns** — time, level, source, message, and `key=value` pairs on request |
| Collection | SQLite · Excel (xlsx) · Parquet | Pick one of the several things a file holds and read it in the same grid. SQLite brings a read-only connection and the statement that created it; xlsx brings its sheets and the formulas behind the values; Parquet brings its schema |
| Archive | ZIP | What the archive holds, as a list. Pick one and it opens in a tab of its own, **as whichever of the four above it is** — the only view that does not end on screen but leads to another document |

- Handles 500MB-class JSON and CSV, and 200MB-class logs, without loading the whole file into memory. The numbers are in [Verification and performance](doc/verification.md).
- Four ways in — file picker, drag and drop, URL, paste — with multiple documents open in tabs.
- The format is decided by extension (text when nothing else matches); the character encoding (UTF-8 · CP949/EUC-KR · UTF-16, …) is detected from the content. Both can be changed from the toolbar at any time.
- **Logs become columns.** The leading time, level and `[source]` are recognised and everything else stays in one message column. A line that does not start with a timestamp — a stack trace — joins the record above it. `key=value` pairs can be expanded from the toolbar, and the whole thing folds back to one line at any time. ERROR and WARN are tinted, in the level cell only. When the guess is not confident, nothing is split.
- **JSONL is a table.** One line, one row; the keys are the columns. They are read from a sample of the front, and a key a record does not have leaves the cell empty — lines that are not objects are not split at all. It folds back to the original lines at any time, and switching the format to JSON opens the same file as a tree.
- **JSON with comments is read as JSONC.** `.jsonc` walks past `//` and `/* */` comments and trailing commas. `.json` stays strict — but when the strict reading stops somewhere JSONC would have carried on, the error says which switch to reach for.
- **A JSONC comment stays beside the value it explains.** A note written above a value is shown dimmed at the end of that row, and in full in the key/value table when the row is selected — its author put it there to be read there. A remark after a value on the same line belongs to that value, so it is not attached to the next one.
- **Select nodes by JSONPath** (tree view). Written as `$.items[0].name` or `$..title` — picking a place rather than finding text, which is why it takes 0.07 seconds over a 38-million-node file. The substring path search is still there.
- **Search by regular expression.** Turn on `.*` in the search box and the query is read as a pattern — matched inside one key or value in the tree, one cell in a grid, so `^\d+$` does what it says. Turn it off and the search is the literal one it has always been.
- **Opening a Parquet file does not follow its size.** Only the index at the end is read, and only the row groups the screen reaches are decoded: 0.19ms at 52MB, 0.61ms at 311MB — what grows is the number of row groups, not the bytes. That is why it has none of the ceilings the other formats carry.
- **Excel workbooks open.** Pick a sheet and read it as a table. Columns are named `A`, `B`, `AA` and row 1 is row 1, so the coordinates match the spreadsheet you are checking against. Dates are ISO 8601, and a toggle shows the formulas instead of the values. It is converted rather than mapped, so there is a 64MB ceiling.
- **SQLite is read by querying.** The first format that is not a run of bytes. The file is opened read-only, its tables and views are listed, and the chosen one is drawn in the **same grid** the CSVs use. A position is written down every 1,024 rows, so the three-millionth row is one seek away.
- **Archives open as a list to pick from.** Opening a `.zip` shows what is inside it; picking one opens it in a new tab under its own format — less a fourteenth format than a multiplier over the other thirteen. Opening costs only the table of contents at the end of the file, so a gigabyte takes a tenth of a second, and nothing is unpacked but the entry you pick. An archive holding a single document skips the list and opens it. **Names that are not UTF-8 are read too** — every undeclared name in the archive is weighed together to guess the encoding, and the status bar says when that is what happened.
- **gzip files just open.** `access.log.gz` is decompressed and read under its inner name (`access.log`). The raw view shows the decompressed content.
- Dark/light (auto by default), interface scale, separate interface and content font sizes, and content/code fonts picked from the fonts installed on the system.

## Requirements

- Node.js 20 or later (developed on 24), npm
- Rust 1.88 or later — the floor set by calamine (developed on 1.94)
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
- A regular expression is matched **inside one value** — one key or value in the tree, one cell in a grid. There is no match spanning nodes or cells; that is what makes `^` and `$` mean anything.
- Pattern search is slower than literal search, because it looks at values one at a time: about 1.5 seconds over a 300MB CSV, against 0.05 for a literal. It can be interrupted.
- Only a comment that starts its own line becomes a note. A remark after a value on the same line, or one before a closing brace, is not shown — attaching either to what follows would explain the wrong thing.
- JSONPath is a subset — `$`, `.key`, `["key"]`, `[n]`, `[*]` and `..`. Filter expressions (`?()`), slices (`[1:3]`) and unions (`[0,2]`) are not there, and using one is an error that names what is missing.
- JSONPath is not offered for XML. An XML path is XPath-shaped, so an expression would mean something else there.
- Literal search folds case in the ASCII range only. The regular-expression side follows Unicode, as the crate does.
- Markdown rendering up to 16MB. Larger files do not open.
- The expand-depth presets go up to 9, which is also the default. Deeper levels are opened node by node.
- Files are mmap-ed, so a file changed externally while open needs to be reopened. Edited content only mixes old and new bytes, but **truncating the file kills the process outright on Linux and macOS** (SIGBUS). Windows is unaffected: the OS refuses to shrink a file that has a mapping open.
- Remote images in markdown are allowed. `img-src` includes `https:`, so badges and the like render as they would on the web — at the cost of telling the server that hosts them that the document was opened. A deliberate choice in favour of showing documents as they are written.
- SQLite views and WITHOUT ROWID tables have no rowid, so their row positions cannot be written down in advance. The beginning is as fast as anywhere else; the further in you scroll, the longer a screenful takes. Ordinary tables are constant whatever their size.
- Scanning a SQLite database stops at five million rows. A larger table shows its first five million, and the status bar says so.
- SQLite cannot be opened from a URL. A database is read by querying a file, so it has to be downloaded and then opened.
- A Parquet file with a row group over four million rows does not open. A row group cannot be half-decoded, so a larger one would freeze the window for seconds the moment it is reached. Writers use 100k to 1M, so few files are affected.
- Excel workbooks are converted into memory, so they are read up to 64MB. The values are larger than the file — measured, a 9.7MB workbook becomes 51MB. A formula cell shows the value Excel **last computed** — a file saved without recalculating can show a stale one. Cell display formats are not reproduced (dates are ISO 8601). `.xls`, the older binary format, is not read.
- SQLite is opened read-only. A database left with a rollback journal (`-journal`) by an interrupted transaction cannot have that journal replayed read-only, so the first query fails. The program that wrote it has to open it once and settle it first.
- Only zip is read. A `tar.gz` has no table of contents, so listing one means decompressing all of it — a different cost model entirely.
- An entry decompresses up to 512MB. The limit is on **what actually comes out**, not on the size the archive claims: that number is whatever whoever wrote the file put there.
- Password-protected entries are marked with a lock and not opened. This viewer neither asks for passwords nor unlocks them.
- SQLite, Excel and Parquet entries inside an archive are not opened. All three are read through a library that opens a path, and something unpacked from an archive has none. Extract it first and open that file.
- Markdown inside an archive does not show its relative images. They live inside the archive, which is not somewhere the webview can reach.
- Archives nest three deep (a document inside `a.zip → b.zip → c.zip`). Each level stays in memory whole for as long as the one below it is open.
- An archive that holds the same name twice shows only the last of them. The table of contents is keyed by name, so the shadowed entry cannot be reached by any number — and drawing two rows that open the same bytes would misrepresent what is there.
- Entries do not appear in recent documents. That list reopens things by file path, and an entry has none.
- The encoding of names inside an archive is a guess. Being wrong costs nothing: entries are identified by their number in the table of contents, not by their name.
- No editing or saving. This is a read-only viewer.
