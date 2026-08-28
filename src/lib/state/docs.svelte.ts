import * as ipc from "../ipc";
import type {
  DocKind,
  DocMeta,
  JsonStats,
  SearchHit,
  SearchScope,
  SearchSummary,
  TocEntry,
} from "../ipc";
import { forgetDoc } from "../components/json/actions";
import { recents } from "./recents.svelte";

export type ViewMode = "rendered" | "raw";

class SearchState {
  query = $state("");
  caseSensitive = $state(false);
  scope = $state<SearchScope>("all");
  running = $state(false);
  hits = $state<SearchHit[]>([]);
  summary = $state<SearchSummary | null>(null);
  /** Index into `hits` of the match the view is parked on. */
  current = $state(-1);
  error = $state<string | null>(null);

  reset() {
    this.running = false;
    this.hits = [];
    this.summary = null;
    this.current = -1;
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
  /** `opening` while the backend is still reading the file. */
  status = $state<"opening" | "ready">("ready");
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

  // JSON
  stats = $state<JsonStats | null>(null);
  /** Selected node, kept for the inspector even while it scrolls out of view. */
  selectedNode = $state<number | null>(null);
  showInspector = $state(true);
  indexing = $state<{ done: number; total: number } | null>(null);
  jsonScrollTop = $state(0);
  /** Row the view should jump to; cleared by the view once honoured. */
  pendingRow = $state<number | null>(null);
  search = new SearchState();

  constructor(meta: DocMeta) {
    this.meta = meta;
  }

  get id() {
    return this.meta.id;
  }

  get kind(): DocKind {
    return this.meta.kind;
  }

  get subtitle(): string {
    const source = this.meta.source;
    if (source.type === "file") return source.path;
    if (source.type === "url") return source.url;
    return "붙여넣은 내용";
  }

  /** Drop derived state so the tab reloads from scratch on the next view. */
  invalidate() {
    this.html = null;
    this.toc = [];
    this.raw = null;
    this.stats = null;
    this.indexing = null;
    this.error = null;
    this.search.reset();
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
    const meta = placeholder(title ?? "붙여넣은 문서", { type: "text" });
    if (kind) meta.kind = kind;
    return this.run(meta, () => ipc.openText(content, title, kind));
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
    const tab = new DocTab(meta);
    tab.status = "opening";
    this.tabs = [...this.tabs, tab];
    this.activeId = tab.id;
    this.notice = null;
    this.opening = true;

    try {
      tab.meta = await load();
      tab.status = "ready";
      if (tab.meta.source.type === "file") {
        recents.add({ path: tab.meta.source.path, title: tab.meta.title, kind: tab.meta.kind });
      }
      // The id changed from the placeholder's, so follow it.
      if (this.activeId === meta.id) this.activeId = tab.id;
      return tab;
    } catch (err) {
      this.tabs = this.tabs.filter((t) => t !== tab);
      if (this.activeId === meta.id) this.activeId = this.tabs.at(-1)?.id ?? null;
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
    try {
      await ipc.closeDoc(id);
    } catch (err) {
      console.warn("[dviewer] close failed:", err);
    }
  }

  /** Force a document to be read as markdown or as JSON. */
  async setKind(id: number, kind: DocKind) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.kind === kind) return;
    try {
      const meta = await ipc.setDocKind(id, kind);
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

function placeholder(source: string, docSource?: DocMeta["source"]): DocMeta {
  const name = source.split(/[\\/]/).pop() || source;
  return {
    id: --nextPlaceholderId,
    title: name,
    kind: /\.(json|jsonl|ndjson|geojson|har|ipynb)$/i.test(name) ? "json" : "markdown",
    source: docSource ?? { type: "file", path: source },
    byteLen: 0,
    baseDir: null,
  };
}

export const workspace = new Workspace();
