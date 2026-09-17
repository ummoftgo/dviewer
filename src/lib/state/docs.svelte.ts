import type { CellSelection } from "../components/grid/preview";
import { compatiblePosition, type Position } from '../position';
import type { FrameStall, PdfStage } from '../frame/messages';
import type { BookmarkAnchor, BookmarkJump } from '../bookmarks';
import { family, mainTabs, subtabLabel } from "../subtabs";
import * as ipc from "../ipc";
import { viewOf } from "../ipc";
import { t } from "../i18n";
import type {
  ArchiveEntry,
  Collection,
  DocSource,
  GridStats,
  GridSort,
  OrderStats,
  Interpretation,
  DocKind,
  DocMeta,
  DocView,
  TreeStats,
  TreeRow,
  SearchHit,
  SearchScope,
  SearchSummary,
  TableHit,
  TableStats,
  TocEntry,
} from "../ipc";
import { chainOf, opensAs, sameSource } from "../source";
import { normalizeSegments, resolveLink } from '../links';
import { forgetDoc } from "../components/tree/actions";
import { toasts } from './toast.svelte';
import { NodeHistory } from "./history.svelte";
import { recents } from "./recents.svelte";
import { settings } from "./settings.svelte";
import type { TableState } from "../components/markdown/tables";
import type { SearchError } from '../components/markdown/search';

export type ViewMode = "rendered" | "raw";

/** Query options survive view switches; DOM ranges belong only to the view. */
export class MarkdownSearchState {
  open = $state(false);
  query = $state('');
  caseSensitive = $state(false);
  how = $state<'literal' | 'regex'>('literal');
  hits = $state(0);
  current = $state(-1);
  capped = $state(false);
  running = $state(false);
  searched = $state(false);
  supported = $state(true);
  error = $state<SearchError | null>(null);
  detail = $state('');
  seq = $state(0);

  reset() {
    this.seq++;
    this.hits = 0; this.current = -1; this.capped = false;
    this.running = false; this.searched = false; this.error = null; this.detail = '';
  }
}

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
  how = $state<Interpretation>("literal");
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
  how = $state<Interpretation>("literal");
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

class GridOrderState {
  sort = $state<GridSort | null>(null);
  filter = $state("");
  filterColumn = $state<number | null>(null);
  revision = $state(0);
  stats = $state<OrderStats | null>(null);
  running = $state(false);
  request = $state(0);
  progress = $state<{ done: number; total: number } | null>(null);
  error = $state<string | null>(null);

  reset() {
    this.request += 1;
    this.revision += 1;
    this.sort = null;
    this.filter = "";
    this.filterColumn = null;
    this.stats = null;
    this.running = false;
    this.progress = null;
    this.error = null;
  }
}

/** One open document: its metadata plus everything the views need to resume. */
export class DocTab {
  subtabLabel = $state("");
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
  status = $state<"blank" | "opening" | "ready" | "error">("ready");
  meta = $state<DocMeta>()!;
  mode = $state<ViewMode>("rendered");
  error = $state<string | null>(null);
  busy = $state(false);

  // Markdown
  markdownRevision = $state(0);
  pendingAnchor = $state<string | null>(null);
  pendingBookmark = $state<BookmarkJump | null>(null);
  bookmarkHeading = $state<string | null>(null);
  readBookmarkAnchor = $state<(() => BookmarkAnchor | null) | null>(null);
  frameReady = $state(false);
  frameContentLoaded = $state(false);
  position = $state<Position>();
  rawPosition = $state<Position>();
  pendingPosition = $state<Position>();
  positionRestoredAt = $state(0);

  rememberPosition(pos: Position) {
    if (this.pendingPosition) return;
    const previous = pos.kind === 'raw' ? this.rawPosition : this.position;
    if (previous && Object.keys(pos).every(key => Reflect.get(previous, key) === Reflect.get(pos, key))
      && Object.keys(previous).length === Object.keys(pos).length) return;
    if (pos.kind === 'raw') this.rawPosition = pos;
    else this.position = pos;
  }

  get savedPosition() {
    return compatiblePosition(this.pendingPosition ?? (this.mode === 'raw' ? this.rawPosition : this.position), this.view, this.mode === 'raw', this.kind);
  }

