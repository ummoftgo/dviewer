<script lang="ts">
  import { tick } from 'svelte';
  import { errorMessage, gridOrderCancel, on, type GridSort } from "../../ipc";
  import { nextSort } from "../../grid-order";
  import { n, t } from "../../i18n";
  import { formatBytes } from "../../format";
  import type { DocTab } from "../../state/docs.svelte";
  import ContextMenu from '../ContextMenu.svelte';
  import { revealColumn } from './columns';

  let { tab, columnName, disabled = false }: {
    tab: DocTab; columnName: (column: number) => string;
    disabled?: boolean;
  } = $props();
  let draft = $derived.by(() => { void tab.order.revision; return tab.order.filter; });
  let draftColumn = $derived.by(() => { void tab.order.revision; return tab.order.filterColumn; });
  let input = $state<HTMLInputElement>();
  let hiddenButton = $state<HTMLButtonElement>();
  let hiddenMenu = $state<{ x: number; y: number } | null>(null);
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
    if (!disabled) await tab.applyOrder(sort, filter, draftColumn);
  }

  export async function sortTo(sort: GridSort | null) { await apply(sort, draft); }
  export function filterColumn(column: number) { draftColumn = column; input?.focus(); }
  export async function clearFilter() { draft = ""; draftColumn = null; await apply(tab.order.sort, ""); }

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
        tab.tableScrollTop = 0;
      }
    }
    catch (error) { if (request === state.request) state.error = errorMessage(error); }
    finally { if (request === state.request) { state.running = false; state.progress = null; } }
  }
</script>

<form class="grid-controls" onsubmit={(event) => { event.preventDefault(); void apply(tab.order.sort, draft); }}>
  {#if tab.hiddenColumns.length}
    <button class="btn btn-ghost" type="button" {disabled} bind:this={hiddenButton} aria-haspopup="menu"
      onclick={() => { const box = hiddenButton!.getBoundingClientRect(); hiddenMenu = { x: box.left, y: box.bottom }; }}>
      {t('grid.hiddenColumns', { n: tab.hiddenColumns.length })}
    </button>
  {/if}
  {#if draftColumn !== null}
    <button class="btn btn-ghost scope" type="button" title={t("grid.filterAll")} aria-label={t("grid.filterAll")}
      {disabled} onclick={() => { draftColumn = null; input?.focus(); }}>{columnName(draftColumn)} ×</button>
  {/if}
  <input bind:this={input} type="search" bind:value={draft} placeholder={draftColumn === null ? t("grid.filter") : t("grid.filterIn", { column: columnName(draftColumn) })} aria-label={draftColumn === null ? t("grid.filter") : t("grid.filterIn", { column: columnName(draftColumn) })}
    {disabled} onkeydown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); void clearFilter(); }
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
  {#if tab.order.filter && tab.order.filterColumn !== null}<span>{t("grid.filterIn", { column: columnName(tab.order.filterColumn) })}</span>{/if}
  {#if tab.order.sort}<span>{t("grid.sorted", { column: columnName(tab.order.sort.column) })}</span>{/if}
  {#if tab.order.error}<span class="error" role="alert">{tab.order.error}</span>{/if}
</form>

{#if hiddenMenu}
  <ContextMenu x={hiddenMenu.x} y={hiddenMenu.y}
    items={tab.hiddenColumns.map(column => ({ key: String(column), label: columnName(column), action: () => revealColumn(tab, column) }))}
    onClose={() => { hiddenMenu = null; void tick().then(() => (hiddenButton ?? input)?.focus()); }} />
{/if}

<style>
  .grid-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .3rem .6rem; border-bottom: 1px solid var(--border); font-size: .85em; }
  input { min-width: 8rem; flex: 1; padding: .2rem .4rem; color: var(--text); background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; }
  progress { width: 5rem; }
  .error { color: var(--danger); }
</style>
