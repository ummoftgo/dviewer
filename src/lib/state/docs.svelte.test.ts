/**
 * The tab state, at the places it has actually gone wrong.
 *
 * Every case here reproduces a bug that shipped or was caught late: a document
 * left held by a tab that had already closed, derived state surviving a change
 * that invalidated it, a search result arriving for a query the reader had
 * replaced, and a second copy of an archive entry that was already open. None
 * of them throws. That is the point — they are the ones a type checker and a
 * screen check both walk past.
 *
 * The boundary being mocked is `ipc.ts` rather than Tauri's bridge under it.
 * `mockIPC` patches `window.__TAURI_INTERNALS__` and so needs a DOM, and
 * `ipc.ts` is where this app already collects its contract with the backend —
 * so it is the honest seam.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DocKind, DocMeta, DocSource, TreeRow } from "../ipc";
import { settings } from "./settings.svelte";
import { toasts } from './toast.svelte';
import { i18n, t } from '../i18n';

vi.mock("../persist", () => ({ getValue: vi.fn(async () => undefined), setValue: vi.fn() }));

/** Documents the fake backend has been asked to close. */
const closed: number[] = [];
/**
 * When set, the next `openPath` waits on it before answering — which is how a
 * test holds a document open long enough to close the tab waiting for it.
 */
let gate: Promise<void> | null = null;
let release: (() => void) | null = null;
let nextId = 0;

function holdTheNextOpen() {
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
}

function meta(source: DocSource, kind: DocKind = "json"): DocMeta {
  return {
    id: ++nextId,
    title: source.type === "file" ? source.path : "doc",
    kind,
    view: kind === "json" ? "tree" : "table",
    source,
    byteLen: 2,
    encoding: { name: "UTF-8", label: "UTF-8", source: "utf8", warning: null },
    baseDir: null,
  };
}

vi.mock("../ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ipc")>();
  return {
    ...real,
    openPath: vi.fn(async (path: string) => {
      const waiting = gate;
      gate = null;
      if (waiting) await waiting;
      return meta({ type: "file", path });
    }),
    openEntry: vi.fn(async (_docId: number, index: number) =>
      meta({ type: "archiveEntry", root: { type: "file", path: "C:/a.zip" }, entries: [{ index, name: `e${index}` }] }),
    ),
    closeDoc: vi.fn(async (docId: number) => void closed.push(docId)),
    gridOrder: vi.fn(),
    watchDoc: vi.fn(async () => {}),
    reloadDoc: vi.fn(),
    frameExternal: vi.fn(async () => {}),
    treeAsTable: vi.fn(async (parent: number, node: number) => {
      const waiting = gate;
      gate = null;
      if (waiting) await waiting;
      return meta({ type: "treeSlice", parent, generation: 0, node, path: "$.items" });
    }),
  };
});

const { DocTab, workspace } = await import("./docs.svelte");
const ipc = await import("../ipc");

test('reload drops every derived view and child without activating a background parent', async () => {
  const parent = (await workspace.openPath('C:/parent.json'))!;
  const child = (await workspace.openTreeTable(parent, { id: 0, kind: 'array', key: 'items', index: null } as TreeRow))!;
  const neighbor = (await workspace.openPath('C:/neighbor.md'))!;
  parent.html = 'old'; parent.raw = 'old'; parent.schema = 'old';
  parent.collections = [{ name: 'old', isView: false }]; parent.collection = 'old';
  parent.entries = [{ index: 0, name: 'old' } as typeof parent.entries[number]];
  parent.selectedNode = 7; parent.scrollTop = 120;
  vi.mocked(ipc.reloadDoc).mockResolvedValueOnce({ ...parent.meta, generation: 1 });
  await workspace.reload(parent.id);
  expect(workspace.tabs.includes(child)).toBe(false);
  expect(workspace.activeId).toBe(neighbor.id);
  expect([parent.html, parent.raw, parent.schema, parent.collection, parent.selectedNode]).toEqual([null, null, null, null, null]);
  expect(parent.collections).toEqual([]); expect(parent.entries).toEqual([]);
  expect(parent.scrollTop).toBe(120);
  expect(workspace.tab(parent.id, 0)).toBeNull();
  expect(workspace.tab(parent.id, 1)).toBe(parent);
});

test('a late reload reply cannot revive a closed document', async () => {
  const tab = (await workspace.openPath('C:/closed.json'))!;
  let resolve!: (meta: DocMeta) => void;
  vi.mocked(ipc.reloadDoc).mockImplementationOnce(() => new Promise<DocMeta>(done => { resolve = done; }));
  const pending = workspace.reload(tab.id);
  await workspace.close(tab.id);
  resolve({ ...tab.meta, generation: 1 }); await pending;
  expect(workspace.tabs).toEqual([]);
});

test.each([[2, 1, 'newer'], [1, 2, null]])('reload orders replies by returned generation (%s then %s)', async (current, returned, html) => {
  const tab = (await workspace.openPath('C:/newer.json'))!;
  let resolve!: (meta: DocMeta) => void;
  vi.mocked(ipc.reloadDoc).mockImplementationOnce(() => new Promise<DocMeta>(done => { resolve = done; }));
  const pending = workspace.reload(tab.id);
  tab.meta = { ...tab.meta, generation: current as number }; tab.html = 'newer';
  resolve({ ...tab.meta, generation: returned as number }); await pending;
  expect(tab.meta.generation).toBe(2); expect(tab.html).toBe(html);
});

