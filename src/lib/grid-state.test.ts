import { describe, expect, test, vi } from 'vitest';
import { GridStateStore, gridSourceKey, readGridState, readGridStates, type SavedGridState } from './grid-state';

function saved(change: Partial<SavedGridState> = {}): SavedGridState {
  return { identity: 'file:a.csv', collection: null, schema: '["name","age"]', widths: [180, 90],
    order: [1, 0], hidden: [0], frozen: 1, widthMode: 'fill', ratios: [2, 1],
    sort: { column: 1, descending: true }, filter: 'complete value', filterColumn: 0,
    predicates: [{ column: 1, op: 'gte', value: '12.5' }], hasHeader: true, plain: false, expanded: false, ...change };
}

describe('persistent grid source identity', () => {
  test('normalizes file separators and keeps URL identity', () => {
    expect(gridSourceKey({ type: 'file', path: 'C:\\a.csv' })).toBe(gridSourceKey({ type: 'file', path: 'C:/a.csv' }));
    expect(gridSourceKey({ type: 'url', url: 'https://example.org/a.csv' })).not.toBe(gridSourceKey({ type: 'url', url: 'https://example.org/b.csv' }));
  });
  test('tree slices use source and path instead of transient document and node IDs', () => {
    const parent = { type: 'file' as const, path: '/a.json' };
    const slice = { type: 'treeSlice' as const, parent: 1, generation: 3, node: 100, path: '$.items' };
    expect(gridSourceKey(slice, parent)).toBe(gridSourceKey({ ...slice, parent: 50, generation: 8, node: 800 }, parent));
    expect(gridSourceKey(slice, parent)).not.toBe(gridSourceKey({ ...slice, path: '$.other' }, parent));
    expect(gridSourceKey(slice)).toBeNull();
    expect(gridSourceKey({ ...slice, path: '' }, parent)).toBeNull();
    expect(gridSourceKey({ type: 'text' })).toBeNull();
  });
  test('archive identity includes root and full entry chain, including changed names', () => {
    const source = { type: 'archiveEntry' as const, root: { type: 'file' as const, path: '/a.zip' }, entries: [{ index: 2, name: 'a.csv' }] };
    expect(gridSourceKey(source)).not.toBe(gridSourceKey({ ...source, entries: [{ index: 2, name: 'b.csv' }] }));
  });
});

describe('stored column schema and controls', () => {
  test('round trip copies every committed view choice', () => {
    const input = saved();
    const result = readGridState(JSON.parse(JSON.stringify(input)))!;
    expect(result).toEqual(input);
    result.widths[0] = 300;
    expect(input.widths[0]).toBe(180);
  });
  test.each([
    { order: [0, 0] }, { order: [0] }, { hidden: [0, 1] }, { hidden: [-1] },
    { frozen: 2 }, { widths: [63, 90] }, { widths: [180] }, { widths: [NaN, 90] },
    { sort: { column: 2, descending: false } }, { filterColumn: 2 }, { ratios: [0, 1] },
    { ratios: [1e308, 1e308] },
    { schema: 'broken' }, { schema: '[]' }, { hasHeader: 'yes' },
    { predicates: [{ column: 1, op: 'gte', value: '12px' }] },
    { predicates: [{ column: 1, op: 'gte', value: '1e999' }] },
    { predicates: [{ column: 2, op: 'empty', value: '' }] },
    { predicates: [{ column: 1, op: 'sql', value: '' }] },
  ])('rejects malformed state %j', change => {
    expect(readGridState({ ...saved(), ...change })).toBeNull();
  });
  test('no configured widths/order and missing old predicates are valid', () => {
    expect(readGridState({ ...saved({ widths: [], order: [], ratios: null }), predicates: undefined })?.predicates).toEqual([]);
  });
  test('store version and duplicate identity+collection entries are guarded', () => {
    expect(readGridStates({ version: 2, entries: [saved()] })).toEqual([]);
    expect(readGridStates({ version: 1, entries: [saved(), saved(), saved({ collection: 'other' }), {}] })).toHaveLength(2);
  });
});

describe('grid state write queue', () => {
  test('loads once, isolates collections and remembers immediately before a delayed write', async () => {
    const read = vi.fn(async () => ({ version: 1, entries: [saved()] }));
    const write = vi.fn(async (_v: unknown) => {});
    const store = new GridStateStore(read, write);
    await store.remember(saved({ collection: 'sheet 2', filter: 'new' }));
    expect((await store.get('file:a.csv', null))?.filter).toBe('complete value');
    expect((await store.get('file:a.csv', 'sheet 2'))?.filter).toBe('new');
    expect(await store.preferredCollection('file:a.csv')).toBe('sheet 2');
    expect(await store.get('other file', null)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await store.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith({ version: 1, entries: [saved(), saved({ collection: 'sheet 2', filter: 'new' })] });
  });
  test('a failed write reports failure and does not poison the next write', async () => {
    const write = vi.fn(async (_v: unknown) => {}).mockRejectedValueOnce(new Error('disk full'));
    const failed = vi.fn();
    const store = new GridStateStore(async () => undefined, write, failed);
    await store.remember(saved()); await store.flush();
    expect(failed).toHaveBeenCalledOnce();
    await store.remember(saved({ filter: 'recovered' })); await store.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
  test('revisiting an unchanged collection restores it as the next preferred collection', async () => {
    const store = new GridStateStore(async () => undefined, async () => {});
    await store.remember(saved({ collection: 'first' }));
    await store.remember(saved({ collection: 'second' }));
    await store.remember(saved({ collection: 'first' }));
    expect(await store.preferredCollection('file:a.csv')).toBe('first');
    await store.flush();
  });
  test('serialized writes preserve the newer snapshot after an in-flight older write', async () => {
    let release!: () => void;
    const write = vi.fn(async (_v: unknown) => {});
    write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const store = new GridStateStore(async () => undefined, write);
    await store.remember(saved());
    const old = store.flush();
    await Promise.resolve(); await Promise.resolve();
    await store.remember(saved({ filter: 'latest' }));
    const next = store.flush();
    expect(write).toHaveBeenCalledOnce();
    release(); await old; await next;
    expect((write.mock.calls[1][0] as { entries: SavedGridState[] }).entries[0].filter).toBe('latest');
  });
});
