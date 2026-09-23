/**
 * Driving the self-check from the frontend.
 *
 * The backend says what to open; this opens it the way a reader would — through
 * `workspace`, into a real view, over real IPC — and says how far it got. None
 * of the open pipeline is reimplemented here, because a harness that took a
 * shortcut past it would stop testing the thing it exists to test.
 *
 * Readiness is polled rather than awaited. Each view loads itself from an
 * effect when it mounts, so there is no promise to hold; what there is, is a
 * field on the tab that fills in. Polling for it is honest about that, and it
 * cannot deadlock — which matters, because two of the three defect classes this
 * harness targets are the event loop failing to turn.
 */
import * as ipc from "./ipc";
import {checkSessionPosition} from './sessionSmoke';
import {checkBookmarks} from './bookmarksSmoke';
import { checkHtmlFrame } from "./components/frame/smoke";
import {checkPdfFrame} from './components/frame/pdfSmoke';
import { frameDiagnostic } from './frame/diagnostics';
import { checkTextReading, checkTextRawVirtual } from "./components/table/smoke";
import { checkCollectionWidths } from "./components/collection/smoke";
import type { LaunchRequest, SmokeStep as Step } from "./ipc";
import { workspace, type DocTab } from "./state/docs.svelte";
import { checkMarkdownCopy, checkTableFit, checkTableRecommendation, checkToc, measureMarkdown } from "./components/markdown/smoke";
import { checkDiagramCopy, checkMathCopy } from './components/markdown/imageSmoke';
import { checkStyledCopy } from './components/markdown/styledSmoke';
import { checkStickyTables } from './components/markdown/stickySmoke';
import { checkRenderedSearch, checkRawSearch, checkSearchIndex, checkSearchWorker, checkReadingSearch, measureSearch, measureLargeSearch, measureTocScroll } from './components/markdown/searchSmoke';
import { enhanceTables } from "./components/markdown/enhance";
import { settings } from "./state/settings.svelte";

/**
 * How long one document may take before it counts as stuck.
 *
 * Generous, because the fixtures include the ones this app exists for and a
 * cold CI runner is slower than a warm desk. The runner outside has its own,
 * longer deadline for the whole process; this one is per document so a failure
 * can name which.
 */
const STEP_TIMEOUT_MS = 60_000;
/** How often to look. Roughly a frame — often enough not to skew timings. */
const POLL_MS = 16;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The view a tab has actually finished loading, or null while it is working. */
function readyView(tab: DocTab): string | null {
  switch (tab.view) {
    case "frame":
      return tab.frameReady ? "frame" : null;
    case "prose":
      return tab.html !== null ? "prose" : null;
    case "tree":
      return tab.treeStats !== null ? "tree" : null;
    case "table":
      return tab.tableStats !== null ? "table" : null;
    case "collection":
      return tab.collections.length > 0 ? "collection" : null;
    case "archive":
      // Not the entry count: an empty archive is ready and has none. The
      // encoding is written together with the list, and is never null after.
      return tab.nameEncoding !== null ? "archive" : null;
    default:
      return null;
  }
}

interface Outcome {
  metrics?: unknown;
  ok: boolean;
  stage: string;
  view?: string;
  error?: string;
}

/**
 * Wait for a tab to finish loading, fail, or run out of time.
 *
 * A loaded view beats an error, and the order matters. Some views carry both:
 * an archive whose single document was refused shows its list *and* a banner
 * saying why, and that is the correct outcome rather than a failure. Only when
 * nothing has loaded does an error mean the document did not open.
 */
async function settle(tab: DocTab, expect: string): Promise<Outcome> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const view = readyView(tab);
    if (view !== null) {
      return { ok: view === expect, stage: "ready", view, error: tab.error ?? undefined };
    }
    if (tab.error !== null) {
      // A document that was supposed to be refused has done what was asked.
      return { ok: expect === "error", stage: "error", error: tab.error };
    }
    await sleep(POLL_MS);
  }
  return { ok: false, stage: "timeout", ...(tab.view === 'frame' ? {error:frameDiagnostic(tab)} : {}) };
}