test.each(['kind', 'encoding'])('a late %s reply cannot roll back a reloaded document', async change => {
  const tab = (await workspace.openPath('C:/reinterpreted.json'))!;
  let resolve!: (meta: DocMeta) => void;
  const command = vi.spyOn(ipc, change === 'kind' ? 'setDocKind' : 'setDocEncoding')
    .mockImplementationOnce(() => new Promise<DocMeta>(done => { resolve = done; }));
  const pending = change === 'kind' ? workspace.setKind(tab.id, 'text') : workspace.setEncoding(tab.id, 'UTF-16LE');
  vi.mocked(ipc.reloadDoc).mockResolvedValueOnce({ ...tab.meta, generation: 2 });
  await workspace.reload(tab.id);
  tab.html = 'reloaded';
  resolve({ ...tab.meta, generation: 1 }); await pending;
  expect(tab.meta.generation).toBe(2); expect(tab.html).toBe('reloaded');
  command.mockRestore();
});

test('multiple saves during one reload coalesce into one additional reload', async () => {
  const tab = (await workspace.openPath('C:/saving.json'))!;
  let resolve!: (meta: DocMeta) => void;
  vi.mocked(ipc.reloadDoc).mockClear().mockImplementationOnce(() => new Promise<DocMeta>(done => { resolve = done; }))
    .mockResolvedValueOnce({ ...tab.meta, generation: 2 });
  const first = workspace.reload(tab.id);
  expect(workspace.reload(tab.id)).toBe(first);
  expect(workspace.reload(tab.id)).toBe(first);
  resolve({ ...tab.meta, generation: 1 }); await first;
  expect(ipc.reloadDoc).toHaveBeenCalledTimes(2);
  expect(tab.meta.generation).toBe(2);
});

test('a reload cancelled by reinterpretation retries without another save event', async () => {
  const tab = (await workspace.openPath('C:/cancelled.json'))!;
  let reject!: (error: unknown) => void;
  vi.mocked(ipc.reloadDoc).mockClear()
    .mockImplementationOnce(() => new Promise<DocMeta>((_, fail) => { reject = fail; }))
    .mockResolvedValueOnce({ ...tab.meta, generation: 2 });
  const pending = workspace.reload(tab.id);
  tab.meta = { ...tab.meta, generation: 1 };
  reject({ code: 'cancelled' });
  await pending;
  expect(ipc.reloadDoc).toHaveBeenCalledTimes(2);
  expect(tab.meta.generation).toBe(2);
  expect(tab.error).toBeNull();
});

test('a cancelled reload does not retry after the tab closes', async () => {
  const tab = (await workspace.openPath('C:/closed-cancelled.json'))!;
  let reject!: (error: unknown) => void;
  vi.mocked(ipc.reloadDoc).mockClear()
    .mockImplementationOnce(() => new Promise<DocMeta>((_, fail) => { reject = fail; }));
  const pending = workspace.reload(tab.id);
  await workspace.close(tab.id);
  reject({ code: 'cancelled' });
  await pending;
  expect(ipc.reloadDoc).toHaveBeenCalledTimes(1);
  expect(workspace.tabs).toEqual([]);
});

test('disabled automatic reload reports the complete message without reloading', async () => {
  const tab = (await workspace.openPath('C:/changed.md'))!;
  i18n.setting = 'ko'; settings.autoReload = false;
  const show = vi.spyOn(toasts, 'show').mockImplementation(() => 0);
  vi.mocked(ipc.reloadDoc).mockClear();
  await workspace.changed(tab.id);
  expect(ipc.reloadDoc).not.toHaveBeenCalled();
  expect(show).toHaveBeenCalledExactlyOnceWith('파일이 바뀌었습니다', 'info');
  show.mockRestore(); settings.autoReload = true;
});

test('launch requests open in sequence and leave the last requested document active', async () => {
  const url = vi.spyOn(ipc, 'openUrl').mockImplementation(async value => meta({ type: 'url', url: value }));
  await workspace.openLaunch({ files: ['C:/first.md', 'C:/last.md'], urls: ['https://example.com/doc'] });
  expect(workspace.tabs.map(tab => tab.meta.source)).toEqual([
    { type: 'file', path: 'C:/first.md' }, { type: 'file', path: 'C:/last.md' }, { type: 'url', url: 'https://example.com/doc' },
  ]);
  expect(workspace.activeId).toBe(workspace.tabs[2].id);
  await workspace.openLaunch({ files: ['C:/first.md'], urls: [] });
  expect(workspace.activeId).toBe(workspace.tabs[0].id);
  expect(workspace.tabs).toHaveLength(3);
  url.mockRestore();
});

