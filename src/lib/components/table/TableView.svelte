<script lang="ts">
  /**
   * CSV and TSV as a virtualised grid.
   *
   * Same shape as the tree view — fixed row height, absolutely positioned rows,
   * a window fetched from Rust — because the constraint is the same: the file
   * can be larger than memory, so only what is on screen may ever be built.
   *
   * What differs is the second axis. Columns have widths the reader can drag,
   * and both the header row and the row-number column stay pinned while the
   * grid scrolls under them; losing either one in a wide export is what makes
   * spreadsheets in a text editor unreadable.
   */
  import { untrack } from "svelte";
  import Icon from "../Icon.svelte";
  import { n, t, type MessageKey } from "../../i18n";
  import ContextMenu from "../ContextMenu.svelte";
  import EscapedText from "../EscapedText.svelte";
  import TableSearchBar from "./TableSearchBar.svelte";
  import {
    errorMessage,
    tableCellText,
    tableOpen,
    tableRowText,
    tableRows,
    tableSetHasHeader,
    type TableRow,
  } from "../../ipc";
  import {
    columnLeft,
    columnWidth as widthOf,
    measureColumns as autoWidths,
    startResize as beginResize,
    totalWidth as totalOf,
  } from "./columns";
  import { copyText } from "../../clipboard";
  import { toasts } from "../../state/toast.svelte";
  import type { MenuItem } from "../menu";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";
  import { anchorRow, rowTop, scrollTopForRow, spacerHeight } from "../../virtual";

  interface Props {
    tab: DocTab;
    /** Exposed upward so the global Ctrl+F shortcut can reach the search box. */
    focusSearch?: (() => void) | null;
  }

  let { tab, focusSearch = $bindable(null) }: Props = $props();

  /** Extra rows fetched above and below the viewport to hide scroll latency. */
  const OVERSCAN = 24;

  let viewport = $state<HTMLElement>();
  /** Mirrored into state because row positions depend on them once the file
   *  outgrows the browser's maximum element height — see lib/virtual.ts. */
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let searchBar = $state<ReturnType<typeof TableSearchBar>>();
  let rows = $state<TableRow[]>([]);
  let windowStart = $state(0);
  let requestSeq = 0;
  let menu = $state<{ x: number; y: number; row: number; column: number } | null>(null);

  $effect(() => {
    focusSearch = searchBar ? () => searchBar?.focus() : null;
    return () => {
      focusSearch = null;
    };
  });

  const rowHeight = $derived(
    Math.max(18, Math.round(settings.docFontPx * settings.uiScale * 1.7)),
  );
  const rowCount = $derived(tab.tableStats?.rowCount ?? 0);
  const metrics = $derived({ rowHeight, totalRows: rowCount, viewportHeight });
  const columnCount = $derived(tab.tableStats?.columnCount ?? 0);
  /** Wide enough for the largest row number the file can produce. */
  const numberWidth = $derived(
    Math.max(44, Math.round(String(rowCount).length * settings.docFontPx * settings.uiScale * 0.65) + 18),
  );
  const totalWidth = $derived(totalOf(tab, numberWidth));
  const progressPercent = $derived(
    tab.indexing && tab.indexing.total > 0
      ? Math.min(100, Math.round((tab.indexing.done / tab.indexing.total) * 100))
      : 0,
  );

  // Kick off indexing the first time a grid tab is shown.
  $effect(() => {
    const target = tab;
    if (target.tableStats || target.indexing || target.error) return;
    target.indexing = { done: 0, total: target.meta.byteLen };
    tableOpen(target.id).catch((err) => {
      target.error = errorMessage(err);
      target.indexing = null;
    });
  });

  // Anything that changes the grid's shape invalidates the cached window. The
  // dependencies are listed explicitly and the call untracked so that reading
  // `rows` inside ensureWindow cannot make this effect retrigger itself.
  /**
   * Put the reader back where they were.
   *
   * Only once — and only once there is something to scroll, since the spacer
   * has no height before the stats arrive. The view is rebuilt per tab
   * (`{#key active.id}` in App.svelte), so this runs again for the next one.
   */
  let restored = false;
  $effect(() => {
    if (restored || !viewport || !tab.tableStats) return;
    restored = true;
    viewport.scrollTop = tab.tableScrollTop;
    untrack(() => void ensureWindow(true));
  });

  $effect(() => {
    void tab.tableStats;
    void rowHeight;
    void viewport;
    untrack(() => void ensureWindow(true));
  });

  $effect(() => {
    const cell = tab.pendingCell;
    if (!cell || !viewport || !tab.tableStats) return;
    tab.pendingCell = null;
    tab.selectedCell = cell;
    // Park the target a third of the way down rather than at the very top.
    measure();
    viewport.scrollTop = scrollTopForRow(
      metrics,
      Math.max(0, cell.row - Math.floor(visibleCount() / 3)),
    );
    scrollColumnIntoView(cell.column);
    void ensureWindow(true);
  });

  function visibleCount() {
    return Math.ceil((viewport?.clientHeight ?? 0) / rowHeight) + 1;
  }

  /** Re-read the scroll box and refresh the window it implies. */
  function measure() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    viewportHeight = viewport.clientHeight;
  }

  async function ensureWindow(force = false) {
    const stats = tab.tableStats;
    if (!stats || !viewport) return;

    measure();
    const first = Math.max(0, Math.floor(anchorRow(metrics, viewport.scrollTop)));
    const last = Math.min(stats.rowCount, first + visibleCount());
    if (!force && first >= windowStart && last <= windowStart + rows.length) return;

    const start = Math.max(0, first - OVERSCAN);
    const count = Math.min(stats.rowCount - start, visibleCount() + OVERSCAN * 2);
    if (count <= 0) {
      rows = [];
      windowStart = 0;
      return;
    }

    const seq = ++requestSeq;
    try {
      const page = await tableRows(tab.id, start, count);
      // A later scroll has already superseded this request.
      if (seq !== requestSeq) return;
      windowStart = start;
      rows = page.rows;
      if (tab.columnWidths.length !== stats.columnCount) measureColumns(page.rows);
    } catch (err) {
      if (seq === requestSeq) tab.error = errorMessage(err);
    }
  }

  function onScroll(event: Event) {
    tab.tableScrollTop = (event.currentTarget as HTMLElement).scrollTop;
    measure();
    menu = null;
    void ensureWindow();
  }

  // --- columns ------------------------------------------------------------

  function measureColumns(sample: TableRow[]) {
    autoWidths(tab, sample, columnCount, settings.docFontPx * settings.uiScale);
  }

  function columnWidth(column: number) {
    return widthOf(tab, column);
  }

  function scrollColumnIntoView(column: number) {
    if (!viewport) return;
    const left = columnLeft(tab, column, numberWidth);
    const right = left + columnWidth(column);
    if (left - numberWidth < viewport.scrollLeft) viewport.scrollLeft = left - numberWidth;
    else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = right - viewport.clientWidth;
    }
  }

  function startResize(event: PointerEvent, column: number) {
    beginResize(event, tab, column);
  }

  // --- header row ---------------------------------------------------------

  async function toggleHeader() {
    try {
      const shape = await tableSetHasHeader(tab.id, !(tab.tableStats?.hasHeader ?? true));
      tab.tableStats = shape.stats;
      tab.header = shape.header;
      tab.selectedCell = null;
      tab.columnWidths = [];
      if (viewport) viewport.scrollTop = 0;
      await ensureWindow(true);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  function columnName(column: number): string {
    const name = tab.header[column];
    // Without a header row the columns still need labels, and their position is
    // the only name they have.
    return name && name.length > 0 ? name : String(column + 1);
  }

  // --- copying ------------------------------------------------------------

  async function copyCell(row: number, column: number) {
    try {
      const cell = await tableCellText(tab.id, row, column);
      await copyText(cell.text);
      toasts.show(cell.truncated ? t("toast.valueTruncated") : t("toast.valueCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  async function copyRow(row: number) {
    try {
      const line = await tableRowText(tab.id, row);
      await copyText(line.text);
      toasts.show(t("toast.rowCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  async function copyColumnName(column: number) {
    try {
      await copyText(columnName(column));
      toasts.show(t("toast.columnCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  function openMenu(event: MouseEvent, row: number, column: number) {
    event.preventDefault();
    tab.selectedCell = { row, column };
    menu = { x: event.clientX, y: event.clientY, row, column };
  }

  const menuItems = $derived.by((): MenuItem[] => {
    if (!menu) return [];
    const { row, column } = menu;
    return [
      { label: t("table.copyValue"), action: () => void copyCell(row, column), hint: "Ctrl C" },
      { label: t("table.copyRow"), action: () => void copyRow(row) },
      { label: t("table.copyColumn"), action: () => void copyColumnName(column) },
    ];
  });

  /** Whether a cell is the search hit the grid is currently parked on. */
  function isHit(row: number, column: number): boolean {
    const search = tab.tableSearch;
    const current = search.hits[search.current];
    return current !== undefined && current.row === row && current.column === column;
  }

  // --- keyboard -----------------------------------------------------------

  function move(rowDelta: number, columnDelta: number) {
    const cell = tab.selectedCell ?? { row: -1, column: 0 };
    const row = Math.min(rowCount - 1, Math.max(0, cell.row + rowDelta));
    const column = Math.min(columnCount - 1, Math.max(0, cell.column + columnDelta));
    tab.selectedCell = { row, column };
    scrollRowIntoView(row);
    scrollColumnIntoView(column);
  }

  function scrollRowIntoView(row: number) {
    if (!viewport) return;
    measure();
    const top = rowTop(metrics, viewport.scrollTop, row);
    const bottom = top + rowHeight;
    // The sticky header covers the top of the scroll box, so a row parked
    // exactly at scrollTop would sit underneath it.
    if (top - rowHeight < viewport.scrollTop) {
      viewport.scrollTop = scrollTopForRow(metrics, Math.max(0, row - 1));
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = scrollTopForRow(metrics, row - visibleCount() + 2);
    }
    void ensureWindow();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "c" && tab.selectedCell) {
        event.preventDefault();
        void copyCell(tab.selectedCell.row, tab.selectedCell.column);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        move(0, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(0, -1);
        break;
      case "PageDown":
        event.preventDefault();
        move(visibleCount() - 1, 0);
        break;
      case "PageUp":
        event.preventDefault();
        move(-(visibleCount() - 1), 0);
        break;
      case "Home":
        event.preventDefault();
        move(-rowCount, -columnCount);
        break;
      case "End":
        event.preventDefault();
        move(rowCount, columnCount);
        break;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
</script>

<svelte:window onresize={() => void ensureWindow(true)} />

<div class="table-view">
  <TableSearchBar {tab} bind:this={searchBar} />

  {#if tab.error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {tab.error}
    </p>
  {/if}

  {#if !tab.tableStats && !tab.error}
    <div class="loading">
      <p>
        {t("table.indexing", {
          done: formatBytes(tab.indexing?.done ?? 0),
          total: formatBytes(tab.meta.byteLen),
        })}
      </p>
      <div class="bar"><div class="fill" style="width: {progressPercent}%"></div></div>
    </div>
  {/if}

  {#if tab.tableStats}
    <div class="toolbar">
      <button
        class="btn toggle"
        class:on={tab.tableStats.hasHeader}
        aria-pressed={tab.tableStats.hasHeader}
        onclick={toggleHeader}
        title={t("table.header.title")}
      >
        <Icon name="list" size={13} />
        {t("table.header")}
        <span class="state">{tab.tableStats.hasHeader ? t("state.on") : t("state.off")}</span>
      </button>

      <span class="spacer"></span>

      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() => tab.selectedCell && copyCell(tab.selectedCell.row, tab.selectedCell.column)}
      >
        <Icon name="copy" size={13} />
        {t("table.copyValue")}
      </button>
      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() => tab.selectedCell && copyRow(tab.selectedCell.row)}
      >
        {t("table.copyRow")}
      </button>
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="grid"
      bind:this={viewport}
      onscroll={onScroll}
      onkeydown={onKeydown}
      tabindex="0"
      role="grid"
      aria-rowcount={rowCount}
      aria-colcount={columnCount}
      aria-label={t("table.label", { title: tab.meta.title })}
      style="--row-height: {rowHeight}px; --number-width: {numberWidth}px"
    >
      <div class="head" style="width: {totalWidth}px" role="row">
        <div class="cell num" role="columnheader"></div>
        {#each { length: columnCount } as _, column (column)}
          <div class="cell" style="width: {columnWidth(column)}px" role="columnheader">
            <span class="name" title={columnName(column)}>{columnName(column)}</span>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class="grip"
              onpointerdown={(e) => startResize(e, column)}
              ondblclick={() => measureColumns(rows)}
              title={t("table.resize")}
            ></span>
          </div>
        {/each}
      </div>

      <div class="body" style="height: {spacerHeight(metrics)}px; width: {totalWidth}px">
        {#each rows as row (row.index)}
          <div class="row" style="top: {rowTop(metrics, scrollTop, row.index)}px" role="row">
            <div class="cell num" role="rowheader">{n(row.index + 1)}</div>
            {#each { length: columnCount } as _, column (column)}
              {@const cell = row.cells[column]}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div
                class="cell"
                class:selected={tab.selectedCell?.row === row.index &&
                  tab.selectedCell?.column === column}
                class:hit={isHit(row.index, column)}
                style="width: {columnWidth(column)}px"
                role="gridcell"
                tabindex="-1"
                title={cell?.text ?? ""}
                onclick={() => (tab.selectedCell = { row: row.index, column })}
                oncontextmenu={(e) => openMenu(e, row.index, column)}
              >
                <EscapedText text={cell?.text ?? ""} />{#if cell?.truncated}<span
                    class="ellipsis"
                    title={t("tree.truncated")}>…</span
                  >{/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="status">
      <span>
        {t("table.status.size", {
          rows: n(tab.tableStats.rowCount),
          columns: n(columnCount),
        })}
      </span>
      <span>
        {t("table.status.delimiter", {
          name: t(`delimiter.${tab.tableStats.delimiter}` as MessageKey),
        })}
      </span>
      <span>{t("table.status.index", { size: formatBytes(tab.tableStats.indexBytes) })}</span>
      {#if tab.tableStats.truncated}
        <span class="warn">{t("table.status.truncated")}</span>
      {/if}
      {#if tab.selectedCell}
        <span class="spacer"></span>
        <span class="where">
          {t("table.status.where", {
            row: n(tab.selectedCell.row + 1),
            column: columnName(tab.selectedCell.column),
          })}
        </span>
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => (menu = null)} />
{/if}

<style>
  .table-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .spacer {
    flex: 1;
  }

  .toggle.on {
    background: var(--accent-subtle);
    color: var(--accent);
    border-color: var(--accent);
  }

  .toggle .state {
    margin-left: 0.15rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--bg-inset);
    color: var(--text-muted);
    font-size: 0.8em;
  }

  .toggle.on .state {
    background: var(--accent);
    color: var(--bg);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.5rem 0.8rem;
  }

  .banner.error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }

  .loading {
    padding: 1.2rem 0.9rem;
    color: var(--text-muted);
  }

  .loading p {
    margin: 0 0 0.5rem;
    font-variant-numeric: tabular-nums;
  }

  .bar {
    height: 3px;
    border-radius: 999px;
    background: var(--bg-inset);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s linear;
  }

  .grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    font-family: var(--font-code);
    font-size: var(--doc-font-size);
  }

  /* Sticky in both directions: a wide export loses its meaning the moment the
     column names or the row numbers scroll away. */
  .head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    height: var(--row-height);
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-strong);
  }

  .body {
    position: relative;
  }

  .row {
    position: absolute;
    left: 0;
    display: flex;
    height: var(--row-height);
  }

  /* Zebra striping: with many narrow columns the eye loses the row on the way
     across, and a stripe is cheaper to follow than a rule. */
  .row:nth-child(even) {
    background: var(--bg-inset);
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .cell {
    flex: none;
    padding: 0 0.5rem;
    line-height: var(--row-height);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-right: 1px solid var(--border);
  }

  .head .cell {
    position: relative;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-weight: 600;
  }

  .head .name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell.num {
    position: sticky;
    left: 0;
    z-index: 1;
    width: var(--number-width);
    background: var(--bg-subtle);
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
    border-right: 1px solid var(--border-strong);
  }

  .head .cell.num {
    z-index: 3;
  }

  .cell.selected {
    background: var(--accent-subtle);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* The match the search is parked on, in the same colour the tree uses for
     the same thing. */
  .cell.hit {
    background: var(--match-active);
    color: #1b1300;
  }

  .ellipsis {
    color: var(--text-muted);
  }

  .grip {
    position: absolute;
    top: 0;
    right: -3px;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
  }

  .grip:hover {
    background: var(--accent);
  }

  .status .warn {
    color: var(--danger);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.25rem 0.7rem;
    border-top: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }

  .status .where {
    color: var(--text);
  }
</style>