/**
 * The follow-ups a file alone does not reach.
 *
 * `openEntry` is the archive's real IPC path — clicking a row is a view
 * concern, but what it calls is this. `toggleHeader` is the one place a table's
 * shape changes under an open search, which is where the search has to be
 * discarded; that logic lives in a component, so this is the only layer that
 * can see it happen.
 */
async function follow(tab: DocTab, what: string): Promise<Outcome> {
  if (what === 'markdownTableFit') return {ok:true,stage:what,metrics:await checkTableFit(tab)};
  if (what === 'bookmarks') return {ok:true,stage:what,metrics:await checkBookmarks(tab)};
  if (what === 'sessionPosition') return {ok:true,stage:what,metrics:await checkSessionPosition(tab)};
  if (what === "htmlFrame") { return {ok:true,stage:what,metrics:await checkHtmlFrame(tab)}; }
  if (what === 'pdfFrame') { return {ok:true,stage:what,metrics:await checkPdfFrame(tab)}; }
  if (what === 'pdfOrientation' || what === 'pdfImageOrientation' || what === 'pdfImageOrientationCcw' || what === 'pdfImageUpright') {
    const kind = what === 'pdfOrientation' ? 'text' : what === 'pdfImageOrientation' ? 'image' : what === 'pdfImageOrientationCcw' ? 'image-ccw' : 'upright';
    return {ok:true,stage:what,metrics:await checkPdfFrame(tab,kind)};
  }
  if (what === 'relativeLinks') return checkRelativeLinks(tab);
  if (what === "collectionWidths") {
    await checkCollectionWidths(tab);
    return { ok: true, stage: what };
  }
  if (what === "textRawVirtual") {
    await checkTextRawVirtual(tab);
    return { ok: true, stage: what };
  }
  if (what === "textReading") {
    await checkTextReading(tab);
    return { ok: true, stage: what };
  }
  if (what === "treeAsTable") {
    const children = await ipc.treeChildren(tab.id, 0, 0, 100);
    const array = children?.rows.find((row) => row.key === "items");
    if (!array) return { ok: false, stage: what, error: "items array missing" };
    const opened = await workspace.openTreeTable(tab, array);
    if (!opened) return { ok: false, stage: what, error: tab.error ?? "did not open" };
    const ready = await settle(opened, "collection");
    if (!ready.ok) return { ...ready, stage: what };
    const stats = await ipc.treeTableStats(opened.id);
    const page = await ipc.gridRows(opened.id, 0, 2);
    const again = await workspace.openTreeTable(tab, array);
    await workspace.close(tab.id);
    let childClosed = false;
    try { await ipc.gridRows(opened.id, 0, 1); }
    catch (error) { childClosed = typeof error === "object" && error !== null && "code" in error && error.code === "noSuchDoc"; }
    const ok = stats.rowCount === 1500 && stats.firstRowNumber === 0 && stats.columns[0] === "id"
      && page.rows[0]?.index === 0 && page.rows[1]?.cells[0]?.text === "1"
      && again?.id === opened.id && childClosed && !workspace.tabs.includes(opened);
    return { ok, stage: what, view: opened.view, error: ok ? undefined : "derived grid, identity or lifetime mismatch" };
  }

  if (what === "openEntry") {
    const entry = tab.entries.find((candidate) => !candidate.encrypted);
    if (!entry) return { ok: false, stage: "openEntry", error: "nothing openable" };
    const opened = await workspace.openEntry(tab, entry);
    if (!opened) return { ok: false, stage: "openEntry", error: tab.error ?? "did not open" };
    const inside = await settle(opened, opened.view);
    return { ...inside, stage: `openEntry:${inside.stage}` };
  }

  if (what === "toggleHeader") {
    tab.tableSearch.query = "a";
    tab.tableSearch.hits = [{ row: 0, column: 0 }];
    const shape = await ipc.tableSetHasHeader(tab.id, !(tab.tableStats?.hasHeader ?? true));
    tab.tableStats = shape.stats;
    tab.header = shape.header;
    tab.tableSearch.reset();
    const discarded = tab.tableSearch.hits.length === 0;
    const sort = { column: 0, descending: true };
    const sorted = await ipc.gridOrder(tab.id, sort, "", null, ++tab.order.request);
    const ordered = await ipc.gridRows(tab.id, 0, sorted.shown);
    const numbers = ordered.rows.filter((row) => /^\d+$/.test(row.cells[0]?.text ?? ""));
    const descending = numbers.map((row) => row.cells[0].text).join(",") === "5,4,3,2,1";
    const query = "가나다"; // i18n-ignore: fixture cell, never interface text
    const otherColumn = await ipc.gridOrder(tab.id, sort, query, 0, ++tab.order.request);
    const stats = await ipc.gridOrder(tab.id, sort, query, 1, ++tab.order.request);
    tab.order.stats = stats;
    tab.order.sort = sort;
    tab.order.filter = query;
    tab.order.filterColumn = 1;
    const visible = await ipc.gridRows(tab.id, 0, 100);
    const hits = await ipc.gridSearch(tab.id, query, false, "literal");
    const copied = visible.rows[0] && await ipc.gridCellText(tab.id, visible.rows[0].index, 1);
    const filtered = otherColumn.shown === 0 && stats.shown === 1 && stats.shown < stats.total && copied?.text === query
      && hits.hits.length === 1 && hits.hits[0].row === 0;
    return {
      ok: discarded && descending && filtered,
      stage: "toggleHeader+gridOrder",
      error: !discarded ? "the search survived a change of shape"
        : !descending ? "numeric order mismatch" : !filtered ? "filter, copy or search coordinates mismatch" : undefined,
    };
  }

  return { ok: false, stage: what, error: "no such follow-up" };
}

