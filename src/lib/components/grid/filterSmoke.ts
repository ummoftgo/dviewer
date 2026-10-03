import { tick } from 'svelte';
import type { DocTab } from '../../state/docs.svelte';
import { waitSearch } from '../markdown/searchSmoke';
import type { GridPredicate } from '../../ipc';

function controls(): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>('main .grid-controls');
  if (!form) throw new Error('grid filter controls missing');
  return form;
}
function button(action: string): HTMLButtonElement {
  const found = controls().querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (!found) throw new Error('grid filter action missing: ' + action);
  return found;
}
async function openBuilder() {
  if (button('grid-predicates').getAttribute('aria-expanded') !== 'true') button('grid-predicates').click();
  await tick();
}
async function add(condition: GridPredicate) {
  button('grid-predicate-add').click(); await tick();
  const row = [...controls().querySelectorAll<HTMLElement>('.condition-row')].at(-1)!;
  const select = row.querySelectorAll<HTMLSelectElement>('select');
  select[0].value = String(condition.column);
  select[0].dispatchEvent(new Event('change', { bubbles: true })); await tick();
  select[1].value = condition.op;
  select[1].dispatchEvent(new Event('change', { bubbles: true })); await tick();
  const input = row.querySelector<HTMLInputElement>('input');
  if (input) { input.value = condition.value; input.dispatchEvent(new Event('input', { bubbles: true })); }
  await tick();
}
async function apply(tab: DocTab, shown: number, conditions: number) {
  const request = tab.order.request;
  button('grid-apply').click();
  await waitSearch(() => tab.order.request > request && !tab.order.running, 'typed filter did not finish', 60_000);
  if (tab.order.error || tab.order.stats?.shown !== shown || tab.order.predicates.length !== conditions) {
    throw new Error('typed filter result changed: ' + JSON.stringify({ error: tab.order.error, stats: tab.order.stats, predicates: tab.order.predicates }));
  }
  await tick();
}
async function clear(tab: DocTab) {
  button('grid-filter-clear').click();
  await waitSearch(() => !tab.order.running && tab.order.stats === null && tab.order.predicates.length === 0 && tab.order.filter === '', 'filter clear did not restore source rows');
  await tick();
}

/** Four records in workflow-filter.jsonl, exercised through actual form events. */
export async function checkGridPredicates(tab: DocTab) {
  const saved = { sort: tab.order.sort, filter: tab.order.filter, column: tab.order.filterColumn, predicates: tab.order.predicates.map(p => ({ ...p })) };
  try {
    await waitSearch(() => !!document.querySelector('main .grid-controls'), 'filter fixture did not render');
    if (tab.tableStats?.rowCount !== 4) throw new Error('typed filter fixture should have four rows');
    await openBuilder();
    await add({ column: 0, op: 'gt', value: '1.5' });
    await add({ column: 1, op: 'contains', value: 'keep' });
    await apply(tab, 1, 2);
    await clear(tab);
    for (const op of ['null', 'empty', 'missing'] as const) {
      await add({ column: 2, op, value: '' });
      await apply(tab, 1, 1);
      await clear(tab);
    }
    await add({ column: 2, op: 'equals', value: 'null' });
    await apply(tab, 1, 1);
    await clear(tab);
    // Validate the builder prevents invalid numeric submission before IPC.
    await add({ column: 0, op: 'gt', value: 'NaN' });
    if (!button('grid-apply').disabled || !controls().querySelector('[role="alert"]')) throw new Error('invalid numeric condition was accepted by the form');
    // Clear is only visible for applied filters, so remove the pending invalid row.
    controls().querySelector<HTMLButtonElement>('.condition-row button')!.click(); await tick();
    button('grid-predicates').click(); await tick();
    if (controls().querySelector('.conditions')) throw new Error('filter builder did not close');
    return { andShown: 1, distinctAbsenceKinds: 3, literalNullShown: 1 };
  } finally {
    await tab.applyOrder(saved.sort, saved.filter, saved.column, saved.predicates);
  }
}

/** Use a large generated JSONL fixture so cancellation remains observable. */
export async function checkGridPredicateCancel(tab: DocTab) {
  const saved = { sort: tab.order.sort, filter: tab.order.filter, column: tab.order.filterColumn, predicates: tab.order.predicates.map(p => ({ ...p })) };
  try {
    await waitSearch(() => !!document.querySelector('main .grid-controls'), 'cancel grid did not render');
    await openBuilder();
    await add({ column: 0, op: 'contains', value: 'not-present-cancel-probe' });
    button('grid-apply').click();
    await tick();
    if (!tab.order.running) throw new Error('cancel fixture completed before the cancel action could be tested');
    button('grid-filter-cancel').click();
    await waitSearch(() => !tab.order.running && tab.order.predicates.length === 0 && tab.order.stats === null, 'typed scan cancel did not reset view', 60_000);
    if (tab.order.error) throw new Error('cancelled typed filter left an error: ' + tab.order.error);
    await tick();
    await add({ column: 0, op: 'contains', value: 'not-present-cancel-probe' });
    await apply(tab, 0, 1);
    await clear(tab);
    return { cancelled: true, reusable: true };
  } finally { await tab.applyOrder(saved.sort, saved.filter, saved.column, saved.predicates); }
}
