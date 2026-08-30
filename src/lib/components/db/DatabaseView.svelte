<script lang="ts">
  /**
   * Reading a SQLite file.
   *
   * The first format that is not a run of bytes. There is no index to build and
   * no original text to show — the file is opened as a connection, and every
   * row here came back from a query.
   *
   * The grid is the table view's, unchanged. That is the whole point of the
   * split: a database's rows and a CSV's rows differ in where they come from
   * and in nothing the reader does with them, so the difference stops at the
   * Rust boundary and both draw through `DataGrid`.
   */
  import DataGrid from "../grid/DataGrid.svelte";
  import SearchBar from "../grid/SearchBar.svelte";
  import CollectionPicker from "./CollectionPicker.svelte";
  import Icon from "../Icon.svelte";
  import { formatBytes } from "../../format";
  import { sqliteCollections, sqliteSchema, sqliteSelect, errorMessage } from "../../ipc";
  import { n, t } from "../../i18n";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
    /** Exposed upward so the global Ctrl+F shortcut can reach the search box. */
    focusSearch?: (() => void) | null;
  }

  let { tab, focusSearch = $bindable(null) }: Props = $props();

  let grid = $state<ReturnType<typeof DataGrid>>();
  let searchBar = $state<ReturnType<typeof SearchBar>>();

  $effect(() => {
    focusSearch = searchBar ? () => searchBar?.focus() : null;
    return () => {
      focusSearch = null;
    };
  });
  let loading = $state(false);
  let showSchema = $state(false);

  const items = $derived(
    tab.collections.map((entry) => ({ name: entry.name, secondary: entry.isView })),
  );
  const rowCount = $derived(tab.gridStats?.rowCount ?? 0);
  const columnCount = $derived(tab.gridStats?.columnCount ?? 0);

  // Opening the connection is what this does; the list comes back with it. A
  // tab that already has its list has already paid for it — switching tabs must
  // not reconnect.
  $effect(() => {
    const target = tab;
    if (target.collections.length > 0 || target.error) return;
    loading = true;
    sqliteCollections(target.id)
      .then((result) => {
        target.collections = result.items;
        if (result.items.length > 0) select(result.items[0].name);
      })
      .catch((err) => {
        target.error = errorMessage(err);
      })
      .finally(() => {
        loading = false;
      });
  });

  /**
   * Show another collection.
   *
   * Everything the grid was holding belonged to the last one — the column
   * widths were measured against its values, and a cell coordinate points at a
   * row that another collection does not have — so all of it goes.
   */
  async function select(name: string) {
    tab.collection = name;
    tab.schema = null;
    tab.gridStats = null;
    tab.selectedCell = null;
    tab.pendingCell = null;
    tab.columnWidths = [];
    tab.tableScrollTop = 0;
    tab.tableSearch.reset();
    loading = true;
    try {
      tab.gridStats = await sqliteSelect(tab.id, name);
      await grid?.refresh(true);
      // The statement comes second: the rows are what the reader is waiting
      // for, and the schema is a panel they may never open.
      const sql = await sqliteSchema(tab.id, name);
      // The reader may have moved on during the round trip.
      if (tab.collection === name) tab.schema = sql;
    } catch (err) {
      tab.error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  /** A database names its own columns, and there is nothing to guess. */
  function columnName(column: number): string {
    return tab.gridStats?.columns[column] ?? String(column + 1);
  }
</script>

<div class="database">
  <SearchBar {tab} bind:this={searchBar} />

  <div class="toolbar">
    <CollectionPicker
      label={t("table.collection")}
      {items}
      selected={tab.collection}
      onselect={(name) => void select(name)}
      disabled={loading}
    />

    <span class="spacer"></span>

    {#if tab.schema}
      <button
        class="btn btn-ghost"
        aria-pressed={showSchema}
        onclick={() => (showSchema = !showSchema)}
      >
        <Icon name="list" size={13} />
        {t("table.schema")}
      </button>
    {/if}
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

  {#if tab.error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {tab.error}
    </p>
  {/if}

  {#if showSchema && tab.schema}
    <pre class="schema">{tab.schema}</pre>
  {/if}

  {#if tab.collections.length === 0 && !loading}
    <p class="empty">{t("table.noCollections")}</p>
  {:else}
    <DataGrid
      bind:this={grid}
      {tab}
      {rowCount}
      {columnCount}
      {columnName}
      label={t("table.label", { title: tab.meta.title })}
    />

    <div class="status">
      <span>
        {t("table.status.size", { rows: n(rowCount), columns: n(columnCount) })}
      </span>
      {#if tab.gridStats}
        <span>{t("table.status.index", { size: formatBytes(tab.gridStats.indexBytes) })}</span>
        {#if tab.gridStats.truncated}
          <span class="warn">{t("table.status.scanned", { rows: n(rowCount) })}</span>
        {/if}
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
  .database {
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

  .banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.4rem 0.8rem;
    font-size: 0.9em;
  }

  .banner.error {
    background: var(--danger-subtle);
    color: var(--danger);
  }

  .empty {
    margin: 0;
    padding: 0.8rem;
    color: var(--text-secondary);
  }

  /* Above the grid rather than beside it: the statement is wide, and a column
     of it would take the width the rows need. */
  .schema {
    flex: none;
    max-height: 30%;
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-inset);
    overflow: auto;
    font-family: var(--font-code);
    font-size: 0.92em;
    line-height: 1.5;
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
  }

  .status .warn {
    color: var(--warning);
  }

  .status .where {
    font-variant-numeric: tabular-nums;
  }
</style>