test("a new document waits for settings and keeps its own default afterwards", async () => {
  let resolve!: () => void;
  const load = vi.spyOn(settings, "load").mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  settings.markdownTableMode = "scroll";
  const opening = workspace.openPath("C:/first.md");
  await Promise.resolve();
  expect(workspace.tabs[0].status).toBe("opening");
  settings.markdownTableMode = "fill";
  resolve();
  const first = (await opening)!;
  expect(first.markdownTableMode).toBe("fill");
  settings.markdownTableMode = "scroll";
  const second = (await workspace.openPath("C:/second.md"))!;
  expect(first.markdownTableMode).toBe("fill");
  expect(second.markdownTableMode).toBe("scroll");
  load.mockRestore();
});

test("table values survive raw and tab switches but not reinterpretation", async () => {
  const tab = (await workspace.openPath("C:/table.md"))!;
  const other = (await workspace.openPath("C:/other.md"))!;
  tab.tables.set(0, { mode: "fill", scrollWidths: [80, 120], fillRatios: [40, 60] });
  tab.mode = "raw";
  workspace.activate(other.id);
  workspace.activate(tab.id);
  tab.mode = "rendered";
  expect(tab.tables.get(0)).toEqual({ mode: "fill", scrollWidths: [80, 120], fillRatios: [40, 60] });
  tab.invalidate();
  expect(tab.tables.size).toBe(0);
});

describe("closing a document family", () => {
  const row = { id: 7, key: "items", index: null, kind: "array" } as TreeRow;

  test("removes the family together and closes children before the parent", async () => {
    const parent = (await workspace.openPath("C:/a.json"))!;
    const first = (await workspace.openTreeTable(parent, row))!;
    const neighbor = (await workspace.openPath("C:/b.json"))!;
    const second = (await workspace.openTreeTable(parent, { ...row, id: 8 }))!;
    expect(first.subtabLabel).toBe("items[]");
    const closing = workspace.close(parent.id);
    expect(workspace.tabs.map((tab) => tab.id)).toEqual([neighbor.id]);
    expect(workspace.activeId).toBe(neighbor.id);
    await closing;
    expect(closed).toEqual([first.id, second.id, parent.id]);
  });

  test.each([true, false])("closing a child activates its parent even with another child left (active: %s)", async (active) => {
    const parent = (await workspace.openPath("C:/a.json"))!;
    const first = (await workspace.openTreeTable(parent, row))!;
    const second = (await workspace.openTreeTable(parent, { ...row, id: 8 }))!;
    if (!active) workspace.activate(first.id);
    await workspace.close(second.id);
    expect(workspace.activeId).toBe(parent.id);
    expect(workspace.tabs.map((tab) => tab.id)).toEqual([parent.id, first.id]);
    expect(closed).toEqual([second.id]);
  });

  test("a child still opening disappears immediately and its late document is closed", async () => {
    const parent = (await workspace.openPath("C:/a.json"))!;
    holdTheNextOpen();
    const opening = workspace.openTreeTable(parent, row);
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.tabs[1].subtabLabel).toBe("items[]");
    await workspace.close(parent.id);
    expect(workspace.tabs).toHaveLength(0);
    expect(workspace.activeId).toBeNull();
    release!();
    expect(await opening).toBeNull();
    expect(closed).toEqual([parent.id, nextId]);
  });
});

beforeEach(() => {
  workspace.tabs = [];
  workspace.activeId = null;
  workspace.notice = null;
  closed.length = 0;
  gate = null;
  release = null;
  vi.mocked(ipc.openPath).mockClear();
  vi.mocked(ipc.openEntry).mockClear();
  vi.mocked(ipc.frameExternal).mockReset().mockResolvedValue(undefined);
});

