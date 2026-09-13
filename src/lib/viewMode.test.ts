import { expect, test } from 'vitest';
import { supportsRaw } from './viewMode';

test('prose and text tables can show their source', () => {
  expect(supportsRaw('prose', 'markdown')).toBe(true);
  expect(supportsRaw('table', 'text')).toBe(true);
});

test('a remembered raw mode does not reroute other kinds', () => {
  expect(supportsRaw('tree', 'json')).toBe(false);
  expect(supportsRaw('table', 'csv')).toBe(false);
  expect(supportsRaw('table', 'tsv')).toBe(false);
  expect(supportsRaw('table', 'jsonl')).toBe(false);
  expect(supportsRaw('collection', 'sqlite')).toBe(false);
  expect(supportsRaw('collection', 'xlsx')).toBe(false);
  expect(supportsRaw('collection', 'parquet')).toBe(false);
  expect(supportsRaw('collection', 'treeTable')).toBe(false);
  expect(supportsRaw('archive', 'zip')).toBe(false);
});

test('HTML source uses the raw mode contract without being a prose view', () => {
  expect(supportsRaw('frame', 'html')).toBe(true);
});