/**
 * Open everything the plan lists, then end the process.
 *
 * Every document is reported as it finishes, so a run that dies part way still
 * says where it was — which is the whole reason the results are a file of lines
 * rather than one document written at the end.
 */
export async function runSmoke(): Promise<void> {
  const plan: Step[] = await ipc.smokePlan();

  // Nothing to open means this process is the listening half of the
  // single-instance round trip: another `dviewer` is about to hand it a
  // request, and what it has to report is whether that arrived. It waits, and
  // if nothing comes the runner outside kills it — a results file with no
  // summary line is what says so.
  if (plan.length === 0) {
    await ipc.smokeReport({ step: "listening" }, true);
    return;
  }

  for (const step of plan) {
    const started = Date.now();
    let outcome: Outcome;
    let metrics: unknown;

    const tab = await workspace.openPath(step.path);
    if (!tab) {
      // It did not open at all — which for some documents is the answer.
      outcome = {
        ok: step.expect === "error",
        stage: "open",
        error: workspace.notice ?? "did not open",
      };
      workspace.notice = null;
    } else {
      outcome = await settle(tab, step.expect);
      if (outcome.ok && step.file === "sample.md") {
        try {
          await checkMarkdownTables(tab);
          await checkMarkdownCopy(tab);
          await checkDiagramCopy();
          await checkMathCopy(tab);
          await checkStyledCopy(tab);
          await checkFocusMode(tab);
        } catch (error) {
          outcome = { ok: false, stage: "markdownTables", error: ipc.errorMessage(error) };
        }
      }
      if (outcome.ok && step.file === 'long-markdown.md') {
        try {
          await checkToc(tab);
          await checkSearchIndex();
          await checkSearchWorker();
          await checkRenderedSearch(tab);
          await checkRawSearch(tab);
          metrics = { ...await measureMarkdown(tab), search: await measureSearch(document.querySelector<HTMLElement>('article.markdown-body')!, 'Paragraph'), toc: await measureTocScroll(tab) };
        }
        catch (error) { outcome = { ok: false, stage: 'markdownBenchmark', error: ipc.errorMessage(error) }; }
      }
      if (outcome.ok && step.file === 'markdown-reading.md') {
        try { await checkStickyTables(); await checkReadingSearch(tab); }
        catch (error) { outcome = { ok: false, stage: 'markdownReading', error: ipc.errorMessage(error) }; }
      }
      if (outcome.ok && step.file === 'markdown-search-large.md') {
        try { metrics = { ...await measureMarkdown(tab), search: await measureLargeSearch(tab) }; }
        catch (error) { outcome = { ok: false, stage: 'markdownSearchLarge', error: ipc.errorMessage(error) }; }
      }
      if (outcome.ok && step.then) {
        try { outcome = await follow(tab, step.then); }
        catch (error) { outcome = { ok: false, stage: step.then, error: ipc.errorMessage(error) }; }
      }
    }

    await ipc.smokeReport(
      {
        file: step.file,
        metrics: metrics ?? outcome.metrics,
        expect: step.expect,
        stage: outcome.stage,
        view: outcome.view,
        error: outcome.error,
        ms: Date.now() - started,
      },
      outcome.ok,
    );
  }

  await ipc.smokeDone();
}