describe('relative document links', () => {
  function markdown(source: DocSource = { type: 'file', path: 'C:/specs/guide.md' }) {
    const tab = new DocTab({ ...meta(source, 'markdown'), baseDir: 'C:/specs' });
    workspace.tabs = [tab]; workspace.activate(tab.id);
    return tab;
  }

  test('opens a new tab and keeps the source document and reading state', async () => {
    const from = markdown();
    from.html = '<h1>Guide</h1>'; from.scrollTop = 432; from.markdownSearch.query = 'keep';
    const opened = await workspace.openLink(from, './schema.json');
    expect(workspace.tabs).toEqual([from, opened]);
    expect(workspace.active).toBe(opened);
    expect(opened?.status).toBe('ready');
    expect([from.html, from.scrollTop, from.markdownSearch.query]).toEqual(['<h1>Guide</h1>', 432, 'keep']);
    expect(ipc.openPath).toHaveBeenLastCalledWith('C:/specs/schema.json');
  });

  test('raises an existing Windows path after separator normalization', async () => {
    const from = markdown();
    const existing = await workspace.openPath('C:\\specs\\schema.json');
    workspace.activate(from.id);
    expect(await workspace.openLink(from, './schema.json')).toBe(existing);
    expect(workspace.active).toBe(existing);
    expect(workspace.tabs).toHaveLength(2);
    expect(ipc.openPath).toHaveBeenCalledTimes(1);
  });

  test('URL links reuse the loaded URL tab', async () => {
    const from = markdown({ type: 'url', url: 'https://example.test/specs/guide.md' });
    const open = vi.spyOn(ipc, 'openUrl').mockImplementation(async url => meta({ type: 'url', url }));
    try {
      const first = await workspace.openLink(from, '../schema.json?unused=1');
      workspace.activate(from.id);
      expect(await workspace.openLink(from, '../schema.json#ignored')).toBe(first);
      expect(workspace.active).toBe(first);
      expect(workspace.tabs).toHaveLength(2);
      expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/schema.json');
      expect(first?.pendingAnchor).toBeNull();
    } finally { open.mockRestore(); }
  });

  test('a failed link keeps an error placeholder, leaves the source intact and can be retried', async () => {
    const from = markdown();
    const notify = vi.spyOn(toasts, 'show').mockImplementation(() => 0);
    vi.mocked(ipc.openPath).mockRejectedValueOnce(new Error('The requested file does not exist.'));
    try {
      expect(await workspace.openLink(from, './missing.json')).toBeNull();
      const failed = workspace.active!;
      expect(workspace.tabs).toEqual([from, failed]);
      expect(failed.status).toBe('error');
      expect(failed.error).toBe('The requested file does not exist.');
      expect(from.error).toBeNull(); expect(workspace.notice).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      const retried = await workspace.openLink(from, './missing.json');
      expect(retried?.status).toBe('ready');
      expect(retried).not.toBe(failed);
      expect(ipc.openPath).toHaveBeenCalledTimes(2);
      const closedBefore = closed.length;
      await workspace.close(failed.id);
      expect(closed).toHaveLength(closedBefore);
    } finally { notify.mockRestore(); }
  });

  test('a closed pending link cannot revive its placeholder on failure', async () => {
    const from = markdown();
    let reject!: (reason: Error) => void;
    vi.mocked(ipc.openPath).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = workspace.openLink(from, './missing.json');
    await workspace.close(workspace.activeId!);
    reject(new Error('The requested file does not exist.'));
    expect(await pending).toBeNull();
    expect(workspace.tabs).toEqual([from]);
    expect(from.error).toBeNull(); expect(workspace.notice).toBeNull();
  });

  test('a delayed Markdown open receives its decoded anchor after loading', async () => {
    const from = markdown();
    let answer!: (value: DocMeta) => void;
    vi.mocked(ipc.openPath).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = workspace.openLink(from, '../notes.md#%EC%A0%88');
    expect(workspace.active?.status).toBe('opening');
    answer(meta({ type: 'file', path: 'C:/notes.md' }, 'markdown'));
    const opened = (await pending)!;
    expect(opened.pendingAnchor).toBe('절');
    opened.mode = 'raw'; workspace.activate(from.id);
    expect(await workspace.openLink(from, '../notes.md#other')).toBe(opened);
    expect([opened.pendingAnchor, opened.mode]).toEqual(['other', 'rendered']);
    opened.invalidate(); expect(opened.pendingAnchor).toBeNull();
  });

  test('archive links use the immediate open parent and reuse sibling tabs', async () => {
    const root: DocSource = { type: 'file', path: 'C:\\bundle.zip' };
    const parentSource: DocSource = { type: 'archiveEntry', root, entries: [{ index: 1, name: 'inside.zip' }] };
    const from = markdown({ ...parentSource, entries: [...parentSource.entries, { index: 2, name: 'docs/guide.md' }] });
    const parent = new DocTab(meta(parentSource, 'zip'));
    const entry = { index: 3, name: 'schema.json', size: 1, encrypted: false, kind: 'json' as const };
    parent.entries = [entry]; workspace.tabs = [parent, from];
    const open = vi.mocked(ipc.openEntry).mockClear().mockResolvedValueOnce(meta({
      ...parentSource, entries: [...parentSource.entries, { index: 3, name: 'schema.json' }],
    }));
    const opened = await workspace.openLink(from, '../schema.json');
    expect(open).toHaveBeenCalledExactlyOnceWith(parent.id, 3);
    workspace.activate(from.id);
    expect(await workspace.openLink(from, '../schema.json')).toBe(opened);
    expect(workspace.tabs).toHaveLength(3);
    await workspace.close(parent.id);
    const notify = vi.spyOn(toasts, 'show').mockImplementation(() => 0);
    try {
      workspace.activate(from.id);
      expect(await workspace.openLink(from, '../schema.json')).toBeNull();
      expect(notify).toHaveBeenCalledExactlyOnceWith(t('link.unsupported'), 'info');
      expect(workspace.active).toBe(from);
      expect(open).toHaveBeenCalledTimes(1);
    } finally { notify.mockRestore(); }
  });
});

