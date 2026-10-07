import { tick } from 'svelte';
import { gridStates, workspace, type DocTab } from './state/docs.svelte';
import { GridStateStore } from './grid-state';
import { gridCellText } from './ipc';
import { t } from './i18n';

async function waitFor(test: () => boolean, message: string): Promise<void> {
  const until = Date.now() + 60000;
  while (!test()) {
    if (Date.now() > until) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

const view = (tab: DocTab) => JSON.stringify({ widths: tab.columnWidths, order: tab.columnOrder,
  hidden: tab.hiddenColumns, frozen: tab.frozenCount, mode: tab.tableWidthMode, ratios: tab.tableFillRatios,
  sort: tab.order.sort, filter: tab.order.filter, filterColumn: tab.order.filterColumn, predicates: tab.order.predicates });

/** Actual menu/resize controls, followed by reopen and backend source reload. */
export async function checkGridState(initial: DocTab): Promise<Record<string, unknown>> {
  if (initial.meta.source.type !== 'file') throw new Error('grid state smoke needs a file source');
  const path = initial.meta.source.path;
  let tab = initial;
  const settled = () => tab.gridStateReady && !tab.gridStateRestoring && !tab.order.running
    && !!tab.tableStats && tab.columnWidths.length === tab.tableStats.columnCount;
  await waitFor(settled, 'grid state did not finish initial restoration');
  if ((tab.tableStats?.columnCount ?? 0) < 3) throw new Error('grid state fixture needs at least three columns');
  const saved = await tab.savedGridState();
  const menu = async (column: number, label: string) => {
    const header = document.querySelector<HTMLElement>(`main .grid .head [data-column="${column}"]`);
    if (!header) throw new Error('grid state header is missing');
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await tick();
    const button = [...document.querySelectorAll<HTMLButtonElement>('.menu button')]
      .find(b => b.querySelector('.label')?.textContent === label);
    if (!button || button.disabled) throw new Error('grid state menu action missing: ' + label);
    button.click(); await tick();
  };
  try {
    await tab.applyOrder(null, '', null, []);
    tab.resetColumnView();
    tab.tableWidthMode = 'scroll'; await tick();
    const column = tab.tableStats!.columnCount - 1;
    await menu(column, t('grid.moveLeft'));
    await menu(0, t('grid.hideColumn'));
    await menu(column, t('grid.freezeThrough'));
    const grip = document.querySelector<HTMLElement>(`main .grid .head [data-column="${column}"] .grip`);
    if (!grip) throw new Error('grid state resize control is missing');
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    await tick();
    const scalar = await gridCellText(tab.id, 0, column);
    if (!scalar.text) throw new Error('grid state fixture needs a nonempty cell');
    if (!await tab.applyOrder({ column, descending: true }, scalar.text, column, [])) throw new Error('grid state filter failed');
    await tick();
    const expected = view(tab);
    await tab.rememberGridState(); await gridStates.flush();
    const persisted = await new GridStateStore().get(tab.gridIdentity!, null);
    if (!persisted || persisted.filter !== scalar.text) throw new Error('grid state durable store did not contain the filter');
    await workspace.close(tab.id);
    const reopened = await workspace.openPath(path);
    if (!reopened) throw new Error('grid state file did not reopen');
    tab = reopened;
    await waitFor(settled, 'grid state reopen did not settle');
    if (view(tab) !== expected || tab.gridStateNotice !== 'restored') throw new Error('grid state reopen lost view choices');
    if (!document.querySelector('main')?.textContent?.includes(t('gridState.restored'))) throw new Error('restored filter notice is missing');
    await workspace.reload(tab.id);
    await waitFor(settled, 'grid state reread did not settle');
    if (view(tab) !== expected) throw new Error('grid state reread lost view choices');
    await tab.applyOrder(null, '', null, []);
    await tick();
    if (tab.order.filter || tab.order.sort || tab.gridStateNotice) throw new Error('grid state filter clear did not clear the restored notice');
    return { reopened: true, reread: true, persisted: true, columns: tab.tableStats!.columnCount };
  } finally {
    // Keep later fixture checks independent of this scenario's chosen view.
    await tab.applyOrder(null, '', null, []);
    if (saved) await tab.restoreGridState(saved);
    else { tab.resetColumnView(); tab.columnWidths = []; }
    await tab.rememberGridState(); await gridStates.flush();
  }
}
