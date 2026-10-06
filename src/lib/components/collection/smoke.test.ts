import { afterEach, describe, expect, test, vi } from 'vitest';
import { DocTab, gridStates } from '../../state/docs.svelte';
import type { GridStats } from '../../ipc';
import { resetColumns } from '../grid/columns';
import { collectionColumnsReady } from './smoke';

vi.mock('../../persist', () => ({ getValue: vi.fn(async () => undefined), setValue: vi.fn(async () => {}) }));

let nextId = 0;
function collection() {
  const id = ++nextId;
  const tab = new DocTab({ id, title: 'sample.xlsx', kind: 'xlsx', view: 'collection',
    source: { type: 'file', path: `/collection-layout-${id}.xlsx` }, byteLen: 100,
    encoding: { name: 'UTF-8', label: 'UTF-8', source: 'utf8', warning: null }, baseDir: null });
  tab.collection = '매출';
  tab.gridStats = stats(['name', 'count', 'amount']);
  tab.columnWidths = [100, 120, 140];
  tab.tableWidthMode = 'fill';
  tab.gridStateReady = true;
  return tab;
}

function stats(columns: string[]): GridStats {
  return { columns, columnCount: columns.length, rowCount: 2, indexBytes: 100, truncated: false, formulas: false };
}

/** The state transition in CollectionView.select, without mounting a DOM. */
async function select(tab: DocTab, name: string, nextStats: GridStats) {
  const captured = tab.rememberGridState();
  tab.gridStateReady = false;
  tab.gridStateRestoring = true;
  tab.collection = name;
  tab.gridStats = null;
  resetColumns(tab);
  tab.resetColumnView();
  expect(tab.columnWidths).toEqual([]);
  expect(tab.tableFillRatios).toBeNull();
  expect(tab.columnOrder).toEqual([]);
  expect(tab.hiddenColumns).toEqual([]);
  expect(tab.frozenCount).toBe(0);
  expect(collectionColumnsReady(tab, '0', [])).toBe(false);
  await captured;
  tab.gridStats = nextStats;
  await tab.restoreGridState(await tab.savedGridState());
}

afterEach(async () => { await gridStates.flush(); });

describe('collection width smoke projection readiness', () => {
  test('an unconfigured sheet still requires all source columns in order', () => {
    const tab = collection();
    expect(collectionColumnsReady(tab, '3', [0, 1, 2])).toBe(true);
    expect(collectionColumnsReady(tab, '2', [0, 1])).toBe(false);
    expect(collectionColumnsReady(tab, '3', [2, 1, 0])).toBe(false);
  });

  test('reselecting the current sheet restores hidden columns before layout settles', async () => {
    const tab = collection();
    tab.columnOrder = [2, 1, 0];
    tab.hiddenColumns = [0];
    tab.frozenCount = 1;
    tab.tableFillRatios = [99, 1, 1];
    await select(tab, '매출', tab.gridStats!);
    expect(tab.columnWidths).toEqual([100, 120, 140]);
    expect(tab.columnOrder).toEqual([2, 1, 0]);
    expect(tab.hiddenColumns).toEqual([0]);
    expect(tab.frozenCount).toBe(1);
    expect(tab.tableFillRatios).toEqual([99, 1, 1]);
    expect(tab.gridStateReady).toBe(true);
    expect(tab.gridStateRestoring).toBe(false);
    // DataGrid renders two headers. The old full-schema aria-colcount wait
    // could never succeed, even though restoration and rendering were done.
    expect(collectionColumnsReady(tab, '2', [2, 1])).toBe(true);
    expect(collectionColumnsReady(tab, '3', [2, 1])).toBe(false);
    expect(collectionColumnsReady(tab, '3', [0, 1, 2])).toBe(false);
    tab.resetColumnView();
    expect(collectionColumnsReady(tab, '2', [2, 1])).toBe(false);
    expect(collectionColumnsReady(tab, '3', [0, 1, 2])).toBe(true);
  });

  test('sheet round trips isolate widths, order, hidden columns, frozen count and ratios', async () => {
    const tab = collection();
    const first = tab.gridStats!;
    tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [0]; tab.frozenCount = 1;
    tab.tableFillRatios = [99, 1, 1];
    const second = stats(['note', 'author']);
    await select(tab, '비고', second);
    expect(tab.columnWidths).toEqual([]);
    expect(tab.hiddenColumns).toEqual([]);
    tab.columnWidths = [210, 220]; tab.columnOrder = [1, 0];
    tab.hiddenColumns = [1]; tab.frozenCount = 1; tab.tableWidthMode = 'scroll';
    expect(collectionColumnsReady(tab, '1', [0])).toBe(true);
    await select(tab, '매출', first);
    expect(tab.columnWidths).toEqual([100, 120, 140]);
    expect(tab.columnOrder).toEqual([2, 1, 0]);
    expect(tab.hiddenColumns).toEqual([0]);
    expect(tab.frozenCount).toBe(1);
    expect(tab.tableFillRatios).toEqual([99, 1, 1]);
    expect(tab.tableWidthMode).toBe('fill');
    expect(collectionColumnsReady(tab, '2', [2, 1])).toBe(true);
    await select(tab, '비고', second);
    expect(tab.columnWidths).toEqual([210, 220]);
    expect(tab.columnOrder).toEqual([1, 0]);
    expect(tab.hiddenColumns).toEqual([1]);
    expect(tab.frozenCount).toBe(1);
    expect(tab.tableFillRatios).toBeNull();
    expect(tab.tableWidthMode).toBe('scroll');
    expect(collectionColumnsReady(tab, '1', [0])).toBe(true);
  });

  test.each([
    ['wrong count', '3', [2, 1]],
    ['stale ordering', '2', [1, 2]],
    ['still hidden', '2', [2, 0]],
    ['missing header', '2', [2]],
    ['extra header', '2', [2, 1, 0]],
    ['missing ARIA count', null, [2, 1]],
  ] as const)('rejects a restored projection with %s', (_name, aria, headers) => {
    const tab = collection();
    tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [0];
    expect(collectionColumnsReady(tab, aria, headers)).toBe(false);
  });

  test('source widths must finish loading even when the hidden projection matches', () => {
    const tab = collection();
    tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [0];
    tab.columnWidths = [100, 120];
    expect(collectionColumnsReady(tab, '2', [2, 1])).toBe(false);
    tab.columnWidths = [100, 120, 140];
    expect(collectionColumnsReady(tab, '2', [2, 1])).toBe(true);
  });
});
