# dviewer

[한국어](README.md) | [English](README.en.md)

A desktop viewer for Markdown, JSON, JSONC, JSONL, YAML, TOML, XML, CSV, TSV, plain text or logs, SQLite, Excel, Parquet, and ZIP. Tauri v2 + Rust backend + Svelte 5 frontend. The interface is available in Korean, English, Japanese and Simplified Chinese.

Fourteen formats, but only **five** ways of reading. Build a screen per format and you maintain fourteen of them — thirteen of which are always behind.

| View | Formats | What it does |
| --- | --- | --- |
| Prose | Markdown | GitHub-grade rendering (tables, checkboxes, footnotes, alert blocks), syntax highlighting with 193 languages (including TypeScript, TSX, TOML and Dockerfile), Mermaid, KaTeX. Whole-document and block copy as source or HTML, with optional inline styles; Mermaid SVG/PNG and display-math TeX/MathML/PNG copy. Raw/rendered toggle; current-heading indication for scrolling and TOC clicks, with automatic TOC scrolling; rendered/source search (toolbar button or Ctrl+F); a page-width dropdown and settings slider; automatic column-width recommendations with fill-width tables by default, column resizing, content fitting, scrolling/fill-width modes, and sticky headers |
| Tree | JSON · JSONC · YAML · TOML · XML | Fold/unfold, key·value·path search, per-depth guide lines, key/value table, path popover, right-click copy. Open arrays and maps in grid subtabs (except XML) |
| Table | CSV · TSV · text/logs · JSONL/NDJSON | Pinned header and row numbers, drag-to-resize columns, per-cell search and copy, header context menu for sorting, filtering one column and fitting its width (filtering only for Parquet). **Logs are read into columns** — time, level, source, message, and `key=value` pairs on request |
| Collection | SQLite · Excel (xlsx) · Parquet | Pick one of the several things a file holds and read it in the same grid. SQLite brings a read-only connection and the statement that created it; xlsx brings its sheets and the formulas behind the values; Parquet brings its schema |
| Archive | ZIP | What the archive holds, as a list. Pick one and it opens in a tab of its own, **as whichever of the four above it is** |

