import { expect, test, vi } from 'vitest';
import { projectedRowText, rowText } from './copy';
import * as ipc from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';

vi.mock('../../ipc', () => ({ gridCellText: vi.fn(), gridRowText: vi.fn() }));
const tab = () => ({ id: 1, meta: { generation: 0 }, collection: 'table', order: { revision: 0 },
  columnOrder: [], hiddenColumns: [] }) as unknown as DocTab;
const value = (text: string) => ({ text, truncated: false });

test('default columns keep original row text and CSV quoting', async () => {
  const original = value('"a,b",c');
  vi.mocked(ipc.gridRowText).mockResolvedValueOnce(original);
  expect(await rowText(tab(), 12, 2)).toEqual(original);
  expect(ipc.gridRowText).toHaveBeenLastCalledWith(1, 12);
});

test('copy reads full values in visible display order', async () => {
  const state = tab(); state.columnOrder = [2, 0, 1]; state.hiddenColumns = [1];
  const calls: number[] = [];
  vi.mocked(ipc.gridCellText).mockImplementation(async (_id, _row, column) => {
    calls.push(column); return value(['full\tvalue', 'hidden', 'quote"\nline'][column]);
  });
  expect(await rowText(state, 5, 3)).toEqual(value('"quote""\nline"\t"full\tvalue"'));
  expect(calls).toEqual([2, 0]);
});

test('empty fields retain separators and cell truncation propagates', async () => {
  const cells = [value(''), value(''), { text: 'last', truncated: true }];
  expect(await projectedRowText([0, 1, 2], async column => cells[column])).toEqual({ text: '\t\tlast', truncated: true });
});

test('resolving a displayed row cannot cross a collection switch', async () => {
  const state = tab();
  let resolve!: (row: number) => void;
  const pending = rowText(state, new Promise<number>(done => { resolve = done; }), 2);
  state.collection = 'other'; resolve(7);
  await expect(pending).rejects.toEqual({ code: 'cancelled' });
});

test('the byte ceiling stops before later cells and never splits an emoji', async () => {
  const read = vi.fn(async () => value('😀ab'));
  expect(await projectedRowText([0, 1, 2], read, 5)).toEqual({ text: '😀a', truncated: true });
  expect(read).toHaveBeenCalledTimes(1);
});

test.each(['collection', 'generation', 'order'] as const)('changed %s cancels delayed copy', async kind => {
  const state = tab(); state.hiddenColumns = [1];
  vi.mocked(ipc.gridCellText).mockImplementationOnce(async () => {
    if (kind === 'collection') state.collection = 'other';
    if (kind === 'generation') state.meta.generation = 1;
    if (kind === 'order') state.order.revision++;
    return value('old');
  });
  await expect(rowText(state, 0, 2)).rejects.toEqual({ code: 'cancelled' });
});
