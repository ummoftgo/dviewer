<script lang="ts">
  import { tick } from 'svelte';
  import { errorMessage, gridOrderCancel, on, type GridSort, type GridPredicate } from "../../ipc";
  import { needsPredicateValue, predicateOps, validPredicates } from '../../grid-predicates';
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
  let predicates = $derived.by(() => { void tab.order.revision; return tab.order.predicates.map(p => ({ ...p })); });
  let builderOpen = $state(false);
  const columnCount = $derived(tab.tableStats?.columnCount ?? tab.columnWidths.length);
  const conditionsValid = $derived(validPredicates(predicates, columnCount));
  function addCondition() {
    if (predicates.length < 32) predicates = [...predicates, { column: 0, op: 'contains', value: '' }];
  }
  function changeCondition(index: number, changed: Partial<GridPredicate>) {
    predicates = predicates.map((p, at) => at === index ? { ...p, ...changed } : p);
  }
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
    if (!disabled && conditionsValid) await tab.applyOrder(sort, filter, draftColumn, predicates);
  }

  export async function sortTo(sort: GridSort | null) { await apply(sort, draft); }
  export function filterColumn(column: number) { draftColumn = column; input?.focus(); }
  export async function clearFilter() { draft = ""; draftColumn = null; predicates = []; await apply(tab.order.sort, ""); }

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
        if (tab.gridStateRestoring) {
          tab.gridStateRestoring = false;
          tab.gridStateReady = true;
          tab.gridStateNotice = null;
        }
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
  <button class="btn btn-ghost" type="submit" data-action="grid-apply" disabled={disabled || !conditionsValid}>{t("grid.apply")}</button>
  <button class="btn btn-ghost" type="button" data-action="grid-predicates" {disabled} aria-expanded={builderOpen}
    onclick={() => { builderOpen = !builderOpen; }}>{t('gridFilter.conditions', { n: predicates.length })}</button>
  {#if tab.order.filter || tab.order.predicates.length}
    <button class="btn btn-ghost" type="button" data-action="grid-filter-clear" {disabled} onclick={() => { void clearFilter(); }}>{t('grid.filterClear')}</button>
  {/if}
  {#if tab.order.running}
    <progress max={tab.order.progress?.total || 1} value={tab.order.progress?.done ?? 0} aria-label={t("grid.working")}></progress>
    <span>{t("grid.working")}</span>
    <button class="btn btn-ghost" type="button" data-action="grid-filter-cancel" onclick={cancel}>{t("grid.cancel")}</button>
  {:else if tab.order.stats}
    <span>{t("grid.shown", { shown: n(tab.order.stats.shown), total: n(tab.order.stats.total) })}</span>
    <span>{formatBytes(tab.order.stats.indexBytes)}</span>
  {/if}
  {#if tab.order.filter && tab.order.filterColumn !== null}<span>{t("grid.filterIn", { column: columnName(tab.order.filterColumn) })}</span>{/if}
  {#if tab.order.sort}<span>{t("grid.sorted", { column: columnName(tab.order.sort.column) })}</span>{/if}
  {#if tab.order.error}<span class="error" role="alert">{tab.order.error}</span>{/if}
  {#if builderOpen}
    <div class="conditions">
      <p>{t('gridFilter.hint')}</p>
      {#each predicates as predicate, index}
        <div class="condition-row">
          <span>{t('gridFilter.and')}</span>
          <select aria-label={t('gridFilter.column')} value={predicate.column} {disabled}
            onchange={(event) => changeCondition(index, { column: Number(event.currentTarget.value) })}>
            {#each Array.from({ length: columnCount }, (_, column) => column) as column}
              <option value={column}>{columnName(column)}</option>
            {/each}
          </select>
          <select aria-label={t('gridFilter.operator')} value={predicate.op} {disabled}
            onchange={(event) => { const op = event.currentTarget.value as GridPredicate['op']; changeCondition(index, { op, value: needsPredicateValue(op) ? predicate.value : '' }); }}>
            {#each predicateOps as op}<option value={op}>{t(`gridFilter.${op}`)}</option>{/each}
          </select>
          {#if needsPredicateValue(predicate.op)}
            <input aria-label={t('gridFilter.value')} value={predicate.value} {disabled}
              oninput={(event) => changeCondition(index, { value: event.currentTarget.value })} />
          {/if}
          <button class="btn btn-ghost" type="button" aria-label={t('gridFilter.remove')} {disabled}
            onclick={() => { predicates = predicates.filter((_, at) => at !== index); }}>×</button>
        </div>
      {/each}
      <button class="btn btn-ghost" type="button" data-action="grid-predicate-add" disabled={disabled || predicates.length >= 32 || columnCount === 0} onclick={addCondition}>{t('gridFilter.add')}</button>
      {#if !conditionsValid}<span class="error" role="alert">{t('gridFilter.invalid')}</span>{/if}
    </div>
  {/if}
</form>

{#if hiddenMenu}
  <ContextMenu x={hiddenMenu.x} y={hiddenMenu.y}
    items={tab.hiddenColumns.map(column => ({ key: String(column), label: columnName(column), action: () => revealColumn(tab, column) }))}
    onClose={() => { hiddenMenu = null; void tick().then(() => (hiddenButton ?? input)?.focus()); }} />
{/if}

<style>
  .grid-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .3rem .6rem; border-bottom: 1px solid var(--border); font-size: .85em; }
  input { min-width: 8rem; flex: 1; padding: .2rem .4rem; color: var(--text); background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; }
  .conditions { flex-basis: 100%; display: grid; gap: .3rem; }
  .conditions p { margin: .2rem 0; color: var(--text-muted); }
  .condition-row { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; }
  select { max-width: 18rem; padding: .2rem; color: var(--text); background: var(--bg-inset); border: 1px solid var(--border); font: inherit; }
  progress { width: 5rem; }
  .error { color: var(--danger); }
</style>
