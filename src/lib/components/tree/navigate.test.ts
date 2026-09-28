import { expect, test, vi } from 'vitest';
import { treeHitRow, treeReveal } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';
import { goToHit } from './navigate';

vi.mock('../../ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../ipc')>(),
  treeReveal: vi.fn(async (_doc: number, node: number) => ({ row: node * 10, stats: {} })),
  // The backend's own list, which holds the previous search until this one ends.
  treeHitRow: vi.fn(async () => ({ row: 999, stats: {} })),
}));

function tab(nodes: number[]) {
  return {
    id: 1, treeStats: null, pendingRow: null, error: null,
    search: { seq: 5, current: -1, hits: nodes.map(node => ({ node })) },
  } as unknown as DocTab;
}

/** The first hit of a running search went through the backend's hit list — the
 *  previous search's until this one finishes — and parked on the old match. */
test('a hit is revealed by the node its batch carried', async () => {
  const t = tab([4, 7]);
  await goToHit(t, 1);
  expect(treeReveal).toHaveBeenCalledWith(1, 7);
  expect(treeHitRow).not.toHaveBeenCalled();
  expect(t.search.current).toBe(1);
  expect(t.pendingRow).toBe(70);
});

test('a row that answers a replaced search is not parked on', async () => {
  const t = tab([4]);
  const going = goToHit(t, 0);
  t.search.seq += 1;
  await going;
  expect(t.pendingRow).toBeNull();
});
