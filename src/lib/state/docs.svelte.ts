import * as ipc from "../ipc";
import { viewOf } from "../ipc";
import { t } from "../i18n";
import type {
  DocKind,
  DocMeta,
  DocView,
  TreeStats,
  SearchHit,
  SearchScope,
  SearchSummary,
  TableHit,
  TableStats,
  TocEntry,
} from "../ipc";
import { forgetDoc } from "../components/tree/actions";
import { NodeHistory } from "./history.svelte";
import { recents } from "./recents.svelte";

export type ViewMode = "rendered" | "raw";

class SearchState {
  /**
   * Which search the arriving hits belong to.
   *
   * Results stream back as events, and an event carries no proof of what asked
   * for it: cancelling a search does not unsend the batches already in flight.
   * Without this, the tail of a query the reader has replaced lands in front of
   * the hits for the one they are waiting on.
   */
  seq = $state(0);
  query = $state("");
  caseSensitive = $state(false);
  scope = $state<SearchScope>("all");
  running = $state(false);
  hits = $state<SearchHit[]>([]);
  summary = $state<SearchSummary | null>(null);
  /** Index into `hits` of the match the view is parked on. */
  current = $state(-1);
  error = $state<string | null>(null);

  /** Begin a search, and return the generation its events must carry. */
  begin(): number {
    this.reset();
    this.running = true;
    return this.seq;
  }

  reset() {
    // Bumped here rather than only in `begin`, so clearing the box while a
    // search is in flight also disowns whatever it is about to send back.
    this.seq += 1;
    this.running = false;
    this.hits = [];
    this.summary = null;
    this.current = -1;
    this.error = null;
  }
}

/** Search state for the grid. Simpler than the tree's: the backend answers in
 *  one call rather than streaming, because the hit list is capped low enough to
 *  cross the IPC boundary whole. */
class TableSearchState {
  /**
   * Which search the arriving result belongs to.
   *
   * The grid's search is one call rather than a stream, but starting a second
   * one cancels the first — so the first comes back as a cancellation, and
   * without this it would blank the hits and show an error while the search
   * the reader is actually waiting for is still running.
   */
  seq = $state(0);
  query = $state("");
  caseSensitive = $state(false);
  running = $state(false);
  hits = $state<TableHit[]>([]);
  /** Index into `hits` of the cell the grid is parked on. */
  current = $state(-1);
  capped = $state(false);
  /** True once a search has run, so "no matches" is only shown after one has. */
  searched = $state(false);
  error = $state<string | null>(null);

  /** Begin a search, and return the generation its result must carry. */
  begin(): number {
    this.reset();
    this.running = true;
    this.searched = true;
    return this.seq;
  }

  reset() {
    this.seq += 1;
    this.running = false;
    this.hits = [];
    this.current = -1;
    this.capped = false;
    this.searched = false;
    this.error = null;
  }
}

let nextKey = 0;

/** One open document: its metadata plus everything the views need to resume. */
export class DocTab {
  /**
   * Stable across the placeholder → loaded swap, unlike `meta.id`, so the tab
   * strip does not tear itself down when the real document arrives.
   */
  readonly key = ++nextKey;
  /**
   * `blank` is a tab with no document yet — it shows the start pane, so the
   * new-tab button offers every way in (a file, a URL, pasted text, something
   * opened before) rather than only the file dialog.
   */
  status = $state<"blank" | "opening" | "ready">("ready");
  meta = $state<DocMeta>()!;
  mode = $state<ViewMode>("rendered");
  error = $state<string | null>(null);
  busy = $state(false);

  // Markdown
  html = $state<string | null>(null);
  toc = $state<TocEntry[]>([]);
  raw = $state<string | null>(null);
  /** Preserved per tab so switching back does not lose the reader's place. */
  scrollTop = $state(0);
  rawScrollTop = $state(0);

  // Tree (JSON, YAML, TOML, XML)
  treeStats = $state<TreeStats | null>(null);
  /** Selected node, kept for the inspector even while it scrolls out of view. */
  selectedNode = $state<number | null>(null);
  /** The nodes this tab has shown, so the mouse's side buttons have somewhere
   *  to go. Written by the tree view as the selection moves. */
  readonly history = new NodeHistory();
  showInspector = $state(true);
  indexing = $state<{ done: number; total: number } | null>(null);
  treeScrollTop = $state(0);
  /** Row the view should jump to; cleared by the view once honoured. */
  pendingRow = $state<number | null>(null);
  search = new SearchState();

