import { expect, test, vi } from 'vitest';
import { GridActions } from './grid-actions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('a live range response is copied whole after the read resolves', async () => {
  const response = deferred<string>(), copyText = vi.fn(async () => {});
  const actions = new GridActions(() => true, () => {});
  const work = actions.run(() => response.promise, copyText);
  expect(copyText).not.toHaveBeenCalled();
  response.resolve('full\tvalue\n"tail"');
  await work;
  expect(copyText).toHaveBeenCalledExactlyOnceWith('full\tvalue\n"tail"');
});

test('a range response after view destruction cannot write the clipboard', async () => {
  const response = deferred<string>(), copyText = vi.fn(async () => {});
  // Closing a tab leaves its generation unchanged.
  const actions = new GridActions(() => true, () => {});
  const work = actions.run(() => response.promise, copyText);
  actions.destroy();
  response.resolve('stale range');
  await expect(work).rejects.toEqual({ code: 'cancelled' });
  expect(copyText).not.toHaveBeenCalled();
  expect(actions.current()).toBe(false);
});

test('a save-dialog response after view destruction cannot start an export', async () => {
  const response = deferred<string | null>(), gridExport = vi.fn(async (_path: string) => 42);
  const actions = new GridActions(() => true, () => {});
  const work = actions.run(() => response.promise, path => path === null ? undefined : gridExport(path));
  actions.destroy();
  response.resolve('/chosen/result.csv');
  await expect(work).rejects.toEqual({ code: 'cancelled' });
  expect(gridExport).not.toHaveBeenCalled();
});

test.each(['generation', 'revision', 'collection'] as const)('a changed %s still discards a delayed response', async kind => {
  let generation = 0, revision = 0, collection = 'first';
  const response = deferred<string>(), apply = vi.fn();
  const actions = new GridActions(() => generation === 0, () => {});
  const work = actions.run(() => response.promise, apply, () => revision === 0 && collection === 'first');
  if (kind === 'generation') generation++;
  if (kind === 'revision') revision++;
  if (kind === 'collection') collection = 'second';
  response.resolve('old');
  await expect(work).rejects.toEqual({ code: 'cancelled' });
  expect(apply).not.toHaveBeenCalled();
});

test('destroyed views cannot begin another read or save dialog', async () => {
  const read = vi.fn(async () => 'result'), apply = vi.fn();
  const actions = new GridActions(() => true, () => {});
  actions.destroy();
  await expect(actions.run(read, apply)).rejects.toEqual({ code: 'cancelled' });
  expect(read).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

test('destroying a view still cancels an export that already started', async () => {
  const started = deferred<void>(), result = deferred<number>(), gridExportCancel = vi.fn();
  let exporting: number | null = null;
  const actions = new GridActions(() => true, () => {
    expect(actions.current()).toBe(false);
    if (exporting !== null) gridExportCancel(exporting);
  });
  const gridExport = vi.fn((_path: string) => { started.resolve(); return result.promise; });
  const work = actions.run(async () => '/chosen/result.csv', path => {
    exporting = 17;
    return gridExport(path);
  });
  await started.promise;
  actions.destroy();
  actions.destroy();
  expect(gridExport).toHaveBeenCalledExactlyOnceWith('/chosen/result.csv');
  expect(gridExportCancel).toHaveBeenCalledExactlyOnceWith(17);
  result.resolve(42);
  await expect(work).resolves.toBe(42);
});

test('cancelling a live save dialog does not start an export', async () => {
  const gridExport = vi.fn(async (_path: string) => 42), actions = new GridActions(() => true, () => {});
  await actions.run(async () => null, path => path === null ? undefined : gridExport(path));
  expect(gridExport).not.toHaveBeenCalled();
  expect(actions.current()).toBe(true);
});