async function checkFocusMode(tab: DocTab): Promise<void> {
  const focused = () => document.body.hasAttribute('data-focus');
  const key = (target: EventTarget, key: string, ctrlKey = false) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
  // Start at the focused element so window capture precedes App's bubbling handler.
  const press = (name: string, ctrlKey = false) => key(document.activeElement ?? document.body, name, ctrlKey);
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('focus mode search did not settle');
      await sleep(POLL_MS);
    }
  };
  const saved = { focus: focused(), search: tab.markdownSearch.open, element: document.activeElement };
  const article = document.querySelector('main article');
  const toolbar = document.querySelector<HTMLButtonElement>('[data-focus-chrome] .toolbar button')!;
  try {
    if (focused()) press('F11');
    const focusButton = document.querySelector<HTMLButtonElement>('[data-action="focus"]')!;
    const exitButton = document.querySelector<HTMLButtonElement>('[data-action="focus-exit"]')!;
    focusButton.focus();
    focusButton.click();
    if (!focused() || !exitButton.getClientRects().length) throw new Error('focus button did not reveal the exit button');
    exitButton.focus();
    if (document.activeElement !== exitButton) throw new Error('focus exit button is not focusable');
    exitButton.click();
    if (focused() || exitButton.getClientRects().length || document.activeElement !== focusButton) {
      throw new Error('focus exit button did not exit or restore focus');
    }
    toolbar.focus();
    press('F11');
    if (!focused() || document.activeElement?.closest('[data-focus-chrome]')) throw new Error('focus entry or focus transfer failed');
    press('f', true);
    await waitFor(() => !!document.querySelector('.markdown-searchbar input'));
    const input = document.querySelector<HTMLInputElement>('.markdown-searchbar input')!;
    key(input, 'Escape');
    if (!focused() || tab.markdownSearch.open) throw new Error('search Escape also exited focus mode');
    press('Escape');
    if (focused() || document.querySelector('main article') !== article || document.activeElement !== toolbar) {
      throw new Error('focus exit remounted the document or failed to restore focus');
    }
    document.querySelector<HTMLButtonElement>('[data-action="page-width"]')!.click();
    await waitFor(() => !!document.querySelector('[data-focus-chrome] .menu button'));
    const option = document.querySelector<HTMLButtonElement>('[data-focus-chrome] .menu button')!;
    option.focus();
    press('F11');
    if (!focused() || document.activeElement?.closest('[data-focus-chrome]')) throw new Error('hidden toolbar menu retained focus');
    press('Escape');
    if (focused()) throw new Error('hidden menu consumed the app Escape');
    if (document.activeElement !== option) throw new Error('focus exit did not restore the menu option');
    key(option, 'Escape');
    await waitFor(() => !document.querySelector('[data-focus-chrome] .menu'));
  } finally {
    if (focused() !== saved.focus) press('F11');
    tab.markdownSearch.open = saved.search;
    if (saved.element instanceof HTMLElement && saved.element.isConnected) saved.element.focus({ preventScroll: true });
  }
}