- Handles 500MB-class JSON and CSV, and 200MB-class logs, without loading the whole file into memory. The numbers are in [Verification and performance](doc/verification.md).
- Four ways in — file picker, drag and drop, URL, paste — with multiple documents open in tabs.
- The format is decided by extension (text when nothing else matches); the character encoding (UTF-8 · CP949/EUC-KR · UTF-16, …) is detected from the content. Both can be changed from the toolbar at any time.
- **Logs become columns.** The leading time, level and `[source]` are recognised and everything else stays in one message column. A line that does not start with a timestamp — a stack trace — joins the record above it. `key=value` pairs can be expanded from the toolbar, and the whole thing folds back to one line at any time. ERROR and WARN are tinted, in the level cell only. When the guess is not confident, nothing is split.
- **JSONL is a table.** One line, one row; the keys are the columns. They are read from a sample of the front, and a key a record does not have leaves the cell empty — lines that are not objects are not split at all. It folds back to the original lines at any time, and switching the format to JSON opens the same file as a tree.
- **JSON with comments is read as JSONC.** `.jsonc` walks past `//` and `/* */` comments and trailing commas. `.json` stays strict — but when the strict reading stops somewhere JSONC would have carried on, the error says which switch to reach for.
- **A JSONC comment stays beside the value it explains.** A note written **above** a value and a remark written **after** it on the same line both show dimmed at the end of that row, and in full in the key/value table when the row is selected — their author put them there to be read there. A remark belongs to whatever ended on its line, so `} // that's the section` is the block's.
- **Select nodes by JSONPath** (tree view). `$.items[0].name` and `$..title` pick a place; `$..book[?@.price < 10]` picks **by value**. Slices (`$.items[1:3]`), unions (`$.items[0,-1]`) and indices from the end (`$.items[-1]`) are all there — every selector RFC 9535 defines. Picking a place rather than finding text is why `$..notes` takes 0.06 seconds over a 38-million-node file. The substring path search is still there.
- **Search by regular expression.** Turn on `.*` in the search box and the query is read as a pattern — matched inside one key or value in the tree, one cell in a grid, so `^\d+$` does what it says. Turn it off and the search is the literal one it has always been.
- **Opening a Parquet file does not follow its size.** Only the index at the end is read, and only the row groups the screen reaches are decoded: 0.19ms at 52MB, 0.61ms at 311MB — what grows is the number of row groups, not the bytes. That is why it has none of the ceilings the other formats carry.
- **Excel workbooks open.** Pick a sheet and read it as a table. Columns are named `A`, `B`, `AA` and row 1 is row 1, so the coordinates match the spreadsheet you are checking against. Dates are ISO 8601, and a toggle shows the formulas instead of the values. It is converted rather than mapped, so there is a 64MB ceiling.
- **All fourteen formats open inside an archive and from a URL.** Excel, Parquet and SQLite included: every reader here takes bytes, so none of them has to be a file. A database out of an archive is read as an **image of itself, in place** rather than by querying a file — no copy is made, so the 512MB an entry may unpack to is the only ceiling. The workbook's 64MB is unchanged too.
- **SQLite is read by querying.** The first format that is not a run of bytes. The file is opened read-only, its tables and views are listed, and the chosen one is drawn in the **same grid** the CSVs use. A position is written down every 1,024 rows, so the three-millionth row is one seek away.
- **Archives open as a list to pick from.** Opening a `.zip` shows what is inside it; picking one opens it in a new tab under its own format — less a fourteenth format than a multiplier over the other thirteen. Opening costs only the table of contents at the end of the file, so a gigabyte takes a tenth of a second, and nothing is unpacked but the entry you pick. An archive holding a single document skips the list and opens it. **Names that are not UTF-8 are read too** — every undeclared name in the archive is weighed together to guess the encoding, and the status bar says when that is what happened.
- **gzip files just open.** `access.log.gz` is decompressed and read under its inner name (`access.log`). The raw view shows the decompressed content.
- **A tab keeps the end of its name.** A long name is shortened in the **middle**, not at the end: `2026-09-report-final.json` reads as `2026-09-report-f…inal.json`, so two files that differ only after the part that fits can still be told apart. **Tabs that share a name carry their folder** dimmed beside it (`config.json · alpha`), reaching one level further up when the folder matches too. When there are more tabs than the window holds, the strip scrolls sideways — its ends fade — and a **tab list button** appears.
- Dark/light (auto by default), interface scale, separate interface and content font sizes, and content/code fonts picked from the fonts installed on the system.

- **Open arrays and maps as grid subtabs.** Right-click a nonempty array or object in the tree to open it below its parent main tab. The same location selects its existing subtab. Closing the parent closes its subtabs; closing a subtab selects the parent. A format or encoding change keeps old tables with a muted label and explanatory tooltip, while opening again creates a new generation. Array row numbers start at zero, matching `[n]` paths.
- **Every grid supports row filtering.** Apply a case-insensitive substring across all columns or one selected column. The header context menu offers original, ascending and descending order; single-click cycling remains (Parquet supports filtering only). The column chip describes the input scope; the status describes the successfully applied scope. The chip’s × restores all columns, while Clear filter and `Esc` clear only the filter. Cancelling restores original order. Copied values and row numbers stay original, and search operates on visible rows. Fit column width and double-clicking its edge fit only that column using sampled cells and its actual header.

Session restoration is enabled by default. The main window reopens local files and URLs in tab order, preserving the active document and source/rendered mode, then opens startup requests. Archive entries collapse to their local root file. Pasted text, derived tabs, other windows, scroll positions, and selections are not restored; `--new` and smoke runs neither restore nor save the session.

Installers register supported Markdown, JSON, YAML, TOML, CSV/TSV, Parquet, and SQLite extensions as file-handler candidates; the user chooses the default app. Portable Windows executables do not register associations, and AppImage needs separate desktop integration. Both the macOS DMG and portable ZIP contain an `.app` with file-association declarations.