  finishPosition(moved: boolean) {
    this.pendingPosition = undefined;
    if (moved) this.positionRestoredAt = Date.now();
  }
  frameError = $state<string | null>(null);
  frameUrlPort = $state<string | null>(null);
  frameLoaded = $state(false);
  frameServed = $state<ipc.FrameServed | null>(null);
  frameCsp = $state<string[]>([]);
  frameAgentStarted = $state(false);
  frameStage = $state<PdfStage | null>(null);
  frameStall = $state<FrameStall | null>(null);
  frameToc = $state<ipc.TocEntry[]>([]);
  frameScroll = $state(0);
  framePage = $state(1);
  framePages = $state(0);
  frameRotation = $state<number>();
  frameAutoRotation = $state(false);
  frameHasText = $state<boolean | null>(null);
  frameBlocked = $state(0);
  frameProbe = $state<string | null>(null);
  frameExternal = $state(false);
  frameToggling = $state(false);
  frameRevision = $state(0);
  frameReadyLoad = $state('');
  frameSearch = $state({open:false, query:"", n:0, index:0, request:0});
  readonly markdownSearch = new MarkdownSearchState();
  codeLanguages: Record<string, ipc.CodeLanguage> = {};
  readonly codeSelections = new Map<number, string>();
  private rawRequest: Promise<string> | null = null;

  get frameQuery() { return `?g=${this.meta.generation ?? 0}&x=${this.frameRevision}`; }

  async setFrameExternal(allow: boolean) {
    if (this.frameToggling || allow === this.frameExternal) return;
    this.frameToggling = true;
    try {
      await ipc.frameExternal(this.id, allow);
      this.frameExternal = allow;
      this.frameRevision++;
      this.frameReady = false; this.frameReadyLoad = ''; this.frameBlocked = 0;
    } finally { this.frameToggling = false; }
  }

  loadRaw(): Promise<string> {
    if (this.raw !== null) return Promise.resolve(this.raw);
    const revision = this.markdownRevision;
    return this.rawRequest ??= ipc.docSourceText(this.id).then((raw) => {
      if (this.markdownRevision === revision) this.raw = raw;
      return raw;
    }).finally(() => { if (this.markdownRevision === revision) this.rawRequest = null; });
  }
  /** DOM controls own their updates; keeping this non-reactive avoids rebuilding HTML mid-drag. */
  readonly tables = new Map<number, TableState>();
  markdownTableMode = settings.markdownTableMode;
  tableWidthMode = $state(settings.tableWidthMode);
  tableFillRatios = $state<number[] | null>(null);
  html = $state<string | null>(null);
  toc = $state<TocEntry[]>([]);
  raw = $state<string | null>(null);
  /** Preserved per tab so switching back does not lose the reader's place. */
  scrollTop = $state(0);
  rawScrollTop = $state(0);
  readonly textSearch = $state({ query: '', current: null as number | null });

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
  readonly order = new GridOrderState();
  header = $state<string[]>([]);
  /** Pixel width per column, resizable by dragging a header edge. */
  columnWidths = $state<number[]>([]);
  columnOrder = $state<number[]>([]);
  hiddenColumns = $state<number[]>([]);
  frozenCount = $state(0);
  revealedColumn = $state<number | null>(null);
  selectedCell = $state<CellSelection | null>(null);
  tableScrollTop = $state(0);
  /** Cell the grid should jump to; cleared by the view once honoured. */
  pendingCell = $state<{ row: number; column: number } | null>(null);
  tableSearch = new TableSearchState();

  // Database (SQLite)
  /** Every table and view in the file; empty until the connection is opened. */
  collections = $state<Collection[]>([]);
  /** Which one is being read. Null only before the first list arrives. */
  collection = $state<string | null>(null);
  /** Rows and columns of the chosen collection; null until one is chosen. */
  gridStats = $state<GridStats | null>(null);
  schema = $state<string | null>(null);

  // Archive (zip)
  /** What the archive holds; empty until the central directory is read. */
  entries = $state<ArchiveEntry[]>([]);
  /** The entry being opened, so its row can say so. Null when none is. */
  openingEntry = $state<number | null>(null);
  /** Which encoding the entry names were read in, and whether that was a guess.
   *  Shown in the status line, and only worth reading when it was a guess. */
  nameEncoding = $state<string | null>(null);
  namesGuessed = $state(false);
  /** Entries the list left out, when the archive holds more than it shows. */
  hiddenEntries = $state(0);
  archiveScrollTop = $state(0);

  constructor(meta: DocMeta) {
    this.meta = meta;
  }

  get id() {
    return this.meta.id;
  }

  get kind(): DocKind {
    return this.meta.kind;
  }

  /** Which of the five views renders this tab. */
  get view(): DocView {
    return this.meta.view;
  }

  get subtitle(): string {
    if (this.status === "blank") return "";
    return describeSource(this.meta.source);
  }