async function checkRelativeLinks(from: DocTab): Promise<Outcome> {
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('relative link did not finish opening');
      await sleep(POLL_MS);
    }
  };
  const click = async (href: string) => {
    workspace.activate(from.id);
    const find = () => document.querySelector<HTMLAnchorElement>(`article.markdown-body a[href="${href}"]`);
    await waitFor(() => !!find());
    find()!.click();
    await waitFor(() => workspace.active !== from && workspace.active !== null
      && workspace.active.status !== 'opening');
    return workspace.active!;
  };
  const json = await click('./small.json');
  if (json.status !== 'ready' || json.kind !== 'json') throw new Error('relative JSON link did not open a ready tab');
  const ready = await settle(json, 'tree');
  if (!ready.ok) return ready;
  if (await click('./small.json') !== json) throw new Error('relative link duplicated the JSON tab');

  const markdown = await click('./relative%20links/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.md#target');
  const prose = await settle(markdown, 'prose');
  if (!prose.ok) return prose;
  await waitFor(() => markdown.pendingAnchor === null && markdown.scrollTop > 0
    && !!document.querySelector('article.markdown-body #target'));

  const failed = await click('./m41-missing.json');
  if (failed.status !== 'error' || !failed.error || from.error || !workspace.tabs.includes(from)) {
    throw new Error('missing relative file did not leave an error tab and intact source');
  }
  await waitFor(() => document.querySelector('main [role="alert"]')?.textContent === failed.error);
  await workspace.close(failed.id);
  await workspace.close(markdown.id);
  await workspace.close(json.id);
  workspace.activate(from.id);
  return { ok: true, stage: 'relativeLinks', view: 'prose' };
}