describe("order completion belongs to the tab, not its mounted view", () => {
  test("explicit ascending, descending and original choices commit the requested sort", async () => {
    const tab = new DocTab(meta({ type: "text" }));
    for (const sort of [{ column: 2, descending: false }, { column: 2, descending: true }, null]) {
      vi.mocked(ipc.gridOrder).mockResolvedValueOnce({ shown: 3, total: 3, indexBytes: 12, peakBytes: 24 });
      expect(await tab.applyOrder(sort, "", null)).toBe(true);
      expect(tab.order.sort).toEqual(sort);
      expect(tab.order.stats === null).toBe(sort === null);
    }
  });
  test("a pending order commits its scope and refresh revision after a tab round trip with the same row count", async () => {
    const parent = (await workspace.openPath("C:/a.json"))!;
    const tab = (await workspace.openTreeTable(parent, { id: 7, key: "items", index: null, kind: "array" } as TreeRow))!;
    tab.order.stats = { shown: 3, total: 3, indexBytes: 12, peakBytes: 24 };
    tab.tableScrollTop = 500;
    let resolve!: (stats: NonNullable<typeof tab.order.stats>) => void;
    vi.mocked(ipc.gridOrder).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const revision = tab.order.revision;
    const pending = tab.applyOrder({ column: 0, descending: true }, "keep", 1);
    expect(tab.order.filterColumn).toBeNull();
    expect(tab.order.filter).toBe("");
    workspace.activate(parent.id);
    workspace.activate(tab.id);
    resolve({ shown: 3, total: 3, indexBytes: 12, peakBytes: 24 });
    expect(await pending).toBe(true);
    expect(tab.order.stats?.shown).toBe(3);
    expect(tab.order.revision).toBe(revision + 1);
    expect(tab.order.filterColumn).toBe(1);
    expect(tab.order.filter).toBe("keep");
    expect(tab.order.sort).toEqual({ column: 0, descending: true });
    expect(tab.tableScrollTop).toBe(0);
    expect(tab.order.running).toBe(false);
    expect(ipc.gridOrder).toHaveBeenLastCalledWith(tab.id, { column: 0, descending: true }, "keep", 1, tab.order.request);
  });

  test("failure keeps applied scope and reset rejects a late result", async () => {
    const tab = new DocTab(meta({ type: "text" }));
    tab.order.filter = "old";
    tab.order.filterColumn = 0;
    vi.mocked(ipc.gridOrder).mockRejectedValueOnce(new Error("failed"));
    expect(await tab.applyOrder(null, "new", 1)).toBe(false);
    expect(tab.order.filter).toBe("old");
    expect(tab.order.filterColumn).toBe(0);
    expect(tab.order.revision).toBe(0);
    let resolve!: (stats: { shown: number; total: number; indexBytes: number; peakBytes: number }) => void;
    vi.mocked(ipc.gridOrder).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = tab.applyOrder(null, "new", 1);
    tab.order.reset();
    resolve({ shown: 1, total: 3, indexBytes: 4, peakBytes: 4 });
    expect(await pending).toBe(false);
    expect(tab.order.filterColumn).toBeNull();
    expect(tab.order.filter).toBe("");
    expect(tab.order.stats).toBeNull();
  });
});

describe("opening a file that is already open", () => {
  test("invalidating the document discards order and supersedes pending results", () => {
    const tab = new DocTab(meta({ type: "text" }));
    tab.order.sort = { column: 1, descending: true };
    tab.order.filter = "keep";
    tab.order.filterColumn = 1;
    tab.order.stats = { shown: 1, total: 10, indexBytes: 4, peakBytes: 100 };
    tab.order.running = true;
    const request = tab.order.request;
    tab.invalidate();
    expect(tab.order.request).toBeGreaterThan(request);
    expect(tab.order.sort).toBeNull();
    expect(tab.order.stats).toBeNull();
    expect(tab.order.filter).toBe("");
    expect(tab.order.filterColumn).toBeNull();
    expect(tab.order.running).toBe(false);
  });
  test("raises the tab instead of loading a second copy", async () => {
    await workspace.openPath("C:/a.json");
    await workspace.openPath("C:/a.json");
    expect(workspace.tabs).toHaveLength(1);
    expect(ipc.openPath).toHaveBeenCalledTimes(1);
  });

  test("two different files are two tabs", async () => {
    await workspace.openPath("C:/a.json");
    await workspace.openPath("C:/b.json");
    expect(workspace.tabs).toHaveLength(2);
  });

  /**
   * The transparent unwrap. An archive holding one document opens as that
   * document, so the tab for `bundle.zip` is not a file tab at all — and
   * before `opensAs` grew its second clause, opening it twice made two tabs.
   */
  test("an archive that was unwrapped is still the tab that file produces", async () => {
    const unwrapped = new DocTab(
      meta({
        type: "archiveEntry",
        root: { type: "file", path: "C:/bundle.zip" },
        entries: [{ index: 0, name: "only/report.json" }],
      }),
    );
    workspace.tabs = [unwrapped];

    await workspace.openPath("C:/bundle.zip");
    expect(workspace.tabs).toHaveLength(1);
    expect(ipc.openPath).not.toHaveBeenCalled();
    expect(workspace.activeId).toBe(unwrapped.id);
  });
});

describe("clicking an archive entry that is already open", () => {
  function archiveTab(): InstanceType<typeof DocTab> {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.zip" }, "text"));
    workspace.tabs = [tab];
    return tab;
  }

  const entry = (index: number) => ({ index, name: `e${index}`, size: 1, encrypted: false, kind: "text" as const });

  test("raises the tab it is already in", async () => {
    const archive = archiveTab();
    await workspace.openEntry(archive, entry(3));
    expect(workspace.tabs).toHaveLength(2);

    await workspace.openEntry(archive, entry(3));
    expect(workspace.tabs).toHaveLength(2);
    expect(ipc.openEntry).toHaveBeenCalledTimes(1);
  });

  /** The number is the identity, so two entries are two tabs even from one
   *  archive — and the same number twice is one. */
  test("two entries of one archive are two tabs", async () => {
    const archive = archiveTab();
    await workspace.openEntry(archive, entry(3));
    await workspace.openEntry(archive, entry(4));
    expect(workspace.tabs).toHaveLength(3);
  });
});

