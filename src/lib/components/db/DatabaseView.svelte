<!--
  Reading a SQLite file.

  The first format that is not a run of bytes. There is no index to build and no
  original text to show — the file is opened as a connection, and everything
  shown here comes from a query. What it shares with the table view is the grid,
  which arrives with the rows; for now this is the connection, the list of what
  the file holds, and the statement that made the chosen one.
-->
<script lang="ts">
  import CollectionPicker from "./CollectionPicker.svelte";
  import { sqliteCollections, sqliteSchema, errorMessage } from "../../ipc";
  import { t } from "../../i18n";
  import type { DocTab } from "../../state/docs.svelte";

  let { tab }: { tab: DocTab } = $props();

  let loading = $state(false);

  const items = $derived(
    tab.collections.map((entry) => ({ name: entry.name, secondary: entry.isView })),
  );

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

  function select(name: string) {
    tab.collection = name;
    tab.schema = null;
    sqliteSchema(tab.id, name)
      .then((sql) => {
        // The reader may have moved on during the round trip.
        if (tab.collection === name) tab.schema = sql;
      })
      .catch((err) => {
        tab.error = errorMessage(err);
      });
  }
</script>

<div class="database">
  <div class="toolbar">
    <CollectionPicker
      label={t("table.collection")}
      {items}
      selected={tab.collection}
      onselect={select}
      disabled={loading}
    />
  </div>

  <div class="body">
    {#if tab.collections.length === 0 && !loading}
      <p class="empty">{t("table.noCollections")}</p>
    {:else if tab.schema}
      <section class="schema">
        <h2>{t("table.schema")}</h2>
        <pre>{tab.schema}</pre>
      </section>
    {/if}
  </div>
</div>

<style>
  .database {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.8rem;
  }

  .empty {
    margin: 0;
    color: var(--text-secondary);
  }

  .schema h2 {
    margin: 0 0 0.4rem;
    color: var(--text-secondary);
    font-size: 0.92em;
    font-weight: 600;
  }

  .schema pre {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    overflow-x: auto;
    font-family: var(--font-code);
    font-size: 0.92em;
    line-height: 1.5;
  }
</style>