  async applyOrder(sort: GridSort | null, filter: string, filterColumn: number | null): Promise<boolean> {
    const state = this.order;
    const request = ++state.request;
    state.running = true;
    state.progress = null;
    state.error = null;
    this.tableSearch.reset();
    try {
      const stats = await ipc.gridOrder(this.id, sort, filter, filterColumn, request);
      if (request !== state.request) return false;
      state.stats = sort || filter ? stats : null;
      state.sort = sort;
      state.filter = filter;
      state.filterColumn = filter ? filterColumn : null;
      this.selectedCell = null;
      this.pendingCell = null;
      this.tableScrollTop = 0;
      this.tableSearch.reset();
      state.revision += 1;
      return true;
    } catch (error) {
      if (request === state.request) state.error = ipc.errorMessage(error);
      return false;
    } finally {
      if (request === state.request) { state.running = false; state.progress = null; }
    }
  }

  resetColumnView() {
    this.columnOrder = [];
    this.hiddenColumns = [];
    this.frozenCount = 0;
    this.revealedColumn = null;
    this.tableFillRatios = null;
  }

  /** Drop derived state so the tab reloads from scratch on the next view. */
  invalidate() {
    this.order.reset();
    this.tables.clear();
    this.markdownRevision++;
    this.pendingAnchor = null;
    this.pendingBookmark = null;
    this.bookmarkHeading = null;
    this.readBookmarkAnchor = null;
    this.frameReady = false; this.frameToc = []; this.frameScroll = 0;
    this.framePage = 1; this.framePages = 0; this.frameHasText = null;
    this.frameRotation = undefined; this.frameAutoRotation = false;
    this.frameBlocked = 0; this.frameProbe = null;
    this.frameError = null; this.frameUrlPort = null; this.frameLoaded = false;
    this.frameServed = null; this.frameCsp = []; this.frameAgentStarted = false;
    this.frameStage = null;
    this.frameStall = null;
    this.frameReadyLoad = '';
    this.frameSearch = {open:false,query:"",n:0,index:0,request:0};
    this.markdownSearch.open = false;
    this.markdownSearch.query = '';
    this.markdownSearch.reset();
    this.rawRequest = null;
    this.codeLanguages = {};
    this.codeSelections.clear();
    this.html = null;
    this.toc = [];
    this.raw = null;
    this.textSearch.query = '';
    this.textSearch.current = null;
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
    this.tableFillRatios = null;
    this.resetColumnView();
    this.selectedCell = null;
    this.pendingCell = null;
    this.tableSearch.reset();
    this.collections = [];
    this.collection = null;
    this.gridStats = null;
    this.schema = null;
    this.entries = [];
    this.openingEntry = null;
    this.nameEncoding = null;
    this.namesGuessed = false;
    this.hiddenEntries = 0;
  }
}