describe("a tab closed while its document is still opening", () => {
  /**
   * A 500MB file spends seconds in `openPath`. The reader can close the tab in
   * that time, and the document then arrives with nobody left to close it —
   * holding its mmap and its index until the app exits. This is that leak.
   */
  test("the document that arrives late is closed rather than leaked", async () => {
    holdTheNextOpen();
    const opening = workspace.openPath("C:/huge.json");

    // The tab is on screen before the backend answers; the reader closes it.
    expect(workspace.tabs).toHaveLength(1);
    workspace.tabs = [];

    release?.();
    const tab = await opening;

    expect(tab).toBeNull();
    expect(closed).toHaveLength(1);
    expect(workspace.tabs).toHaveLength(0);
  });

  test("a tab still open keeps the document that arrives", async () => {
    const tab = await workspace.openPath("C:/a.json");
    expect(tab).not.toBeNull();
    expect(closed).toHaveLength(0);
    expect(workspace.tabs).toHaveLength(1);
  });
});

describe("invalidate drops everything derived from the old reading", () => {
  /**
   * A format or encoding switch re-indexes the document, and node ids do not
   * survive that. A selection kept across one names whichever node happens to
   * have taken that number — and the inspector, the path popover and the copied
   * path all follow it.
   */
  test("nothing derived survives", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.json" }));
    tab.html = "<p>rendered</p>";
    tab.toc = [{ level: 1, text: "t", id: "t" }] as never;
    tab.raw = "raw";
    tab.treeStats = { nodeCount: 3 } as never;
    tab.selectedNode = 42;
    tab.pendingRow = 7;
    tab.indexing = { done: 1, total: 2 };
    tab.error = "old failure";
    tab.tableStats = { rowCount: 9 } as never;
    tab.header = ["a"];
    tab.columnWidths = [100];
    tab.columnOrder = [2, 0, 1];
    tab.hiddenColumns = [1];
    tab.revealedColumn = 2;
    tab.frozenCount = 2;
    tab.selectedCell = { row: 1, column: 1 };
    tab.pendingCell = { row: 1, column: 1 };
    tab.history.visit(42);
    tab.search.query = "needle";
    tab.tableSearch.query = "needle";

    tab.invalidate();

    expect(tab.html).toBeNull();
    expect(tab.toc).toEqual([]);
    expect(tab.raw).toBeNull();
    expect(tab.treeStats).toBeNull();
    expect(tab.selectedNode).toBeNull();
    expect(tab.pendingRow).toBeNull();
    expect(tab.indexing).toBeNull();
    expect(tab.error).toBeNull();
    expect(tab.tableStats).toBeNull();
    expect(tab.header).toEqual([]);
    expect(tab.columnWidths).toEqual([]);
    expect(tab.columnOrder).toEqual([]);
    expect(tab.hiddenColumns).toEqual([]);
    expect(tab.revealedColumn).toBeNull();
    expect(tab.frozenCount).toBe(0);
    expect(tab.selectedCell).toBeNull();
    expect(tab.pendingCell).toBeNull();
    expect(tab.history.current).toBeNull();
    expect(tab.search.hits).toEqual([]);
    expect(tab.tableSearch.hits).toEqual([]);
  });

  /** What the tab *is* survives; only what was worked out about it goes. */
  test("the document itself is not forgotten", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.json" }));
    const id = tab.id;
    tab.invalidate();
    expect(tab.id).toBe(id);
    expect(tab.meta.source).toEqual({ type: "file", path: "C:/a.json" });
  });
});

describe("results that arrive for a query the reader has replaced", () => {
  /**
   * Search results stream back as events, and an event carries no proof of what
   * asked for it — cancelling does not unsend the batches already in flight.
   * Without the generation, the tail of an abandoned query lands in front of the
   * hits for the one the reader is waiting on.
   */
  test("beginning a search disowns the one before it", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.json" }));
    const first = tab.search.begin();
    const second = tab.search.begin();
    expect(second).not.toBe(first);
  });

  test("clearing the box also disowns what is in flight", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.json" }));
    const inFlight = tab.search.begin();
    tab.search.reset();
    expect(tab.search.seq).not.toBe(inFlight);
    expect(tab.search.running).toBe(false);
  });

  test("beginning clears what the last search left behind", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.json" }));
    tab.search.hits = [{ node: 1 }] as never;
    tab.search.current = 0;
    tab.search.error = "bad regex";
    tab.search.begin();
    expect(tab.search.hits).toEqual([]);
    expect(tab.search.current).toBe(-1);
    expect(tab.search.error).toBeNull();
    expect(tab.search.running).toBe(true);
  });

  /** The grid's search answers in one call, but starting a second still cancels
   *  the first — so the first comes back as a cancellation and must not blank
   *  the results of the one still running. */
  test("the grid's search carries the same guard", () => {
    const tab = new DocTab(meta({ type: "file", path: "C:/a.csv" }, "csv"));
    const first = tab.tableSearch.begin();
    expect(tab.tableSearch.searched).toBe(true);
    const second = tab.tableSearch.begin();
    expect(second).not.toBe(first);
  });
});