/** This uses the rendered fixture, including hidden and unsupported HTML tables. */
async function checkMarkdownTables(tab: DocTab) {
  await checkTableRecommendation();
  const require = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("markdown table DOM did not settle");
      await sleep(POLL_MS);
    }
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const root = () => document.querySelector<HTMLElement>(".markdown-body")!;
  await waitFor(() => root()?.querySelectorAll(".table-wrap").length === 5);
  const host = root();
  const handle = enhanceTables(host, tab.tables, tab.markdownTableMode);
  require(enhanceTables(host, tab.tables, tab.markdownTableMode) === handle, "table enhancement was not idempotent");
  require(host.querySelectorAll(".table-wrap").length === 5, "table wrappers were duplicated");
  require(!host.querySelector(".table-wrap .table-wrap"), "nested tables were enhanced");
  require(!host.querySelector(".table-wrap [colspan], .table-wrap [rowspan]"), "merged table was enhanced");
  for (const wrap of host.querySelectorAll<HTMLElement>(".table-wrap")) {
    const table = wrap.querySelector("table")!;
    require(table.querySelectorAll(":scope > colgroup > col").length === table.rows[0].cells.length, "colgroup does not match first row");
    require(table.querySelectorAll(".table-grip").length === table.rows[0].cells.length, "column handles do not match first row");
  }

  const wrap = host.querySelector<HTMLElement>(".table-wrap")!;
  const table = wrap.querySelector("table")!;
  const viewport = wrap.querySelector<HTMLElement>(".table-viewport")!;
  const toggle = wrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!;
  const reset = wrap.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
  const recommend = wrap.querySelector<HTMLButtonElement>('[data-action="recommend"]')!;
  const grip = wrap.querySelector<HTMLElement>(".table-grip")!;
  const firstCell = table.rows[0].cells[0];
  const widths = () => [...table.rows[0].cells].map((cell) => cell.getBoundingClientRect().width);
  const key = (target: HTMLElement, key: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const close = (a: number, b: number) => Math.abs(a - b) < 1;
  const state = tab.tables.get(Number(wrap.dataset.table))!;
  if (state.mode !== "scroll") toggle.click();
  require(recommend.disabled, 'recommendation was enabled in scrolling mode');
  key(grip, "ArrowRight");
  require(state.scrollWidths && !reset.disabled, "keyboard resize did not save scroll widths");
  const scrollWidths = [...state.scrollWidths!];
  const originalTotal = table.getBoundingClientRect().width;
  key(grip, "ArrowRight");
  require(close(table.getBoundingClientRect().width, originalTotal + 8), "scroll resize did not grow the table");
  toggle.click();
  const fillBefore = widths();
  key(grip, "ArrowRight");
  const fillAfter = widths();
  require(close(fillAfter[0], fillBefore[0] + 8) && close(fillAfter[1], fillBefore[1] - 8), "fill resize did not compensate its neighbor");
  require(state.fillRatios && close(state.fillRatios.reduce((sum, value) => sum + value, 0), 100), "fill ratios do not total 100");
  require(close(table.getBoundingClientRect().width, viewport.clientWidth), "fill did not match the document width");
  require(table.rows[0].cells[0] === firstCell, "resizing replaced the table DOM");
  key(grip, "Home");
  const minimum = 3 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  require(close(widths()[0], minimum), "minimum column width was not enforced");
  const fitted = widths()[0];
  key(grip, "Enter");
  require(widths()[0] > fitted, "content fitting did not use the natural width");
  const ratios = [...state.fillRatios!];
  toggle.click();
  require(close(widths()[0], scrollWidths[0] + 8), "scroll widths were lost across mode changes");
  toggle.click();
  require(JSON.stringify(state.fillRatios) === JSON.stringify(ratios), "fill ratios were lost across mode changes");
  require(!recommend.disabled, 'recommendation was disabled in fill mode');
  const savedScroll = JSON.stringify(state.scrollWidths);
  recommend.click();
  require(!state.fillRatios && JSON.stringify(state.scrollWidths) === savedScroll, 'recommendation cleared scroll widths or retained manual fill');
  require(widths().every((width, i) => close(width, fillBefore[i])), 'recommendation did not restore automatic widths');
  reset.click();
  require(state.mode === "fill" && !state.scrollWidths && !state.fillRatios && reset.disabled, "reset changed the mode or kept manual widths");

  const wide = [...host.querySelectorAll<HTMLTableElement>(".table-wrap table")].find((candidate) => candidate.rows[0].cells.length === 12)!;
  const wideWrap = wide.closest<HTMLElement>(".table-wrap")!;
  const wideState = tab.tables.get(Number(wideWrap.dataset.table))!;
  if (wideState.mode !== "fill") wideWrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!.click();
  require([...wide.rows[0].cells].every((cell) => cell.getBoundingClientRect().width >= minimum - 1), "wide table violated minimum widths");
  const wideViewport = wide.parentElement!;
  require(wideViewport.scrollWidth >= 12 * minimum - 1, "wide table did not preserve minimum total width");

  const single = [...host.querySelectorAll<HTMLTableElement>(".table-wrap table")].find((candidate) => candidate.rows[0].cells.length === 1)!;
  const singleWrap = single.closest<HTMLElement>(".table-wrap")!;
  if (tab.tables.get(Number(singleWrap.dataset.table))!.mode !== "fill") singleWrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!.click();
  require(single.querySelector(".table-grip")?.getAttribute("aria-disabled") === "true", "single fill column was resizable");

  const details = host.querySelector("details")!;
  const hiddenWrap = details.querySelector<HTMLElement>(".table-wrap")!;
  if (tab.tables.get(Number(hiddenWrap.dataset.table))!.mode !== "fill") hiddenWrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!.click();
  const hiddenCols = [...hiddenWrap.querySelectorAll<HTMLTableColElement>("col")];
  details.open = true;
  // Two frames can finish before toggle/ResizeObserver's queued layout applies widths.
  await waitFor(() => hiddenCols.every((col) => col.style.width !== ""));
  require(hiddenCols.every((col) => parseFloat(col.style.width) >= minimum - 1), "opened details table has invalid widths");

  const font = settings.docFontPx;
  settings.docFontPx = font + 1;
  await frame();
  require(table.rows[0].cells[0] === firstCell && state.mode === "fill", "font refresh replaced the DOM or reset the mode");
  settings.docFontPx = font;
  tab.mode = "raw";
  await waitFor(() => !document.querySelector(".markdown-body"));
  tab.mode = "rendered";
  await waitFor(() => root()?.querySelectorAll(".table-wrap").length === 5);
  require(tab.tables.get(0)?.mode === "fill" && root().querySelector<HTMLElement>(".table-wrap")?.dataset.mode === "fill", "raw round trip lost table state");
}

