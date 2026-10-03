import { describe, expect, test, vi } from 'vitest';
import { GridStateStore, gridSourceKey, readGridState, readGridStates, jsonStringBytes, jsonUtf8Bytes, MAX_GRID_STATE_BYTES, type SavedGridState } from './grid-state';
import { validPredicates, MAX_PREDICATE_VALUE_BYTES } from './grid-predicates';

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
  test('an applied predicate above 1 MiB remains persistable with the column layout', () => {
    const state = saved({ predicates: [{ column: 0, op: 'contains', value: 'x'.repeat(1024 * 1024 + 1) }] });
    expect(validPredicates(state.predicates, 2)).toBe(true);
    const stored = readGridState(state);
    expect(stored?.predicates).toEqual(state.predicates);
    expect(stored?.widths).toEqual([180, 90]);
  });
  test('predicate persistence follows the exact UTF-8 byte limit instead of character count', () => {
    const bytes = MAX_PREDICATE_VALUE_BYTES;
    const value = '界'.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3);
    const state = saved({ predicates: [{ column: 0, op: 'equals', value }] });
    expect(new TextEncoder().encode(value).byteLength).toBe(bytes);
    expect(validPredicates(state.predicates, 2)).toBe(true);
    expect(readGridState(state)?.predicates[0].value.length).toBe(value.length);
    state.predicates[0].value += 'a';
    expect(validPredicates(state.predicates, 2)).toBe(false);
    expect(readGridState(state)).toBeNull();
  });
  test('the existing string filter has no arbitrary 1 MiB character cap', () => {
    const state = saved({ filter: 'x'.repeat(1024 * 1024 + 1) });
    expect(readGridState(state)?.filter.length).toBe(state.filter.length);
  });
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

