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
  import { tick, untrack } from "svelte";
  import type { TableMode } from '../markdown/tables';
  import { shortcutKey } from "../../keys";
  import { n, t } from "../../i18n";
  import ContextMenu from "../ContextMenu.svelte";
  import EscapedText from "../EscapedText.svelte";
  import {
    errorMessage,
    gridCellText,
    gridRows,
    type TableRow,
    type GridSort,
  } from "../../ipc";
  import {
    columnLeft,
    columnWidth as widthOf,
    measureColumns as autoWidths,
    fitColumn as fitWidth,
    startResize as beginResize,
    totalWidth as totalOf,
    projectLayout,
    visibleColumns,
    hideColumn,
    revealColumn,
    moveColumn,
    freezeThrough,
    frozenOffsets,
    MAX_AUTO_COLUMN,
    MAX_FIT_COLUMN,
    automaticColumnLimit,
    resetColumns,
    resizeColumnKey,
    MIN_COLUMN,
  } from "./columns";
  import { copyText } from "../../clipboard";
  import { rowText } from './copy';
  import { cellTitle, selectedCell } from "./preview";
  import { toasts } from "../../state/toast.svelte";
  import type { MenuItem } from "../menu";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";
  import { anchorRow, rowTop, scrollTopForRow, spacerHeight } from "../../virtual";
  import { originalRow } from '../../position';

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
    firstRowNumber?: 0 | 1;
    onsort?: (column: number) => void;
    sortAvailable?: boolean;
    onsortTo?: (sort: GridSort | null) => void;
    onfilterColumn?: (column: number) => void;
    onfilterClear?: () => void;
    /** Table and collection hosts share the same width controls. */
    widthMode?: TableMode;
  }

  let { tab, rowCount, columnCount, columnName, cellTone, label, firstRowNumber = 1, onsort, onsortTo, onfilterColumn, onfilterClear, sortAvailable = true, widthMode }: Props = $props();
  const generation = untrack(() => tab.meta.generation ?? 0);
  const current = () => (tab.meta.generation ?? 0) === generation;

  /** Extra rows fetched above and below the viewport to hide scroll latency. */
  const OVERSCAN = 24;

  let viewport = $state<HTMLElement>();
  /** Mirrored into state because row positions depend on them once the file
   *  outgrows the browser's maximum element height — see lib/virtual.ts. */
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let viewportWidth = $state(0);
  let fitted = $state(false);
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
    Math.max(44, Math.round(String(tab.order.stats?.total ?? rowCount).length * settings.docFontPx * settings.uiScale * 0.65) + 18),
  );
  const columns = $derived(visibleColumns(tab, columnCount));
  const positions = $derived(new Map(columns.map((column, at) => [column, at])));
  const layout = $derived(projectLayout(tab, columns, viewportWidth, numberWidth, widthMode ?? 'scroll'));
  const presentation = $derived({ columnWidths: layout.widths });
  const pinned = $derived(frozenOffsets(layout.widths, tab.frozenCount, numberWidth));
  const pinnedWidth = $derived(numberWidth + layout.widths.slice(0, tab.frozenCount).reduce((sum, width) => sum + width, 0));
  const totalWidth = $derived(totalOf(presentation, numberWidth));
  let measuredMode = untrack(() => widthMode);

  $effect(() => {
    const mode = widthMode;
    if (mode === measuredMode || !current()) return;
    measuredMode = mode;
    untrack(() => {
      resetColumns(tab);
      if (rows.length || rowCount === 0) measureColumns(rows);
    });
  });

  $effect(() => {
    const host = viewport;
    if (!host || widthMode === undefined) return;
    const measureWidth = () => { viewportWidth = host.clientWidth; };
    measureWidth();
    const observer = new ResizeObserver(measureWidth);
    observer.observe(host);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (current() && widthMode !== undefined && rowCount === 0 && columnCount > 0 && tab.columnWidths.length !== columnCount) {
      untrack(() => measureColumns([]));
    }
  });

  $effect(() => {
    void layout;
    fitted = false;
    if (!current() || !viewport || widthMode === undefined || viewportWidth <= 0 || tab.columnWidths.length !== columnCount) return;
    let live = true;
    void tick().then(() => { if (live) fitted = true; });
    return () => { live = false; };
  });

  /**
   * Put the reader back where they were.
   *
   * Only once — and only once there is something to scroll, since the spacer
   * has no height before the row count arrives. The view is rebuilt per tab
   * (`{#key active.id}` in App.svelte), so this runs again for the next one.
   */
  let restored = false;
  function capturePosition() {
    if (!viewport) return;
    const row = originalRow(rows,windowStart,Math.max(0,Math.floor(anchorRow(metrics,viewport.scrollTop))));
    if (row !== undefined) tab.rememberPosition({kind:'grid',row,...(tab.collection === null ? {} : {collection:tab.collection})});
  }
  $effect(() => {
    if (viewport && rowCount === 0 && (tab.tableStats || tab.gridStats)) {
      untrack(() => { if (tab.pendingPosition) tab.finishPosition(false); });
    }
    if (restored || !viewport || rowCount === 0 || (widthMode !== undefined && !fitted)) return;
    restored = true;
    untrack(() => {
      const pos = tab.pendingPosition;
      viewport!.scrollTop = pos?.kind === 'grid' ? scrollTopForRow(metrics,pos.row < rowCount ? pos.row : 0) : tab.tableScrollTop;
      tab.tableScrollTop = viewport!.scrollTop;
      if (pos) tab.finishPosition(viewport!.scrollTop > 0);
      void ensureWindow(true);
    });
  });

  // Anything that changes the grid's shape invalidates the cached window. The
  // dependencies are listed explicitly and the call untracked so that reading
  // `rows` inside ensureWindow cannot make this effect retrigger itself.
  $effect(() => {
    void rowCount;
    void columnCount;
    void tab.order.revision;
    void rowHeight;
    void viewport;
    untrack(() => {
      if (viewport) viewport.scrollTop = tab.tableScrollTop;
      void ensureWindow(true);
    });
  });

  $effect(() => {
    const cell = tab.pendingCell;
    if (!cell || !viewport || rowCount === 0) return;
    tab.pendingCell = null;
    if (cell.column < 0 || cell.column >= columnCount) return;
    revealColumn(tab, cell.column, true);
    selectCell(cell.row, cell.column);
    // Park the target a third of the way down rather than at the very top.
    measure();
    viewport.scrollTop = scrollTopForRow(
      metrics,
      Math.max(0, cell.row - Math.floor(visibleCount() / 3)),
    );
    void tick().then(() => { if (current()) scrollColumnIntoView(cell.column); });
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
    if (!current()) return;
    if (!viewport || rowCount === 0) {
      requestSeq += 1;
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
      if (!current() || seq !== requestSeq) return;
      windowStart = start;
      rows = page.rows;
      capturePosition();
      if (tab.selectedCell) selectCell(tab.selectedCell.row, tab.selectedCell.column);
      if (tab.columnWidths.length !== columnCount) measureColumns(page.rows);
    } catch (err) {
      if (current() && seq === requestSeq) tab.error = errorMessage(err);
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
    capturePosition();
  }

  // --- columns ------------------------------------------------------------

  function measureColumns(sample: TableRow[]) {
    autoWidths(tab, sample, columnCount, settings.docFontPx * settings.uiScale, columnName, automaticColumnLimit(widthMode), columns);
  }

  function fitColumn(column: number) {
    fitWidth(tab, rows, column, settings.docFontPx * settings.uiScale, columnName(column), widthMode === undefined ? MAX_AUTO_COLUMN : MAX_FIT_COLUMN, layout);
  }

  function resetWidths(recommend: boolean) {
    autoWidths(tab, rows, columnCount, settings.docFontPx * settings.uiScale, columnName, recommend ? MAX_FIT_COLUMN : automaticColumnLimit(widthMode), columns);
  }

  function columnWidth(column: number) {
    return widthOf(presentation, positions.get(column) ?? -1);
  }

  function scrollColumnIntoView(column: number) {
    if (!viewport) return;
    const at = positions.get(column);
    if (at === undefined || at < tab.frozenCount) return;
    const left = columnLeft(presentation, at, numberWidth);
    const right = left + columnWidth(column);
    if (left - pinnedWidth < viewport.scrollLeft) viewport.scrollLeft = left - pinnedWidth;
    else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = right - viewport.clientWidth;
    }
  }

  function startResize(event: PointerEvent, column: number) {
    beginResize(event, tab, column, widthMode === undefined ? undefined : layout);
  }

  function onResizeKey(event: KeyboardEvent, column: number) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      fitColumn(column);
    } else if (resizeColumnKey(tab, layout, column, event.key, event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // --- copying ------------------------------------------------------------

  export async function copyCell(row: number, column: number) {
    try {
      const cell = await gridCellText(tab.id, await sourceRow(row), column);
      await copyText(cell.text);
      toasts.show(cell.truncated ? t("toast.valueTruncated") : t("toast.valueCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  export async function copyRow(row: number) {
    try {
      const line = await rowText(tab, sourceRow(row), columnCount);
      await copyText(line.text);
      toasts.show(t(line.truncated ? 'toast.valueTruncated' : 'toast.rowCopied'));
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
    if (row >= 0) selectCell(row, column);
    menu = { x: event.clientX, y: event.clientY, row, column };
  }

  function headerMenu(event: MouseEvent | KeyboardEvent, column: number) {
    event.preventDefault(); event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { x: box.left, y: box.bottom, row: -1, column };
  }

  function headerKey(event: KeyboardEvent, column: number) {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') headerMenu(event, column);
  }

  function closeMenu() {
    const closed = menu;
    menu = null;
    void tick().then(() => {
      if (!viewport?.isConnected || !closed) return;
      if (closed.row === -1) {
        const header = viewport.querySelector<HTMLButtonElement>(`.head [data-column="${closed.column}"] .name`)
          ?? viewport.querySelector<HTMLButtonElement>('.head .name');
        header?.focus();
      } else viewport.focus();
    });
  }

  const menuItems = $derived.by((): MenuItem[] => {
    if (!menu) return [];
    const { row, column } = menu;
    if (row === -1) return [
      { key: 'hide-column', label: t('grid.hideColumn'), disabled: columns.length <= 1, action: () => { hideColumn(tab, column, columnCount); } },
      { key: 'move-left', label: t('grid.moveLeft'), disabled: positions.get(column) === 0, action: () => moveColumn(tab, column, -1, columnCount) },
      { key: 'move-right', label: t('grid.moveRight'), disabled: positions.get(column) === columns.length - 1, action: () => moveColumn(tab, column, 1, columnCount) },
      { key: 'freeze-columns', label: t('grid.freezeThrough'), action: () => freezeThrough(tab, column, columnCount) },
      { key: 'unfreeze-columns', label: t('grid.unfreeze'), disabled: tab.frozenCount === 0, action: () => { tab.frozenCount = 0; } },
      { key: 'reset-columns', label: t('grid.resetColumnView'), action: () => tab.resetColumnView() },
      ...([null, false, true] as const).map((descending) => ({
        icon: descending === null ? "sort-none" as const : descending ? "sort-desc" as const : "sort-asc" as const,
        label: t(descending === null ? "grid.sortDefault" : descending ? "grid.sortDesc" : "grid.sortAsc"),
        checked: descending === null ? tab.order.sort === null : tab.order.sort?.column === column && tab.order.sort.descending === descending,
        disabled: !sortAvailable || tab.order.running,
        hint: !sortAvailable ? t("grid.sortUnavailable") : undefined,
        action: () => onsortTo?.(descending === null ? null : { column, descending }),
      })),
      { label: t("grid.filterColumn"), icon: "filter", action: () => onfilterColumn?.(column) },
      { label: t("grid.filterClear"), icon: "filter-off", disabled: !tab.order.filter, action: () => onfilterClear?.() },
      { label: t("grid.fitColumn"), icon: "fit-width", action: () => fitColumn(column) },
      ...(widthMode === undefined ? [] : [
        { label: t('grid.recommendWidths'), icon: 'fit-width' as const, action: () => resetWidths(true) },
        { label: t('grid.resetWidths'), icon: 'auto' as const, action: () => resetWidths(false) },
      ]),
    ];
    return [
      { label: t("table.copyValue"), icon: "copy", action: () => void copyCell(row, column), hint: "Ctrl C" },
      { label: t("table.copyRow"), icon: "copy", action: () => void copyRow(row) },
      { label: t("table.copyColumn"), icon: "copy", action: () => void copyColumnName(column) },
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
    if (!columns.length) return;
    const cell = tab.selectedCell ?? { row: -1, column: columns[0] };
    const row = Math.min(rowCount - 1, Math.max(0, cell.row + rowDelta));
    const at = positions.get(cell.column) ?? 0;
    const column = columns[Math.min(columns.length - 1, Math.max(0, at + columnDelta))];
    selectCell(row, column);
    scrollRowIntoView(row);
    scrollColumnIntoView(column);
  }

  function selectCell(row: number, column: number) {
    tab.selectedCell = selectedCell(tab.selectedCell, row, column, rows[row - windowStart]);
  }

  async function sourceRow(displayRow: number): Promise<number> {
    const cached = rows[displayRow - windowStart];
    if (cached) return cached.index;
    const page = await gridRows(tab.id, displayRow, 1);
    if (!page.rows[0]) throw { code: "noSuchRow" };
    return page.rows[0].index;
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
    if ((event.target as HTMLElement)?.closest('[role="columnheader"]')) return;
    if (tab.order.running || rowCount === 0) return;
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
  data-width-mode={widthMode}
  data-fitted={widthMode === undefined ? undefined : String(fitted)}
  data-visible-columns={columns.length}
  data-frozen-count={tab.frozenCount}
  class:ordering={tab.order.running}
  class:empty={rowCount === 0 && tab.order.stats !== null}
  bind:this={viewport}
  onscroll={onScroll}
  onkeydown={onKeydown}
  tabindex="0"
  role="grid"
  aria-rowcount={rowCount}
  aria-colcount={columns.length}
  aria-label={label}
  aria-busy={tab.order.running}
  style="--row-height: {rowHeight}px; --number-width: {numberWidth}px"
>
  <div class="head" style="width: {totalWidth}px" role="row">
    <div class="cell num" role="columnheader"></div>
    {#each columns as column, at (column)}
      <div class="cell" class:frozen={pinned[at] !== null}
        style="width: {columnWidth(column)}px; left: {pinned[at] === null ? 'auto' : `${pinned[at]}px`}" role="columnheader" tabindex="-1"
        data-column={column} onkeydown={(event) => headerKey(event, column)}
        oncontextmenu={(event) => openMenu(event, -1, column)}
        aria-sort={tab.order.sort?.column === column ? (tab.order.sort.descending ? "descending" : "ascending") : "none"}>
        <button type="button" class="name" aria-disabled={!sortAvailable || tab.order.running}
          onclick={() => { if (sortAvailable && !tab.order.running) onsort?.(column); }} title={sortAvailable ? columnName(column) : t("grid.sortUnavailable")}>
          {columnName(column)}{tab.order.sort?.column === column ? (tab.order.sort.descending ? " ▼" : " ▲") : ""}
        </button>
        <button type="button" class="column-menu" aria-label={t('grid.columnMenu', { column: columnName(column) })}
          aria-haspopup="menu" onclick={(event) => headerMenu(event, column)}>⋮</button>
        <!-- A focusable value-bearing separator, as in Splitter.svelte. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <span
          class="grip" role="separator" tabindex="0" aria-orientation="vertical"
          aria-label={t('markdown.table.resize', { column: column + 1 })}
          aria-valuemin={MIN_COLUMN} aria-valuenow={Math.round(columnWidth(column))}
          aria-valuemax={layout.mode === 'fill' ? Math.round(columns.length === 1 ? columnWidth(column)
            : columnWidth(column) + columnWidth(columns[at === columns.length - 1 ? at - 1 : at + 1]) - MIN_COLUMN) : undefined}
          onkeydown={(event) => onResizeKey(event, column)}
          onpointerdown={(e) => startResize(e, column)}
          ondblclick={() => fitColumn(column)}
          title={t("table.resize")}
        ></span>
      </div>
    {/each}
  </div>

  <div class="body" style="height: {spacerHeight(metrics)}px; width: {totalWidth}px">
    {#each rows as row, at (row.index)}
      {@const displayRow = windowStart + at}
      <div class="row" style="top: {rowTop(metrics, scrollTop, displayRow)}px" role="row">
        <div class="cell num" role="rowheader">{n(row.index + firstRowNumber)}</div>
        {#each columns as column, at (column)}
          {@const cell = row.cells[column]}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="cell"
            class:frozen={pinned[at] !== null}
            class:selected={tab.selectedCell?.row === displayRow &&
              tab.selectedCell?.column === column}
            class:hit={isHit(displayRow, column)}
            class:null={cell?.null}
            data-level={cellTone?.(column, cell?.text)}
            style="width: {columnWidth(column)}px; left: {pinned[at] === null ? 'auto' : `${pinned[at]}px`}"
            role="gridcell"
            data-column={column}
            tabindex="-1"
            data-truncated={cell?.truncated ? "true" : undefined}
            title={cellTitle(cell, tab.kind)}
            onclick={() => selectCell(displayRow, column)}
            oncontextmenu={(e) => openMenu(e, displayRow, column)}
          >
            {#if cell?.null}
              <!-- Not the empty string it would otherwise be indistinguishable
                   from. The word, dimmed, is what every database tool shows and
                   what the reader is looking for. -->
              <span class="nothing">NULL</span>
            {:else}
              <EscapedText text={cell?.text ?? ""} />{#if cell?.truncated}<span
                  class="ellipsis"
                  title={cellTitle(cell, tab.kind)}>…</span
                >{/if}
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
{/if}

<style>
  .grid.empty { display: none; }
  .grid.ordering .body { pointer-events: none; }
  button.name { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
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
    --row-bg: var(--bg);
    position: absolute;
    left: 0;
    display: flex;
    height: var(--row-height);
  }

  /* Zebra striping: with many narrow columns the eye loses the row on the way
     across, and a stripe is cheaper to follow than a rule. */
  .row:nth-child(even) {
    --row-bg: var(--bg-inset);
    background: var(--bg-inset);
  }

  .row:hover {
    --row-bg: var(--bg-hover);
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
    display: flex;
    align-items: center;
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

  .column-menu { flex: none; align-self: stretch; padding: 0 .25rem; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .column-menu:hover, .column-menu:focus-visible { background: var(--bg-hover); }

  .cell.frozen { position: sticky; z-index: 1; background: var(--row-bg, var(--bg)); }
  .head .cell.frozen { position: sticky; z-index: 2; background: var(--bg-subtle); }

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

  .ellipsis { color: var(--warning); text-decoration: underline dotted; }

  .grip {
    position: absolute;
    top: 0;
    right: -3px;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
  }

  .grip:hover, .grip:focus-visible {
    background: var(--accent);
  }
</style>