describe("the blank tab", () => {
  test('column defaults restore only the view configuration, preserving widths and table mode', () => {
    const tab = new DocTab(meta({ type: 'file', path: 'a.csv' }, 'csv'));
    expect([tab.columnOrder, tab.hiddenColumns, tab.revealedColumn]).toEqual([[], [], null]);
    tab.columnOrder = [1, 0]; tab.hiddenColumns = [0]; tab.revealedColumn = 1;
    tab.frozenCount = 1;
    tab.columnWidths = [100, 200]; tab.tableWidthMode = 'scroll';
    tab.resetColumnView();
    expect([tab.columnOrder, tab.hiddenColumns, tab.revealedColumn]).toEqual([[], [], null]);
    expect(tab.columnWidths).toEqual([100, 200]); expect(tab.tableWidthMode).toBe('scroll');
    expect(tab.frozenCount).toBe(0);
  });
  test("a second one is not made — an existing blank is raised", () => {
    const first = workspace.newTab();
    const second = workspace.newTab();
    expect(second).toBe(first);
    expect(workspace.tabs).toHaveLength(1);
  });

  /** Opening from a blank tab fills that tab in: it is where the reader
   *  started, so it is where they expect the document to land. */
  test("opening from it fills it in rather than adding another", async () => {
    const blank = workspace.newTab();
    await workspace.openPath("C:/a.json");
    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.tabs[0]).toBe(blank);
    expect(workspace.tabs[0].status).toBe("ready");
  });
});

test("source requests are shared and an old reply cannot fill a reinterpreted tab", async () => {
  const tab = new DocTab(meta({ type: "text" }, "markdown"));
  let answer!: (text: string) => void;
  const source = vi.spyOn(ipc, "docSourceText")
    .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
    .mockResolvedValueOnce("new");
  const first = tab.loadRaw();
  expect(tab.loadRaw()).toBe(first);
  tab.invalidate();
  expect(await tab.loadRaw()).toBe("new");
  answer("old");
  expect(await first).toBe("old");
  expect(tab.raw).toBe("new");
  expect(source).toHaveBeenCalledTimes(2);
  source.mockRestore();
});

test("code language choices survive raw switches and reset on reinterpretation", () => {
  const tab = new DocTab(meta({ type: "text" }, "markdown"));
  tab.codeSelections.set(0, "Rust");
  tab.mode = "raw";
  tab.mode = "rendered";
  expect(tab.codeSelections.get(0)).toBe("Rust");
  const revision = tab.markdownRevision;
  tab.invalidate();
  expect(tab.markdownRevision).toBe(revision + 1);
  expect(tab.codeSelections.size).toBe(0);
});

test('Markdown search keeps its query across views but clears it on reinterpretation', () => {
  const tab = new DocTab(meta({ type: 'text' }, 'markdown'));
  const search = tab.markdownSearch;
  search.open = true; search.query = 'needle'; search.how = 'regex'; search.caseSensitive = true;
  search.hits = 4; search.current = 2; search.capped = true; search.running = true;
  const seq = search.seq;
  search.reset();
  tab.mode = 'raw';
  expect([search.open, search.query, search.how, search.caseSensitive]).toEqual([true, 'needle', 'regex', true]);
  expect([search.hits, search.current, search.capped, search.running]).toEqual([0, -1, false, false]);
  expect(search.seq).toBeGreaterThan(seq);
  tab.invalidate();
  expect([search.open, search.query, search.hits]).toEqual([false, '', 0]);
});

test('table width defaults wait for settings and remain per tab after opening', async () => {
  const original = settings.tableWidthMode;
  let release!: () => void;
  const load = vi.spyOn(settings, 'load').mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
  try {
    settings.tableWidthMode = 'scroll';
    const pending = workspace.openPath('C:/reading.txt');
    await Promise.resolve(); settings.tableWidthMode = 'fill'; release();
    const first = (await pending)!;
    settings.tableWidthMode = 'scroll';
    const second = (await workspace.openPath('C:/next.txt'))!;
    expect(first.tableWidthMode).toBe('fill'); expect(second.tableWidthMode).toBe('scroll');
    first.tableFillRatios = [40, 60]; first.invalidate();
    expect(first.tableFillRatios).toBeNull(); expect(first.tableWidthMode).toBe('fill');
  } finally { load.mockRestore(); settings.tableWidthMode = original; }
});


test.each(['sqlite', 'xlsx', 'parquet', 'treeTable'] as const)('%s receives the width setting after loading, including derived tabs', async kind => {
  const original = settings.tableWidthMode;
  const parent = kind === 'treeTable' ? (await workspace.openPath('C:/parent.json'))! : null;
  settings.tableWidthMode = 'fill';
  const loaded = { ...meta({ type: 'file', path: 'C:/collection.' + kind }, kind), view: 'collection' as const };
  if (parent) vi.mocked(ipc.treeAsTable).mockResolvedValueOnce({ ...loaded, source: { type: 'treeSlice', parent: parent.id, generation: 0, node: 7, path: '$.items' } });
  else vi.mocked(ipc.openPath).mockResolvedValueOnce(loaded);
  const load = vi.spyOn(settings, 'load').mockImplementationOnce(async () => { settings.tableWidthMode = 'scroll'; });
  try {
    const tab = (parent ? await workspace.openTreeTable(parent, { id: 7, kind: 'array', key: 'items', index: null } as TreeRow) : await workspace.openPath(loaded.title))!;
    expect(tab.kind).toBe(kind);
    expect(tab.tableWidthMode).toBe('scroll');
    settings.tableWidthMode = 'fill';
    expect(tab.tableWidthMode).toBe('scroll');
  } finally { load.mockRestore(); settings.tableWidthMode = original; }
});