  // Table (CSV, TSV)
  tableStats = $state<TableStats | null>(null);
  header = $state<string[]>([]);
  /** Pixel width per column, resizable by dragging a header edge. */
  columnWidths = $state<number[]>([]);
  selectedCell = $state<{ row: number; column: number } | null>(null);
  tableScrollTop = $state(0);
  /** Cell the grid should jump to; cleared by the view once honoured. */
  pendingCell = $state<{ row: number; column: number } | null>(null);
  tableSearch = new TableSearchState();

  constructor(meta: DocMeta) {
    this.meta = meta;
  }

  get id() {
    return this.meta.id;
  }

  get kind(): DocKind {
    return this.meta.kind;
  }

  /** Which of the three views renders this tab. */
  get view(): DocView {
    return this.meta.view;
  }

  get subtitle(): string {
    if (this.status === "blank") return "";
    const source = this.meta.source;
    if (source.type === "file") return source.path;
    if (source.type === "url") return source.url;
    return t("doc.pastedSource");
  }

  /** Drop derived state so the tab reloads from scratch on the next view. */
  invalidate() {
    this.html = null;
    this.toc = [];
    this.raw = null;
    this.treeStats = null;
    this.indexing = null;
    this.history.reset();
    // Node ids do not survive re-indexing. A selection kept across one names
    // whichever node happens to have taken that number — and the inspector,
    // the path popover and the copied path would all follow it.
    this.selectedNode = null;
    this.pendingRow = null;
    this.error = null;
    this.search.reset();
    this.tableStats = null;
    this.header = [];
    this.columnWidths = [];
    this.selectedCell = null;
    this.pendingCell = null;
    this.tableSearch.reset();
  }
}

class Workspace {
  tabs = $state<DocTab[]>([]);
  activeId = $state<number | null>(null);
  /** Errors that belong to no tab, e.g. a file that failed to open at all. */
  notice = $state<string | null>(null);
  opening = $state(false);

  get active(): DocTab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  activate(id: number) {
    this.activeId = id;
  }

  /** Re-focus an already-open file instead of loading a second copy. */
  private findByPath(path: string): DocTab | null {
    return (
      this.tabs.find((tab) => tab.meta.source.type === "file" && tab.meta.source.path === path) ??
      null
    );
  }

  /**
   * A tab with nothing in it yet.
   *
   * One is enough: a second empty tab would look identical to the first and
   * behave identically too, so an existing one is raised instead.
   */
  newTab(): DocTab {
    const existing = this.tabs.find((tab) => tab.status === "blank");
    if (existing) {
      this.activeId = existing.id;
      return existing;
    }
    const tab = new DocTab(placeholder(""));
    tab.status = "blank";
    this.tabs = [...this.tabs, tab];
    this.activeId = tab.id;
    this.notice = null;
    return tab;
  }

  /** Everything a launch asked for, in the order it was asked. */
  async openLaunch(request: { files: string[]; urls: string[] }) {
    for (const path of request.files) await this.openPath(path);
    for (const url of request.urls) await this.openUrl(url);
  }

  async openPath(path: string) {
    const existing = this.findByPath(path);
    if (existing) {
      this.activeId = existing.id;
      return existing;
    }
    return this.run(placeholder(path), () => ipc.openPath(path), path);
  }

  async openUrl(url: string) {
    return this.run(placeholder(url, { type: "url", url }), () => ipc.openUrl(url));
  }

  async openText(content: string, title?: string, kind?: DocKind) {
    const meta = placeholder(title ?? t("doc.pasted"), { type: "text" });
    if (kind) {
      meta.kind = kind;
      meta.view = viewOf(kind);
    }
    return this.run(meta, () => ipc.openText(content, title ?? t("doc.pasted"), kind));
  }

