<script lang="ts">
  import { errorMessage, gridOrder, gridOrderCancel, on, type GridSort } from "../../ipc";
  import { nextSort } from "../../grid-order";
  import { n, t } from "../../i18n";
  import { formatBytes } from "../../format";
  import type { DocTab } from "../../state/docs.svelte";

  let { tab, columnName, onchange, disabled = false }: {
    tab: DocTab; columnName: (column: number) => string;
    onchange: () => Promise<void>; disabled?: boolean;
  } = $props();
  let draft = $derived(tab.order.filter);
  $effect(() => {
    const target = tab;
    let disposed = false;
    let stop: (() => void) | undefined;
    void on("grid:progress", (event) => {
      if (event.docId === target.id && event.request === target.order.request && target.order.running) {
        target.order.progress = event;
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  });

  async function apply(sort: GridSort | null, filter: string) {
    if (disabled) return;
    const target = tab;
    const state = target.order;
    const request = ++state.request;
    state.running = true;
    state.progress = null;
    state.error = null;
    target.tableSearch.reset();
    try {
      const stats = await gridOrder(target.id, sort, filter, request);
      if (request !== state.request) return;
      state.stats = sort || filter ? stats : null;
      state.sort = sort;
      state.filter = filter;
      target.selectedCell = null;
      target.pendingCell = null;
      target.tableSearch.reset();
      await onchange();
    } catch (error) {
      if (request === state.request) state.error = errorMessage(error);
    } finally {
      if (request === state.request) { state.running = false; state.progress = null; }
    }
  }

  export async function sortColumn(column: number) {
    await apply(nextSort(tab.order.sort, column), draft);
  }

  async function cancel() {
    const state = tab.order;
    const request = ++state.request;
    try {
      await gridOrderCancel(tab.id);
      if (request === state.request) {
        state.reset();
        tab.selectedCell = null;
        tab.pendingCell = null;
        tab.tableSearch.reset();
        await onchange();
      }
    }
    catch (error) { if (request === state.request) state.error = errorMessage(error); }
    finally { if (request === state.request) { state.running = false; state.progress = null; } }
  }
</script>

<form class="grid-controls" onsubmit={(event) => { event.preventDefault(); void apply(tab.order.sort, draft); }}>
  <input type="search" bind:value={draft} placeholder={t("grid.filter")} aria-label={t("grid.filter")}
    {disabled} onkeydown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); draft = ""; void apply(tab.order.sort, ""); }
    }} />
  <button class="btn btn-ghost" type="submit" {disabled}>{t("grid.apply")}</button>
  {#if tab.order.running}
    <progress max={tab.order.progress?.total || 1} value={tab.order.progress?.done ?? 0} aria-label={t("grid.working")}></progress>
    <span>{t("grid.working")}</span>
    <button class="btn btn-ghost" type="button" onclick={cancel}>{t("grid.cancel")}</button>
  {:else if tab.order.stats}
    <span>{t("grid.shown", { shown: n(tab.order.stats.shown), total: n(tab.order.stats.total) })}</span>
    <span>{formatBytes(tab.order.stats.indexBytes)}</span>
  {/if}
  {#if tab.order.sort}<span>{t("grid.sorted", { column: columnName(tab.order.sort.column) })}</span>{/if}
  {#if tab.order.error}<span class="error" role="alert">{tab.order.error}</span>{/if}
</form>

<style>
  .grid-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .3rem .6rem; border-bottom: 1px solid var(--border); font-size: .85em; }
  input { min-width: 8rem; flex: 1; padding: .2rem .4rem; color: var(--text); background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; }
  progress { width: 5rem; }
  .error { color: var(--danger); }
</style>
