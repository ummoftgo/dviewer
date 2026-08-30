<script lang="ts">
  /**
   * Rows and columns, windowed.
   *
   * Same shape as the tree view — fixed row height, absolutely positioned rows,
   * a window fetched from Rust — because the constraint is the same: the thing
   * being read can be larger than memory, so only what is on screen may ever be
   * built.
   *
   * What differs is the second axis. Columns have widths the reader can drag,
   * and both the header row and the row-number column stay pinned while the
   * grid scrolls under them; losing either one in a wide export is what makes
   * spreadsheets in a text editor unreadable.
   *
   * It does not know what it is drawing. A delimited file's rows are spans of
   * its own bytes and a database's come back from a query, but both answer the
   * same commands (`grid_rows` and friends), so the difference stops at the
   * Rust boundary. What the host supplies is what only the host can know: how
   * many rows and columns there are, what to call a column, and whether a cell
   * carries a tone.
   */
  import { untrack } from "svelte";
  import { shortcutKey } from "../../keys";
  import { n, t } from "../../i18n";
  import ContextMenu from "../ContextMenu.svelte";
  import EscapedText from "../EscapedText.svelte";
  import {
    errorMessage,
    gridCellText,
    gridRowText,
    gridRows,
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
    rowCount: number;
    columnCount: number;
    /** What to write above a column. Position, header text, log field, or the
     *  database's own name — the host knows which. */
    columnName: (column: number) => string;
    /** A tone for a cell, or undefined for the ordinary ones. */
    cellTone?: (column: number, text: string | undefined) => string | undefined;
    label: string;
  }

  let { tab, rowCount, columnCount, columnName, cellTone, label }: Props = $props();

  /** Extra rows fetched above and below the viewport to hide scroll latency. */
  const OVERSCAN = 24;

  let viewport = $state<HTMLElement>();
  /** Mirrored into state because row positions depend on them once the file
   *  outgrows the browser's maximum element height — see lib/virtual.ts. */
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let rows = $state<TableRow[]>([]);
  let windowStart = $state(0);
  let requestSeq = 0;
  let menu = $state<{ x: number; y: number; row: number; column: number } | null>(null);

  const rowHeight = $derived(
    Math.max(18, Math.round(settings.docFontPx * settings.uiScale * 1.7)),
  );
  const metrics = $derived({ rowHeight, totalRows: rowCount, viewportHeight });
  /** Wide enough for the largest row number the file can produce. */
  const numberWidth = $derived(
    Math.max(44, Math.round(String(rowCount).length * settings.docFontPx * settings.uiScale * 0.65) + 18),
  );
  const totalWidth = $derived(totalOf(tab, numberWidth));

  /**
   * Put the reader back where they were.
   *
   * Only once — and only once there is something to scroll, since the spacer
   * has no height before the row count arrives. The view is rebuilt per tab
   * (`{#key active.id}` in App.svelte), so this runs again for the next one.
   */
  let restored = false;
  $effect(() => {
    if (restored || !viewport || rowCount === 0) return;
    restored = true;
    viewport.scrollTop = tab.tableScrollTop;
    untrack(() => void ensureWindow(true));
  });

  // Anything that changes the grid's shape invalidates the cached window. The
  // dependencies are listed explicitly and the call untracked so that reading
  // `rows` inside ensureWindow cannot make this effect retrigger itself.
  $effect(() => {
    void rowCount;
    void columnCount;
    void rowHeight;
    void viewport;
    untrack(() => void ensureWindow(true));
  });

  $effect(() => {
    const cell = tab.pendingCell;
    if (!cell || !viewport || rowCount === 0) return;
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
    if (!viewport || rowCount === 0) {
      if (rowCount === 0) {
        rows = [];
        windowStart = 0;
      }
      return;
    }

    measure();
    const first = Math.max(0, Math.floor(anchorRow(metrics, viewport.scrollTop)));
    const last = Math.min(rowCount, first + visibleCount());
    if (!force && first >= windowStart && last <= windowStart + rows.length) return;

    const start = Math.max(0, first - OVERSCAN);
    const count = Math.min(rowCount - start, visibleCount() + OVERSCAN * 2);
    if (count <= 0) {
      rows = [];
      windowStart = 0;
      return;
    }

    const seq = ++requestSeq;
    try {
      const page = await gridRows(tab.id, start, count);
      // A later scroll has already superseded this request.
      if (seq !== requestSeq) return;
      windowStart = start;
      rows = page.rows;
      if (tab.columnWidths.length !== columnCount) measureColumns(page.rows);
    } catch (err) {
      if (seq === requestSeq) tab.error = errorMessage(err);
    }
  }

  /**
   * Rebuild the window from scratch, and optionally go back to the top.
   *
   * The host calls this when it has changed what the grid is showing — a mode
   * switch, another collection — since neither is something the grid can see.
   */
  export async function refresh(toTop = false) {
    if (toTop && viewport) viewport.scrollTop = 0;
    await ensureWindow(true);
  }

  export function focusGrid() {
    viewport?.focus();
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

  // --- copying ------------------------------------------------------------

  export async function copyCell(row: number, column: number) {
    try {
      const cell = await gridCellText(tab.id, row, column);
      await copyText(cell.text);
      toasts.show(cell.truncated ? t("toast.valueTruncated") : t("toast.valueCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  export async function copyRow(row: number) {
    try {
      const line = await gridRowText(tab.id, row);
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
      if (shortcutKey(event) === "c" && tab.selectedCell) {
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
</script>

<svelte:window onresize={() => void ensureWindow(true)} />

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
  aria-label={label}
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
            class:null={cell?.null}
            data-level={cellTone?.(column, cell?.text)}
            style="width: {columnWidth(column)}px"
            role="gridcell"
            tabindex="-1"
            title={cell?.null ? "NULL" : (cell?.text ?? "")}
            onclick={() => (tab.selectedCell = { row: row.index, column })}
            oncontextmenu={(e) => openMenu(e, row.index, column)}
          >
            {#if cell?.null}
              <!-- Not the empty string it would otherwise be indistinguishable
                   from. The word, dimmed, is what every database tool shows and
                   what the reader is looking for. -->
              <span class="nothing">NULL</span>
            {:else}
              <EscapedText text={cell?.text ?? ""} />{#if cell?.truncated}<span
                  class="ellipsis"
                  title={t("tree.truncated")}>…</span
                >{/if}
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => (menu = null)} />
{/if}

<style>
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

  /* A level worth looking at twice. Drawn from the tokens the rest of the app
     uses, so it reads as the same warning it does elsewhere, and left off the
     ordinary levels — tinting every row would tint nothing. */
  .cell[data-level="error"] {
    color: var(--danger);
    font-weight: 600;
  }

  .cell[data-level="warn"] {
    color: var(--warning);
    font-weight: 600;
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

  /* Quiet, italic, and never mistakable for a value someone stored. */
  .nothing {
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85em;
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
</style>
