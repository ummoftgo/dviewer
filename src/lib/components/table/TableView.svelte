<script lang="ts">
  /**
   * CSV, TSV and logs as a grid.
   *
   * The grid itself is `DataGrid`, which a database uses too. What is here is
   * everything that only a file of bytes has: the indexing pass and its
   * progress, the mode switches that change what a row means, the search over
   * the raw bytes, and the columns a recognised log splits into.
   */
  import { formatBytes } from "../../format";
  import Icon from "../Icon.svelte";
  import { n, t, type MessageKey } from "../../i18n";
  import DataGrid from "../grid/DataGrid.svelte";
  import SearchBar from "../grid/SearchBar.svelte";
  import {
    errorMessage,
    tableOpen,
    tableSetHasHeader,
    tableSetPlain,
    tableSetExpand,
    type TableShape,
    logFieldName,
    type LogField,
  } from "../../ipc";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
    /** Exposed upward so the global Ctrl+F shortcut can reach the search box. */
    focusSearch?: (() => void) | null;
  }

  let { tab, focusSearch = $bindable(null) }: Props = $props();

  let searchBar = $state<ReturnType<typeof SearchBar>>();
  let grid = $state<ReturnType<typeof DataGrid>>();

  $effect(() => {
    focusSearch = searchBar ? () => searchBar?.focus() : null;
    return () => {
      focusSearch = null;
    };
  });

  /**
   * Whether the columns on screen were guessed at.
   *
   * A log's shape and a JSONL file's keys are both inferred, and both readings
   * fold back to one column per line. The toggle belongs to that, not to logs —
   * and it has to stay put while folded, or the way back would disappear with
   * the columns.
   */
  const inferred = $derived(
    tab.tableStats?.logLayout != null || tab.tableStats?.delimiter === "jsonl",
  );
  const rowCount = $derived(tab.tableStats?.rowCount ?? 0);
  const columnCount = $derived(tab.tableStats?.columnCount ?? 0);
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

  // --- header row ---------------------------------------------------------

  /**
   * Take a new shape from a mode switch, and drop what it invalidated.
   *
   * Each of these changes what a coordinate means. Promoting the header row
   * shifts every row number by one; folding a log to lines changes rows from
   * records to lines; expanding pairs changes how many columns there are. A
   * search hit is a (row, column) pair, so results kept across any of them
   * point somewhere else — pressing Enter would jump to the wrong place.
   *
   * Clearing rather than re-running, which is what an encoding or format
   * switch already does with everything derived from the old reading.
   */
  async function applyShape(shape: TableShape, toTop = false) {
    tab.tableStats = shape.stats;
    tab.header = shape.header;
    tab.selectedCell = null;
    tab.pendingCell = null;
    tab.columnWidths = [];
    tab.tableSearch.reset();
    await grid?.refresh(toTop);
  }

  async function toggleHeader() {
    try {
      await applyShape(
        await tableSetHasHeader(tab.id, !(tab.tableStats?.hasHeader ?? true)),
        true,
      );
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  function columnName(column: number): string {
    // A recognised log names its columns from the shape that was found. The
    // structural ones are labels this interface owns; a logfmt key is the
    // file's own word and passes through untranslated.
    const layout = tab.tableStats?.logLayout;
    if (layout && !tab.tableStats?.plain) {
      const field = layout[column];
      if (field !== undefined) {
        return logFieldName(field, bracketIndex(layout, column));
      }
    }
    const name = tab.header[column];
    // Without a header row the columns still need labels, and their position is
    // the only name they have.
    return name && name.length > 0 ? name : String(column + 1);
  }

  /**
   * The tone a level cell carries, or undefined for every other cell.
   *
   * Only the level column is tinted. Colouring the whole row would fight the
   * zebra stripes and make the table louder than its data — and the cell
   * already says the word, so the colour is a second glance, never the only
   * one.
   */
  function levelTone(column: number, text: string | undefined): string | undefined {
    const layout = tab.tableStats?.logLayout;
    if (!layout || tab.tableStats?.plain || layout[column] !== "level") return undefined;
    const level = (text ?? "").trim().toUpperCase();
    if (level === "ERROR" || level === "FATAL" || level === "CRITICAL") return "error";
    if (level === "WARN" || level === "WARNING") return "warn";
    return undefined;
  }

  /// How many bracketed fields come before this one, so the second is "출처 2".
  function bracketIndex(layout: LogField[], column: number): number {
    let seen = 0;
    for (let i = 0; i < column; i++) {
      const field = layout[i];
      if (field !== null && typeof field === "object" && "bracketed" in field) seen++;
    }
    return seen;
  }

  async function toggleExpand() {
    try {
      await applyShape(await tableSetExpand(tab.id, !(tab.tableStats?.expanded ?? false)));
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  async function togglePlain() {
    try {
      await applyShape(await tableSetPlain(tab.id, !(tab.tableStats?.plain ?? false)));
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

</script>

<div class="table-view">
  <SearchBar {tab} bind:this={searchBar} />

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
      <!-- Only a reading that split the columns itself can be folded back;
           plain text has nothing to fold. -->
      {#if inferred}
        <button
          class="btn toggle"
          class:on={tab.tableStats.plain}
          aria-pressed={tab.tableStats.plain}
          onclick={togglePlain}
          title={t("table.plain.title")}
        >
          <Icon name="list" size={13} />
          {t("table.plain")}
          <span class="state">{tab.tableStats.plain ? t("state.on") : t("state.off")}</span>
        </button>
      {/if}

      <!-- Only offered when there are pairs to pull out; a log without them
           would gain nothing but empty columns. Hidden while folded to one
           column, where there are no columns to widen. -->
      {#if tab.tableStats.expandable && !tab.tableStats.plain}
        <button
          class="btn toggle"
          class:on={tab.tableStats.expanded}
          aria-pressed={tab.tableStats.expanded}
          onclick={toggleExpand}
          title={t("table.expand.title")}
        >
          <Icon name="list" size={13} />
          {t("table.expand")}
          <span class="state">{tab.tableStats.expanded ? t("state.on") : t("state.off")}</span>
        </button>
      {/if}

      <!-- Text has no first row to promote, so the toggle is not shown rather
           than shown and refused. -->
      {#if tab.tableStats.headerPossible}
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
      {/if}

      <span class="spacer"></span>

      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() =>
          tab.selectedCell && grid?.copyCell(tab.selectedCell.row, tab.selectedCell.column)}
      >
        <Icon name="copy" size={13} />
        {t("table.copyValue")}
      </button>
      <button
        class="btn btn-ghost"
        disabled={!tab.selectedCell}
        onclick={() => tab.selectedCell && grid?.copyRow(tab.selectedCell.row)}
      >
        {t("table.copyRow")}
      </button>
    </div>

    <DataGrid
      bind:this={grid}
      {tab}
      {rowCount}
      {columnCount}
      {columnName}
      cellTone={levelTone}
      label={t("table.label", { title: tab.meta.title })}
    />

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
