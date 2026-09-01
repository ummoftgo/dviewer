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
import type { DocKind, DocMeta, DocSource } from "../ipc";

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
  };
});

const { DocTab, workspace } = await import("./docs.svelte");
const ipc = await import("../ipc");

beforeEach(() => {
  workspace.tabs = [];
  workspace.activeId = null;
  workspace.notice = null;
  closed.length = 0;
  gate = null;
  release = null;
  vi.mocked(ipc.openPath).mockClear();
});

describe("opening a file that is already open", () => {
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
