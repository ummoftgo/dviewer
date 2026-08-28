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
  import ContextMenu from "../ContextMenu.svelte";
  import JsonText from "../json/JsonText.svelte";
  import {
    errorMessage,
    tableCellText,
    tableOpen,
    tableRowText,
    tableRows,
    tableSearch,
    tableSetHasHeader,
    type TableRow,
  } from "../../ipc";
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
  const MIN_COLUMN = 64;
  const MAX_AUTO_COLUMN = 420;

  let viewport = $state<HTMLElement>();
  /** Mirrored into state because row positions depend on them once the file
   *  outgrows the browser's maximum element height — see lib/virtual.ts. */
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let queryInput = $state<HTMLInputElement>();
  let rows = $state<TableRow[]>([]);
  let windowStart = $state(0);
  let requestSeq = 0;
  let menu = $state<{ x: number; y: number; row: number; column: number } | null>(null);

  $effect(() => {
    focusSearch = queryInput ? () => queryInput?.select() : null;
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
  const totalWidth = $derived(
    numberWidth + tab.columnWidths.reduce((sum, width) => sum + width, 0),
  );
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

  /**
   * A first guess at each column's width, from the header and the first page.
   *
   * Measuring every row would mean reading the whole file, which is the one
   * thing this view exists to avoid. A page is enough to get the common case
   * right, and anything it misses the reader can drag.
   */
  function measureColumns(sample: TableRow[]) {
    const char = Math.max(6, settings.docFontPx * settings.uiScale * 0.62);
    tab.columnWidths = Array.from({ length: columnCount }, (_, column) => {
      let widest = visualLength(tab.header[column] ?? "");
      for (const row of sample) widest = Math.max(widest, visualLength(row.cells[column]?.text ?? ""));
      return Math.round(Math.min(MAX_AUTO_COLUMN, Math.max(MIN_COLUMN, widest * char + 26)));
    });
  }

  /** Hangul and CJK occupy two columns in a monospaced face; Latin one. */
  function visualLength(text: string): number {
    let total = 0;
    for (const ch of text) total += ch.codePointAt(0)! > 0x1100 ? 2 : 1;
    return total;
  }

  function columnWidth(column: number): number {
    return tab.columnWidths[column] ?? 140;
  }

  function scrollColumnIntoView(column: number) {
    if (!viewport) return;
    let left = numberWidth;
    for (let i = 0; i < column; i++) left += columnWidth(i);
    const right = left + columnWidth(column);
    if (left - numberWidth < viewport.scrollLeft) viewport.scrollLeft = left - numberWidth;
    else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = right - viewport.clientWidth;
    }
  }

  function startResize(event: PointerEvent, column: number) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = columnWidth(column);

    const move = (moved: PointerEvent) => {
      const next = Math.max(MIN_COLUMN, Math.round(startWidth + moved.clientX - startX));
      tab.columnWidths = tab.columnWidths.map((width, i) => (i === column ? next : width));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; dragging still works without it.
    }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
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
      toasts.show(cell.truncated ? "값이 너무 커서 앞부분만 복사했습니다." : "값을 복사했습니다.");
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  async function copyRow(row: number) {
    try {
      const line = await tableRowText(tab.id, row);
      await copyText(line.text);
      toasts.show("행을 복사했습니다.");
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  async function copyColumnName(column: number) {
    try {
      await copyText(columnName(column));
      toasts.show("열 이름을 복사했습니다.");
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
      { label: "값 복사", action: () => void copyCell(row, column), hint: "Ctrl C" },
      { label: "행 복사", action: () => void copyRow(row) },
      { label: "열 이름 복사", action: () => void copyColumnName(column) },
    ];
  });

  // --- search -------------------------------------------------------------

  async function runSearch(event?: Event) {
    event?.preventDefault();
    const search = tab.tableSearch;
    const query = search.query.trim();
    if (!query) {
      search.reset();
      return;
    }
    search.running = true;
    search.error = null;
    search.searched = true;
    try {
      const result = await tableSearch(tab.id, query, search.caseSensitive);
      search.hits = result.hits;
      search.capped = result.capped;
      search.current = result.hits.length > 0 ? 0 : -1;
      if (result.hits.length > 0) tab.pendingCell = result.hits[0];
    } catch (err) {
      search.error = errorMessage(err);
      search.hits = [];
      search.current = -1;
    } finally {
      search.running = false;
    }
  }

  function step(delta: number) {
    const search = tab.tableSearch;
    if (search.hits.length === 0) return;
    search.current = (search.current + delta + search.hits.length) % search.hits.length;
    tab.pendingCell = search.hits[search.current];
  }

  function clearSearch() {
    tab.tableSearch.reset();
    tab.tableSearch.query = "";
  }

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
  <form class="searchbar" onsubmit={runSearch}>
    <Icon name="search" size={13} />
    <input
      bind:this={queryInput}
      bind:value={tab.tableSearch.query}
      type="search"
      placeholder="표 안에서 찾기"
      aria-label="표 안에서 찾기"
      onkeydown={(e) => {
        if (e.key === "Escape") clearSearch();
      }}
    />
    <label class="case" title="대소문자 구분">
      <input type="checkbox" bind:checked={tab.tableSearch.caseSensitive} />
      Aa
    </label>
    <button class="btn btn-ghost" type="submit" disabled={tab.tableSearch.running}>
      {tab.tableSearch.running ? "찾는 중…" : "찾기"}
    </button>

    {#if tab.tableSearch.hits.length > 0}
      <span class="count">
        {tab.tableSearch.current + 1} / {tab.tableSearch.hits.length.toLocaleString()}
        {#if tab.tableSearch.capped}<span class="capped" title="결과가 너무 많아 일부만 모았습니다"
            >+</span
          >{/if}
      </span>
      <button class="icon-btn" type="button" onclick={() => step(-1)} aria-label="이전 결과">
        <Icon name="chevron-up" size={13} />
      </button>
      <button class="icon-btn" type="button" onclick={() => step(1)} aria-label="다음 결과">
        <Icon name="chevron-down" size={13} />
      </button>
      <button class="btn btn-ghost" type="button" onclick={clearSearch}>지우기</button>
    {:else if tab.tableSearch.searched && !tab.tableSearch.running}
      <span class="count empty">결과 없음</span>
    {/if}

    {#if tab.tableSearch.error}
      <span class="count error">{tab.tableSearch.error}</span>
    {/if}
  </form>

  {#if tab.error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {tab.error}
    </p>
  {/if}

  {#if !tab.tableStats && !tab.error}
    <div class="loading">
      <p>표를 읽는 중… {formatBytes(tab.indexing?.done ?? 0)} / {formatBytes(tab.meta.byteLen)}</p>
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
        title="첫 줄을 열 이름으로 쓸지 데이터로 쓸지 바꿉니다"
      >
        <Icon name="list" size={13} />
        머리글 행
        <span class="state">{tab.tableStats.hasHeader ? "켜짐" : "꺼짐"}</span>
      </button>

      <span class="spacer"></span>

      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() => tab.selectedCell && copyCell(tab.selectedCell.row, tab.selectedCell.column)}
      >
        <Icon name="copy" size={13} /> 값 복사
      </button>
      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() => tab.selectedCell && copyRow(tab.selectedCell.row)}
      >
        행 복사
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
      aria-label="{tab.meta.title} 표"
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
              title="드래그해서 너비 조절 · 두 번 눌러 자동 맞춤"
            ></span>
          </div>
        {/each}
      </div>

      <div class="body" style="height: {spacerHeight(metrics)}px; width: {totalWidth}px">
        {#each rows as row (row.index)}
          <div class="row" style="top: {rowTop(metrics, scrollTop, row.index)}px" role="row">
            <div class="cell num" role="rowheader">{(row.index + 1).toLocaleString()}</div>
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
                <JsonText text={cell?.text ?? ""} />{#if cell?.truncated}<span
                    class="ellipsis"
                    title="값이 길어 일부만 표시합니다">…</span
                  >{/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="status">
      <span>{tab.tableStats.rowCount.toLocaleString()}행 × {columnCount.toLocaleString()}열</span>
      <span>구분자 {tab.tableStats.delimiter}</span>
      <span>색인 {formatBytes(tab.tableStats.indexBytes)}</span>
      {#if tab.tableStats.truncated}
        <span class="warn">행이 너무 많아 일부만 읽었습니다</span>
      {/if}
      {#if tab.selectedCell}
        <span class="spacer"></span>
        <span class="where">
          {(tab.selectedCell.row + 1).toLocaleString()}행 · {columnName(tab.selectedCell.column)}
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

  .searchbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }

  .searchbar input[type="search"] {
    flex: 1;
    min-width: 6rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  .case {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.85em;
  }

  .count {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .count.empty {
    color: var(--text-muted);
  }

  .count.error,
  .status .warn {
    color: var(--danger);
  }

  .capped {
    color: var(--text-muted);
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