describe('bounded UTF-8 grid state storage', () => {
  const encoder = new TextEncoder();
  const envelope = (entries: SavedGridState[]) => ({ version: 1, entries });
  test.each(['', 'ASCII', '"\\\b\f\n\r\t\x00\x1f', '한글界', '😀', '\ud800', '\udfff', '\ud800A\udfff', '😀\ud800\x00'])
    ('JSON string byte accounting exactly matches serialization for %j', value => {
      expect(jsonStringBytes(value)).toBe(encoder.encode(JSON.stringify(value)).byteLength);
    });
  test('nested state and envelope accounting includes keys, delimiters and escaped conditions', () => {
    const state = saved({ filter: '\x00😀"\ud800', predicates: [{ column: 1, op: 'equals', value: '\n界\\\udfff' }] });
    expect(jsonUtf8Bytes(envelope([state]))).toBe(encoder.encode(JSON.stringify(envelope([state]))).byteLength);
    expect(MAX_GRID_STATE_BYTES).toBe(64 * 1024 * 1024);
  });
  test.each([0, 1, -1])('the exact byte cap %+d is applied before writing', async difference => {
    const state = saved({ filter: '界😀\x00'.repeat(40) });
    const exact = jsonUtf8Bytes(envelope([state]));
    const write = vi.fn(async (_value: unknown) => {}), notice = vi.fn();
    const store = new GridStateStore(async () => undefined, write, undefined, notice, exact + difference);
    await store.remember(state); await store.flush();
    const snapshot = write.mock.calls[0][0] as { entries: SavedGridState[] };
    expect(jsonUtf8Bytes(snapshot)).toBeLessThanOrEqual(exact + difference);
    expect(snapshot.entries[0].filter).toBe(difference < 0 ? '' : state.filter);
    expect(snapshot.entries[0].widths).toEqual(state.widths);
    expect(notice.mock.calls).toEqual(difference < 0 ? [['conditionsNotSaved']] : []);
  });
  test('oldest complete entries are pruned at the byte bound in memory and on load', async () => {
    const states = ['a', 'b', 'c'].map(identity => saved({ identity, filter: 'x'.repeat(100) }));
    const budget = jsonUtf8Bytes(envelope(states.slice(0, 2)));
    const notice = vi.fn(), write = vi.fn(async (_value: unknown) => {});
    const store = new GridStateStore(async () => undefined, write, undefined, notice, budget);
    for (const state of states) await store.remember(state);
    await store.flush();
    expect(await store.get('a', null)).toBeNull();
    expect((write.mock.calls[0][0] as { entries: SavedGridState[] }).entries.map(s => s.identity)).toEqual(['b', 'c']);
    expect(notice).toHaveBeenCalledExactlyOnceWith('pruned');
    const loadedNotice = vi.fn();
    expect(readGridStates(envelope(states), budget, loadedNotice).map(s => s.identity)).toEqual(['b', 'c']);
    expect(loadedNotice).toHaveBeenCalledExactlyOnceWith('pruned');
  });
  test('an oversized replacement preserves its new layout and removes previously stored conditions', async () => {
    const previous = saved({ filter: 'old accepted filter' });
    const notice = vi.fn(), write = vi.fn(async (_value: unknown) => {});
    const budget = jsonUtf8Bytes(envelope([previous])) + 10;
    const store = new GridStateStore(async () => envelope([previous]), write, undefined, notice, budget);
    const large = saved({ widths: [300, 100], filter: '\x00'.repeat(100), predicates: [{ column: 0, op: 'contains', value: 'z'.repeat(100) }] });
    await store.remember(large); await store.remember(large); await store.flush();
    const result = await store.get(previous.identity, null);
    expect(result?.widths).toEqual([300, 100]);
    expect(result?.order).toEqual([1, 0]);
    expect(result?.filter).toBe(''); expect(result?.filterColumn).toBeNull();
    expect(result?.predicates).toEqual([]); expect(result?.sort).toBeNull();
    expect(notice).toHaveBeenCalledExactlyOnceWith('conditionsNotSaved');
    expect(jsonUtf8Bytes(write.mock.calls[0][0])).toBeLessThanOrEqual(budget);
    const reopen = new GridStateStore(async () => write.mock.calls[0][0]);
    expect((await reopen.get(previous.identity, null))?.filter).toBe('');
  });
  test('load applies layout fallback to the newest oversized duplicate rather than restoring old conditions', () => {
    const previous = saved({ filter: 'old filter' });
    const large = saved({ widths: [320, 80], filter: '\x00'.repeat(1000) });
    const budget = jsonUtf8Bytes(envelope([previous])) + 10;
    const notice = vi.fn();
    const loaded = readGridStates(envelope([previous, large]), budget, notice);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].widths).toEqual([320, 80]);
    expect(loaded[0].filter).toBe('');
    expect(notice).toHaveBeenCalledExactlyOnceWith('conditionsNotSaved');
  });
  test('accepted predicates whose escaped JSON exceeds the production budget preserve layout and report the omission', async () => {
    const value = '\x00'.repeat(6 * 1024 * 1024);
    const state = saved({ predicates: [{ column: 0, op: 'contains', value }, { column: 1, op: 'equals', value }] });
    expect(validPredicates(state.predicates, 2)).toBe(true);
    const write = vi.fn(async (_value: unknown) => {}), notice = vi.fn();
    const store = new GridStateStore(async () => undefined, write, undefined, notice);
    await store.remember(state); await store.flush();
    const snapshot = write.mock.calls[0][0] as { entries: SavedGridState[] };
    expect(snapshot.entries[0].widths).toEqual([180, 90]);
    expect(snapshot.entries[0].predicates).toEqual([]);
    expect(snapshot.entries[0].filter).toBe('');
    expect(jsonUtf8Bytes(snapshot)).toBeLessThanOrEqual(MAX_GRID_STATE_BYTES);
    expect(notice).toHaveBeenCalledExactlyOnceWith('conditionsNotSaved');
  });
  test('oversized queries are never deep copied or serialized before fallback', async () => {
    const large = saved({ filter: '\x00'.repeat(10000) });
    const budget = jsonUtf8Bytes(envelope([saved()])) + 10;
    const store = new GridStateStore(async () => undefined, async () => {}, undefined, undefined, budget);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      await store.remember(large); await store.flush();
      expect(stringify.mock.calls.some(([value]) => value === large || (typeof value === 'object' && value !== null && !Array.isArray(value) && 'entries' in value))).toBe(false);
    } finally { stringify.mockRestore(); }
  });
  test('the 200 entry count bound also keeps the newest states', () => {
    const states = Array.from({ length: 201 }, (_, at) => saved({ identity: String(at) }));
    const notice = vi.fn();
    const kept = readGridStates(envelope(states), MAX_GRID_STATE_BYTES, notice);
    expect(kept).toHaveLength(200);
    expect(kept[0].identity).toBe('1');
    expect(kept.at(-1)?.identity).toBe('200');
    expect(notice).toHaveBeenCalledExactlyOnceWith('pruned');
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