class Workspace {
  private reloads = new Map<number, { again: boolean; task: Promise<void> }>();
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
    return this.tabs.find((tab) => tab.status !== 'error' && opensAs(tab.meta.source, path)) ?? null;
  }

  /** Re-focus the tab already showing an entry, rather than unpacking it twice. */
  private findEntry(source: DocSource): DocTab | null {
    return this.tabs.find((tab) => tab.status !== 'error' && sameSource(tab.meta.source, source)) ?? null;
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

  async openPath(path: string, keepError = false) {
    const existing = this.findByPath(path);
    if (existing) {
      this.activeId = existing.id;
      return existing;
    }
    return this.run(placeholder(path), () => ipc.openPath(path), path, '', keepError);
  }

  async openUrl(url: string, keepError = false) {
    const existing = this.findEntry({ type: 'url', url });
    if (existing) { this.activeId = existing.id; return existing; }
    return this.run(placeholder(url, { type: "url", url }), () => ipc.openUrl(url), undefined, '', keepError);
  }

  async openLink(from: DocTab, href: string): Promise<DocTab | null> {
    const link = resolveLink(from.meta, href);
    let opened: DocTab | null;
    if (!link) {
      toasts.show(t('link.unsupported'), 'info');
      return null;
    }
    if (link.type === 'file') opened = await this.openPath(link.path, true);
    else if (link.type === 'url') opened = await this.openUrl(link.url, true);
    else {
      const parent = this.findEntry(link.parent);
      const entry = parent?.entries.find(entry => normalizeSegments(entry.name) === link.name);
      // Entry sources retain identity after closing their parent, but no archive handle.
      if (!parent || parent.kind !== 'zip' || parent.status !== 'ready' || !entry) {
        toasts.show(t('link.unsupported'), 'info');
        return null;
      }
      opened = await this.openEntry(parent, entry, true);
    }
    if (opened && (opened.kind === 'markdown' || opened.kind === 'html') && link.anchor) {
      opened.pendingAnchor = link.anchor;
      opened.pendingBookmark = null;
      opened.mode = 'rendered';
    }
    return opened;
  }

  /**
   * Open one entry of an archive in a tab of its own.
   *
   * A new tab rather than a replacement: the archive stays where it is, which
   * is what lets two entries be compared and what saves a navigation stack
   * nobody has asked for. The list is the hub, in the same grammar the start
   * pane already uses.
   */
  async openEntry(archive: DocTab, entry: ArchiveEntry, keepError = false) {
    // What the backend is about to build, built here too so the tab that is
    // already showing it can be raised without unpacking anything.
    const wanted = chainOf(archive.meta.source, entry);
    const existing = wanted && this.findEntry(wanted);
    if (existing) {
      this.activeId = existing.id;
      return existing;
    }

    archive.openingEntry = entry.index;
    try {
      return await this.run(placeholder(entry.name, wanted ?? undefined), () =>
        ipc.openEntry(archive.id, entry.index), undefined, '', keepError,
      );
    } finally {
      archive.openingEntry = null;
    }
  }

  async openText(content: string, title?: string, kind?: DocKind) {
    const meta = placeholder(title ?? t("doc.pasted"), { type: "text" });
    if (kind) {
      meta.kind = kind;
      meta.view = viewOf(kind);
    }
    return this.run(meta, () => ipc.openText(content, title ?? t("doc.pasted"), kind));
  }

  async openTreeTable(parent: DocTab, row: TreeRow) {
    const nodeId = row.id;
    const wanted: DocSource = { type: "treeSlice", parent: parent.id,
      generation: parent.meta.generation ?? 0, node: nodeId, path: "" };
    const existing = this.findEntry(wanted);
    if (existing) { this.activeId = existing.id; return existing; }
    parent.openingEntry = nodeId;
    try {
      return await this.run(placeholder(parent.meta.title, wanted), () => ipc.treeAsTable(parent.id, nodeId), undefined, subtabLabel(row));
    } finally {
      parent.openingEntry = null;
    }
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
    label = "",
    keepError = false,
  ): Promise<DocTab | null> {
    // Opening from a blank tab fills that tab in rather than adding another —
    // the blank one is where the reader started, so it is where they expect
    // the document to land.
    const blank = this.tabs.find((tab) => tab.status === "blank" && tab.id === this.activeId);
    const tab = blank ?? new DocTab(meta);
    if (blank) blank.meta = meta;
    else this.tabs = [...this.tabs, tab];
    tab.subtabLabel = label;
    tab.status = "opening";
    this.activeId = tab.id;
    this.notice = null;
    this.opening = true;

    try {
      const [loaded, tableMode] = await Promise.all([
        load(),
        settings.load().then(() => ({ markdown: settings.markdownTableMode, table: settings.tableWidthMode })),
      ]);
      // The reader can close a tab while it is still opening — a 500MB file
      // spends seconds here. The tab goes at once, but the document it was
      // waiting for arrives afterwards with nobody left to close it, and its
      // mmap and index would then be held until the app exits.
      if (!this.tabs.includes(tab)) {
        void ipc.closeDoc(loaded.id).catch(() => {});
        return null;
      }
      tab.markdownTableMode = tableMode.markdown;
      tab.tableWidthMode = tableMode.table;
      tab.meta = loaded;
      tab.status = "ready";
      if (tab.meta.source.type === 'file') {
        void ipc.watchDoc(tab.id).catch(error => console.warn('[dviewer] could not watch document:', error));
      }
      if (tab.meta.source.type === "file") {
        recents.add({ path: tab.meta.source.path, title: tab.meta.title, kind: tab.meta.kind });
      }
      // The id changed from the placeholder's, so follow it.
      if (this.activeId === meta.id) this.activeId = tab.id;
      return tab;
    } catch (err) {
      if (keepError) {
        if (this.tabs.includes(tab)) {
          tab.error = ipc.errorMessage(err);
          tab.status = 'error';
        }
        return null;
      }
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
      // `notice` is only ever drawn by the start pane, which is right for a
      // file that would not open — there is no tab to put it on. An entry that
      // would not open has one: the archive it was clicked in, which is still
      // on screen and is where the reader is looking.
      const message = ipc.errorMessage(err);
      const archive = this.tabs.find((t) => t.openingEntry !== null);
      if (archive) archive.error = message;
      else this.notice = message;
      // A recent entry pointing at a file that no longer opens is just noise.
      if (failedPath) recents.remove(failedPath);
      return null;
    } finally {
      this.opening = false;
    }
  }

  async close(id: number) {
    const group = family(this.tabs, id);
    if (!group) return;
    const isParent = group.parent.id === id;
    const closing = isParent ? [...group.children.map((tab) => tab.id), id] : [id];
    const mains = mainTabs(this.tabs);
    const index = mains.findIndex((tab) => tab.id === id);
    this.tabs = this.tabs.filter((tab) => !closing.includes(tab.id));
    if (!isParent) {
      this.activeId = group.parent.id;
    } else if (closing.includes(this.activeId ?? 0)) {
      this.activeId = (mains[index + 1] ?? mains[index - 1])?.id ?? null;
    }
    // Remove placeholders together with the family before any IPC yields.
    // run() closes their eventual documents when the pending open completes.
    for (const docId of closing) {
      forgetDoc(docId);
      if (docId <= 0) continue;
      try {
        await ipc.closeDoc(docId);
      } catch (err) {
        console.warn("[dviewer] close failed:", err);
      }
    }
  }

  /** Force a document to be read as some other format. */
  async setKind(id: number, kind: DocKind) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.kind === kind) return;
    try {
      const meta = await ipc.setDocKind(id, kind);
      if (!this.tabs.includes(tab) || (meta.generation ?? 0) < (tab.meta.generation ?? 0)) return;
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
      if (!this.tabs.includes(tab) || (meta.generation ?? 0) < (tab.meta.generation ?? 0)) return;
      // Byte offsets do not survive a change of encoding, so every index built
      // from the old reading has to go with it — the cached paths included.
      forgetDoc(id);
      tab.invalidate();
      tab.meta = meta;
    } catch (err) {
      tab.error = ipc.errorMessage(err);
    }
  }

  /** Coalesce saves during a reload, and never apply a reply to a closed or newer tab. */
  changed(id: number): Promise<void> {
    if (!this.tab(id)) return Promise.resolve();
    if (settings.autoReload) return this.reload(id);
    toasts.show(t('doc.changed'), 'info');
    return Promise.resolve();
  }

  reload(id: number): Promise<void> {
    const pending = this.reloads.get(id);
    if (pending) { pending.again = true; return pending.task; }
    const tab = this.tab(id);
    if (!tab || tab.meta.source.type !== 'file') return Promise.resolve();
    const entry = { again: false, task: Promise.resolve() };
    entry.task = (async () => {
      do {
        entry.again = false;
        const generation = tab.meta.generation ?? 0;
        try {
          const meta = await ipc.reloadDoc(id);
          if (!this.tabs.includes(tab) || (meta.generation ?? 0) <= (tab.meta.generation ?? 0)) continue;
          // Descendant node identities cannot survive this source replacement.
          const active = this.activeId;
          const closing = this.tabs.filter(child => child.meta.source.type === 'treeSlice' && child.meta.source.parent === id)
            .map(child => this.close(child.id));
          if (active !== null && this.tabs.some(tab => tab.id === active)) this.activeId = active;
          await Promise.all(closing);
          if (!this.tabs.includes(tab) || (meta.generation ?? 0) <= (tab.meta.generation ?? 0)) continue;
          forgetDoc(id);
          tab.invalidate();
          tab.meta = meta;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled') {
            entry.again = true;
          } else if (this.tabs.includes(tab) && (tab.meta.generation ?? 0) === generation) {
            tab.error = ipc.errorMessage(error);
          }
        }
      } while (entry.again && this.tabs.includes(tab));
    })().finally(() => { this.reloads.delete(id); });
    this.reloads.set(id, entry);
    return entry.task;
  }

  tab(id: number, generation?: number): DocTab | null {
    return this.tabs.find(t => t.id === id && (generation === undefined || (t.meta.generation ?? 0) === generation)) ?? null;
  }
}

/**
 * How a source reads in the tab's tooltip.
 *
 * Here rather than in `source.ts` because it is the one question about a source
 * that needs the message catalogue — and the only one whose being wrong is
 * visible the moment it happens.
 */
function describeSource(source: DocSource): string {
  if (source.type === "treeSlice") return source.path;
  if (source.type === "file") return source.path;
  if (source.type === "url") return source.url;
  if (source.type === "text") return t("doc.pastedSource");
  // The whole way in, so a document two archives deep says which two.
  return [describeSource(source.root), ...source.entries.map((entry) => entry.name)].join(" → ");
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
  [/\.(txt|log)$/i, "text"],
  [/\.zip$/i, "zip"],
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
