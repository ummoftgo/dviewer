import { onDestroy, untrack } from 'svelte';
import { gridStates, type DocTab } from './docs.svelte';
import { gridOrderCancel } from '../ipc';

/** Observe committed view choices, excluding scans and transient drag rendering. */
export function watchGridState(readTab: () => DocTab): void {
  $effect(() => {
    const tab = readTab();
    // Subscribe without serializing potentially large accepted filter values.
    [tab.gridStateReady, tab.gridStateRestoring, tab.gridSchema, tab.collection,
      tab.frozenCount, tab.tableWidthMode, tab.order.sort?.column, tab.order.sort?.descending,
      tab.order.filter, tab.order.filterColumn, tab.order.running, tab.tableStats?.hasHeader,
      tab.tableStats?.plain, tab.tableStats?.expanded, tab.gridStats?.formulas];
    [tab.columnWidths, tab.columnOrder, tab.hiddenColumns, tab.tableFillRatios].forEach(values => values?.forEach(value => { void value; }));
    tab.order.predicates.forEach(predicate => { void predicate.column; void predicate.op; void predicate.value; });
    untrack(() => { void tab.rememberGridState(); });
  });
  onDestroy(() => {
    const tab = readTab();
    if (tab.gridStateRestoring) {
      // Leaving during restoration postpones the expensive scan until revisiting.
      tab.order.request++;
      tab.order.running = false;
      tab.gridStateRestoring = false;
      void gridOrderCancel(tab.id).catch(() => {});
    }
    void tab.rememberGridState().then(() => gridStates.flush());
  });
}