test('HTML frame metadata resets on reload while its search stays local to the view', () => {
  const tab = new DocTab(meta({type:'file',path:'C:/report.html'},'html'));
  tab.frameReady = true; tab.frameToc = [{id:'a',level:1,text:'A'}]; tab.frameScroll = 0.6;
  tab.frameBlocked = 3; tab.frameProbe = 'absent';
  tab.frameError = 'old error'; tab.frameUrlPort = '43123'; tab.frameLoaded = true;
  tab.frameServed = {html:1, agent:1, resource:2,last:[]}; tab.frameCsp = ['frame-src port 43123']; tab.frameAgentStarted = true;
  tab.frameStage = 'pagesinit';
  tab.frameStall = {readyState:'complete',l10n:'object',pdfViewer:false,preferences:true,initialized:false,
    options:0,locale:null,language:'en-US',fonts:'loaded',navigationStatus:null,resources:[],
    steps:{initialize:'pending',preferences:'pending',l10n:'not-started',components:'not-started'}};
  tab.frameSearch = {open:true,query:'find',n:3,index:2,request:7};
  tab.mode = 'raw';
  expect(tab.frameScroll).toBe(0.6);
  tab.invalidate();
  expect([tab.frameReady,tab.frameToc,tab.frameScroll,tab.frameBlocked,tab.frameProbe]).toEqual([false,[],0,0,null]);
  expect([tab.frameError,tab.frameUrlPort,tab.frameLoaded]).toEqual([null,null,false]);
  expect([tab.frameServed,tab.frameCsp,tab.frameAgentStarted]).toEqual([null,[],false]);
  expect(tab.frameStage).toBeNull();
  expect(tab.frameStall).toBeNull();
  expect(tab.frameSearch).toEqual({open:false,query:'',n:0,index:0,request:0});
});

test('external resources apply only after IPC succeeds and reload keeps the tab permission', async () => {
  const tab = new DocTab({...meta({type:'file',path:'C:/report.html'},'html'), generation:1});
  tab.frameReady = true; tab.frameReadyLoad = tab.frameQuery; tab.frameBlocked = 3;
  const before = tab.frameQuery;
  let finish!: () => void;
  vi.mocked(ipc.frameExternal).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = tab.setFrameExternal(true);
  expect([tab.frameToggling, tab.frameExternal, tab.frameQuery, tab.frameBlocked]).toEqual([true, false, before, 3]);
  await tab.setFrameExternal(true);
  expect(ipc.frameExternal).toHaveBeenCalledTimes(1);
  finish(); await pending;
  expect(ipc.frameExternal).toHaveBeenCalledWith(tab.id, true);
  expect([tab.frameExternal,tab.frameToggling,tab.frameReady,tab.frameReadyLoad,tab.frameBlocked]).toEqual([true,false,false,'',0]);
  expect(tab.frameQuery).not.toBe(before);
  const allowed = tab.frameQuery;
  tab.meta = {...tab.meta,generation:2}; tab.invalidate();
  expect(tab.frameExternal).toBe(true);
  expect(tab.frameQuery).not.toBe(allowed);
  await tab.setFrameExternal(false);
  expect([tab.frameExternal,tab.frameRevision]).toEqual([false,2]);
  expect(new DocTab(tab.meta).frameExternal).toBe(false);
});

test('a failed permission command leaves the loaded document and block count intact', async () => {
  const tab = new DocTab(meta({type:'text'},'html'));
  tab.frameReady = true; tab.frameReadyLoad = tab.frameQuery; tab.frameBlocked = 2;
  vi.mocked(ipc.frameExternal).mockRejectedValueOnce(new Error('rejected'));
  await expect(tab.setFrameExternal(true)).rejects.toThrow('rejected');
  expect([tab.frameExternal,tab.frameRevision,tab.frameToggling,tab.frameReady,tab.frameBlocked]).toEqual([false,0,false,true,2]);
  expect(tab.frameReadyLoad).toBe(tab.frameQuery);
});

test('relative HTML targets retain their anchor for FrameView to consume', async () => {
  const from = new DocTab({...meta({type:'file',path:'C:/docs/start.html'},'html'),baseDir:'C:/docs'});
  const loaded = {...meta({type:'file',path:'C:/docs/other.html'},'html'),view:'frame' as const};
  vi.mocked(ipc.openPath).mockResolvedValueOnce(loaded);
  const target = await workspace.openLink(from,'other.html#part');
  expect(target?.pendingAnchor).toBe('part');
  expect(target?.mode).toBe('rendered');
});