Open local files reload automatically after a detected save. Continuous writes do not postpone updates until writing stops. Turn this off in settings to receive a change notification instead. Reload closes derived table tabs and node panels; open them again from the new document. URLs, gzip files, and archive entries are not watched.

Text and logs also offer **Table / Source** in the toolbar. Source view fetches only the visible window of lines, with line numbers, Unicode case-insensitive find, forward/backward wrapping and go-to-line. Long lines scroll horizontally while line numbers stay pinned. Table search and source find run independently, so starting one does not cancel the other. Source errors stay in that view so you can return to the table. Markdown source keeps its existing behavior.

CSV, TSV, JSONL, text, log, SQLite, Excel, Parquet, and derived tables fill spare viewport space in proportion to column widths by default, and scroll horizontally when the columns are wider than the viewport. The toolbar’s Table width dropdown applies Fill or Horizontal scrolling to the current tab immediately and saves the default for new tabs. Other open tabs keep their mode; the Settings radios change only the default for new tabs. The dropdown is hidden in Source view. Automatic sizing is capped at 420px in Fill mode and 8000px in Scroll mode. Switching modes recalculates widths and ratios from the current row sample, resetting manual column adjustments. Fit column and Recommend widths use up to 8000px; Reset widths restores automatic sizing for the current mode. Focus a column separator and use the left or right arrow to resize by 8px, or 24px with Shift; Enter and double-click fit its contents. In Fill mode, fitting compensates with the neighboring column while keeping its 64px minimum; content wider than the available width overflows horizontally while the other columns keep their displayed widths. Estimates use 1000-character cell previews from the current row sample. Truncated cells show a dotted underline on the ellipsis and a tooltip for their kind; selecting one adds a limit badge to the status bar. Text cells preview up to 1000 characters; binary previews retain their 16-byte limit, and value copy is capped at 8MiB. Only text and log documents offer Source view in the hint. The text preview character budget doubles when every cell is long. Switching sheets or tables clears the previous widths and fill ratios and sizes columns from a new sample.

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

## Updates

The app quietly checks for a newer stable version five minutes after startup and then every hour. Click the `↑ v…` badge on the start screen or tab bar to see release notes and update options. Installation requires a click. Settings provides **Check for updates automatically** and **Check now**; **Skip this version** hides only that version's automatic notification.

| Distribution | Moving to a newer version |
| --- | --- |
| Windows x64 portable exe | Verify, replace the executable and restart |
| Windows x64 NSIS installation | Verify, run the updater installer and restart |
| Windows MSI | Notification and release-page link |
| macOS app (DMG or portable ZIP) | Notification and release-page link |
| Linux AppImage, deb or rpm | Notification and release-page link |