  /**
   * Show the tab before the backend answers.
   *
   * Opening touches the disk, so the honest sequence is "tab appears, then it
   * fills in" — waiting for the metadata first leaves a gap with no feedback at
   * all, which reads as the app having hung.
   */
  private async run(
    meta: DocMeta,
    load: () => Promise<DocMeta>,
    failedPath?: string,
  ): Promise<DocTab | null> {
    // Opening from a blank tab fills that tab in rather than adding another —
    // the blank one is where the reader started, so it is where they expect
    // the document to land.
    const blank = this.tabs.find((tab) => tab.status === "blank" && tab.id === this.activeId);
    const tab = blank ?? new DocTab(meta);
    if (blank) blank.meta = meta;
    else this.tabs = [...this.tabs, tab];
    tab.status = "opening";
    this.activeId = tab.id;
    this.notice = null;
    this.opening = true;

    try {
      const loaded = await load();
      // The reader can close a tab while it is still opening — a 500MB file
      // spends seconds here. The tab goes at once, but the document it was
      // waiting for arrives afterwards with nobody left to close it, and its
      // mmap and index would then be held until the app exits.
      if (!this.tabs.includes(tab)) {
        void ipc.closeDoc(loaded.id).catch(() => {});
        return null;
      }
      tab.meta = loaded;
      tab.status = "ready";
      if (tab.meta.source.type === "file") {
        recents.add({ path: tab.meta.source.path, title: tab.meta.title, kind: tab.meta.kind });
      }
      // The id changed from the placeholder's, so follow it.
      if (this.activeId === meta.id) this.activeId = tab.id;
      return tab;
    } catch (err) {
      // A tab that was blank goes back to blank; one created for this document
      // has nothing left to show.
      if (blank) {
        blank.status = "blank";
        blank.meta = placeholder("");
        this.activeId = blank.id;
      } else {
        this.tabs = this.tabs.filter((t) => t !== tab);
        if (this.activeId === meta.id) this.activeId = this.tabs.at(-1)?.id ?? null;
      }
      this.notice = ipc.errorMessage(err);
      // A recent entry pointing at a file that no longer opens is just noise.
      if (failedPath) recents.remove(failedPath);
      return null;
    } finally {
      this.opening = false;
    }
  }

  async close(id: number) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = next?.id ?? null;
    }
    forgetDoc(id);
    // A blank tab has no document behind it, and a placeholder id is one the
    // backend has never heard of.
    if (id <= 0) return;
    try {
      await ipc.closeDoc(id);
    } catch (err) {
      console.warn("[dviewer] close failed:", err);
    }
  }

  /** Force a document to be read as some other format. */
  async setKind(id: number, kind: DocKind) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.kind === kind) return;
    try {
      const meta = await ipc.setDocKind(id, kind);
      // The document id survives re-indexing but the node ids under it do not,
      // and the path cache is keyed by both — so it has to go with them.
      forgetDoc(id);
      tab.invalidate();
      tab.meta = meta;
    } catch (err) {
      tab.error = ipc.errorMessage(err);
    }
  }

  /** Re-read a document as a different character encoding. */
  async setEncoding(id: number, encodingName: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.meta.encoding.name === encodingName) return;
    try {
      const meta = await ipc.setDocEncoding(id, encodingName);
      // Byte offsets do not survive a change of encoding, so every index built
      // from the old reading has to go with it — the cached paths included.
      forgetDoc(id);
      tab.invalidate();
      tab.meta = meta;
    } catch (err) {
      tab.error = ipc.errorMessage(err);
    }
  }

  tab(id: number): DocTab | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }
}

/**
 * Stand-in metadata for a tab that exists on screen but not yet in the backend.
 * The negative id cannot collide with a real one, which is what stops views
 * from calling commands against a document that does not exist.
 */
let nextPlaceholderId = 0;

/**
 * A guess at the format from the file name, so the placeholder tab shows the
 * right kind of "opening" state. The backend detects it properly and its answer
 * replaces this a moment later, so being wrong here costs nothing.
 */
const EXTENSIONS: [RegExp, DocKind][] = [
  [/\.(json|jsonc|jsonl|ndjson|geojson|har|ipynb)$/i, "json"],
  [/\.ya?ml$/i, "yaml"],
  [/\.toml$/i, "toml"],
  [/\.(xml|xhtml|svg|rss|atom|xsd|xslt?|plist|kml|gpx|opml|wsdl|pom)$/i, "xml"],
  [/\.csv$/i, "csv"],
  [/\.(tsv|tab)$/i, "tsv"],
];

function guessKind(name: string): DocKind {
  return EXTENSIONS.find(([pattern]) => pattern.test(name))?.[1] ?? "markdown";
}

function placeholder(source: string, docSource?: DocMeta["source"]): DocMeta {
  const name = source.split(/[\\/]/).pop() || source;
  const kind = guessKind(name);
  return {
    id: --nextPlaceholderId,
    title: name,
    kind,
    view: viewOf(kind),
    source: docSource ?? { type: "file", path: source },
    byteLen: 0,
    // Stand-in until the backend has actually looked at the bytes.
    encoding: { name: "UTF-8", label: "UTF-8", source: "utf8", warning: null },
    baseDir: null,
  };
}

export const workspace = new Workspace();
