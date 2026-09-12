import { expect, test, vi } from 'vitest';
import { treePath } from '../../ipc';
import { forgetDoc, pathOf } from './actions';

vi.mock('../../ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../ipc')>(), treePath: vi.fn(),
}));

test('a path received after invalidation cannot repopulate the new document cache', async () => {
  let resolve!: (value: string) => void;
  vi.mocked(treePath).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce('$.new');
  const old = pathOf(1, 0);
  forgetDoc(1);
  resolve('$.old'); await old;
  expect(await pathOf(1, 0)).toBe('$.new');
  expect(await pathOf(1, 0)).toBe('$.new');
  expect(treePath).toHaveBeenCalledTimes(2);
  forgetDoc(1);
});