Both the manifest and update file are authenticated with the embedded public key. Downloads stream directly to disk, are capped at 256MiB, and can be cancelled. Restarting reopens original files and URLs. Pasted documents, derived tabs, window layouts and selections are not restored. Development builds without a public key do not start checking; Settings explains why.

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl O` | Open a file |
| `Ctrl T` | New tab (start screen) |
| `Ctrl W` | Close tab |
| `Ctrl Tab` / `Ctrl Shift Tab` | Cycle main tabs |
| `Ctrl PageDown` / `Ctrl PageUp` | Cycle the active document’s subtabs |
| `Ctrl E` | Toggle Markdown raw/rendered |
| `Enter` / `Shift Enter` | Next / previous search hit |
| `Ctrl F` | Tree search (all / keys / values / paths), table search, rendered/source Markdown search |
| `Esc` in Markdown search | Close search and clear highlights |
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

- Text/log source search queries are limited to 8MiB of UTF-8. Queries exceeding the search engine's compilation limit also report an error.
- A source range refused by the size limit is not requested again until the requested range key changes.

- Text/log source is limited to `u32::MAX` bytes (just under 4GiB) and 50 million lines. A request returns at most 2,000 lines; a range exceeding 8MiB of decoded strings is refused, including a single oversized line. Find uses Unicode case-insensitive literal matching within each line, without regular expressions. Highlighting shows the first 2,000 matches per rendered line. Copy uses browser selection within the currently rendered range only. A final newline keeps its empty line; CRLF is displayed and copied as LF. Existing encoding conversion limits still apply.

- Markdown search is limited to 2,000 matches, 256 characters per regular expression and 1 second of Worker execution. Zero-width matches are excluded. Rendered search excludes markup, app controls, hidden content and duplicate math representations; closed details are included and opened on navigation. Paragraph and cell boundaries are separated by newlines; a match containing only such a newline navigates to adjacent text. Environments without the highlight API show a notice and scroll to matches without highlighting them.

- Self-update is available only for Windows x64 portable exe and NSIS installations. Update files are limited to 256MiB and manifests to 64KiB. NSIS rejects installation when the installer path and document arguments exceed its 1,024 UTF-16-unit command-line buffer, including NUL. Close some documents and retry.

- An array grid samples its first 2,000 elements. If at least 70% are objects, it collects up to 64 columns in first-seen order; otherwise it has one value column. Maps add a `key` column. Empty arrays/maps and XML cannot become grid tabs. A derived grid cannot change format or encoding.
- Sorting preserves integer precision. Text compares the first 128 UTF-8 bytes in byte order; equal prefixes keep original order. Empty cells and SQL NULL stay last in both directions. Text keys have a 256MiB arena limit; exceeding it refuses the sort. The permutation, temporary keys and search inverse map use separate memory. Filtering reads at most 8MiB per cell, the same ceiling as copying.
- Parquet header sorting is disabled: sorted 100-row pages exceeded the 500ms gate on a 311MiB file. Row filtering remains available.

- JSON files up to 4GB (offsets are `u32`).
- A regular expression is matched **inside one value** — one key or value in the tree, one cell in a grid. There is no match spanning nodes or cells; that is what makes `^` and `$` mean anything.
- Pattern search is slower than literal search, because it looks at values one at a time: about 1.5 seconds over a 300MB CSV, against 0.05 for a literal. It can be interrupted.
- Three comments are not shown: one just inside an opening bracket (`[ // this array`), one between a key and its value (`"k": /* x */ 1`), and one on its own line before a closing brace. The first two follow no finished value; the third explains nothing that comes after it, and reading it as the block's own is a guess about what its author meant — better shown to nobody than attached to the wrong thing.
- **JSONPath is RFC 9535, selectors and functions both** — every selector, plus `length()`, `count()`, `match()`, `search()` and `value()` inside a filter. The types are checked *as you type*: `length(@.*)` asks the length of something that is not one node, and is refused before any document is opened. What is left out is comparing whole objects or arrays against each other, which raises an error that names what is missing. A union returns document order with no repeats: the RFC allows `[0,0]` to yield the same node twice, but highlighting one node twice says nothing.
- A JSONPath index or slice near the end **is walked to from the front.** Children sit end to end in the index, so reaching the nth means stepping over the ones before it: `[-1]` or `[1000000:]` costs what scrolling to that row costs — 14ms over a 2.4-million-item array. A slice pays for that walk once however many it selects; a union pays once per part.
- JSONPath is not offered for XML. An XML path is XPath-shaped, so an expression would mean something else there.
- Literal search folds case in the ASCII range only. The regular-expression side follows Unicode, as the crate does.
- Markdown rendering up to 16MB. Larger files do not open.
- Markdown HTML copy also supplies HTML source to plain-text editors; only Source copy supplies Markdown. It uses the sanitised representation before post-processing and defaults to copying without styles. “Include styles in HTML” resolves the current theme into inline values, always setting text color, background color, and body font on the export root from theme tokens; above 4MiB of UTF-8, it announces a fallback to HTML without styles. The choice applies to whole-document and block copy. Rendered Mermaid and display math are copied separately from their block menus. Source copy is disabled for blocks without a verifiable source position, including raw HTML. Copying a single block does not append reference definitions automatically. Language choices last for the open tab and reset on reinterpretation. Re-highlighting also has a 16MiB input limit. Table recommendations measure word widths from at most 20 sampled rows, including the first and last; words outside that sample may still wrap. Source slicing preserves line endings, but the Windows plain-text clipboard may convert LF to CRLF.
- Mermaid SVG is copied as source text. PNG uses a transparent background at twice the displayed size, with a 4096px maximum edge and a notice when reduced. Formula PNG embeds bundled KaTeX fonts. Copying does not download external resources and removes external SVG references; Mermaid may use a system fallback font. Unsupported image clipboards and conversion failures report an error. HTML rendering and fonts in Word or webmail depend on the receiving application.
- Markdown column controls apply to rectangular tables without merged cells or nested tables. Fill width is the default, while saved scrolling preferences are preserved. Scroll mode keeps a visible scrollbar; buttons above each table switch modes and reset widths. Use arrow keys on a column boundary to resize, or double-click / Enter to fit its content. Fill mode preserves a minimum of 3rem per column, so wide tables can still scroll. Fill mode without overflow pins the original header; scroll mode or overflow uses a display-only header copy that follows horizontal scrolling and column widths. This copy is excluded from search and copied content; resizing remains on the original header. Table state lasts for the open tab and resets on format or encoding changes. The default mode in Settings applies to newly opened documents.
- The expand-depth presets go up to 9, which is also the default. Deeper levels are opened node by node.
- Local files up to 64 MiB are copied into memory and their file handles are closed. No mapping remains to block an editor's save, deletion, or rename, and truncation cannot invalidate the copied bytes. **Only files larger than 64 MiB retain mmap**: depending on the editor's sharing mode, saves can be blocked, or external writes can mix values or terminate the process (Unix SIGBUS or Windows in-page error). Watching and reloading remain best effort without a timing guarantee; deletion and rename-out are ignored.
- Remote images in markdown are allowed. `img-src` includes `https:`, so badges and the like render as they would on the web — at the cost of telling the server that hosts them that the document was opened. A deliberate choice in favour of showing documents as they are written.
- SQLite views and WITHOUT ROWID tables have no rowid, so their row positions cannot be written down in advance. The beginning is as fast as anywhere else; the further in you scroll, the longer a screenful takes. Ordinary tables are constant whatever their size.
- Scanning a SQLite database stops at five million rows. A larger table shows its first five million, and the status bar says so.
- A Parquet file with a row group over four million rows does not open. A row group cannot be half-decoded, so a larger one would freeze the window for seconds the moment it is reached. Writers use 100k to 1M, so few files are affected.
- Excel workbooks are converted into memory, so they are read up to 64MB. The values are larger than the file — measured, a 9.7MB workbook becomes 51MB. A formula cell shows the value Excel **last computed** — a file saved without recalculating can show a stale one. Cell display formats are not reproduced (dates are ISO 8601). `.xls`, the older binary format, is not read.
- SQLite is opened read-only. **When it is opened as a file**, a database left with a rollback journal (`-journal`) by an interrupted transaction cannot have that journal replayed read-only, so the first query fails; the program that wrote it has to open it once and settle it first. A database out of an archive or from a URL has no companion files at all, so it is shown as it stood at its last checkpoint — a write-ahead log, had there been one, was not in the archive either.
- Only zip is read. A `tar.gz` has no table of contents, so listing one means decompressing all of it — a different cost model entirely.
- An entry decompresses up to 512MB. The limit is on **what actually comes out**, not on the size the archive claims: that number is whatever whoever wrote the file put there.
- Password-protected entries are marked with a lock and not opened. This viewer neither asks for passwords nor unlocks them.
- Markdown inside an archive does not show its relative images. They live inside the archive, which is not somewhere the webview can reach.
- Archives nest three deep (a document inside `a.zip → b.zip → c.zip`). Each level stays in memory whole for as long as the one below it is open.
- An archive that holds the same name twice shows only the last of them. The table of contents is keyed by name, so the shadowed entry cannot be reached by any number — and drawing two rows that open the same bytes would misrepresent what is there.
- Entries do not appear in recent documents. That list reopens things by file path, and an entry has none.
- The encoding of names inside an archive is a guess. Being wrong costs nothing: entries are identified by their number in the table of contents, not by their name.
- No editing or saving. This is a read-only viewer.