/**
 * A request delivered by a second `dviewer`, in the listening process.
 *
 * This is the whole single-instance contract from the receiving side: the other
 * process handed its arguments over and exited, and only this one can say they
 * arrived. A defect here is invisible until someone opens a file from a shell.
 *
 * The arrival is an **event**, and an event nobody is listening for is simply
 * lost. That is why the process writes a `listening` line first and the runner
 * waits for it: a fixed pause before handing over is a guess about how long a
 * webview takes to boot, and on a cold runner it is the wrong guess.
 */
export async function reportDelivery(request: LaunchRequest): Promise<void> {
  const arrived = request.files.length + request.urls.length;
  await ipc.smokeReport(
    { step: "delivery", files: request.files, urls: request.urls },
    arrived > 0,
  );
  await ipc.smokeDone();
}

/**
 * A window that was built to answer `--new`: it opens what it was given, says
 * so, and then closes itself.
 *
 * The failure this covers put an empty frame on screen: the window was created
 * on the event loop's own thread, so the webview never attached and the second
 * process never got its answer either. A window that reaches this line is a
 * window that booted — and one that opened the file it was handed, which is
 * what the frame was empty of.
 *
 * Closing rather than calling `smokeDone` is the other half. What happens when
 * a window goes away — its documents being reclaimed, its panels closed — lives
 * in a Tauri event handler that no unit test can reach, and exiting while the
 * window still stands would step over it. So the run ends from inside that
 * handler instead; see `smoke_close_self`.
 *
 * The close waits for the view to be ready on purpose. Closing mid-open would
 * exercise the *race* between opening and destruction, and a race decided by
 * timing makes a check that passes on some runs — that one is held down by
 * `state.rs` instead.
 */
export async function reportNewWindow(label: string, request: LaunchRequest): Promise<void> {
  const wanted = request.files.length + request.urls.length;
  let opened = 0;
  let ready: Outcome = { ok: wanted > 0, stage: "none" };

  for (const path of request.files) {
    const tab = await workspace.openPath(path);
    if (!tab) {
      ready = { ok: false, stage: "open", error: workspace.notice ?? "did not open" };
      break;
    }
    opened += 1;
    ready = await settle(tab, tab.view);
    if (!ready.ok) break;
  }

  await ipc.smokeReport(
    {
      step: "newWindow",
      window: label,
      files: request.files,
      opened,
      stage: ready.stage,
      view: ready.view,
      error: ready.error,
    },
    wanted > 0 && opened === request.files.length && ready.ok,
  );
  await ipc.smokeCloseSelf();
}
