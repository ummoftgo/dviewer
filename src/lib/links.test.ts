import { expect, test } from 'vitest';
import { normalizeSegments, resolveLink } from './links';
import type { DocSource } from './ipc';

const file = { source: { type: 'file', path: 'C:\\specs\\guide.md' } as DocSource, baseDir: 'C:\\specs' };

test.each([
  ['./schema.json', 'C:/specs/schema.json', null],
  ['../notes/todo.md#sec', 'C:/notes/todo.md', 'sec'],
  ['하위 폴더/문서.md', 'C:/specs/하위 폴더/문서.md', null],
  ['%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.md#%EC%A0%88', 'C:/specs/한글 문서.md', '절'],
  ['a%23b%3Fc.json?ignored=yes#part?two', 'C:/specs/a#b?c.json', 'part?two'],
  ['..\\notes\\todo.md', 'C:/notes/todo.md', null],
  ['../../../../schema.json', 'C:/schema.json', null],
])('resolves %s without decoding delimiters into URL syntax', (href, path, anchor) => {
  expect(resolveLink(file, href)).toEqual({ type: 'file', path, anchor });
});

test.each([
  ['//server/share/specs/../../../schema.json', '//server/share/schema.json'],
  ['\\\\server\\share\\specs\\..\\schema.json', '//server/share/schema.json'],
  ['C:/specs/../../../schema.json', 'C:/schema.json'],
  ['/specs/../../schema.json', '/schema.json'],
  ['a/../../schema.json', '../schema.json'],
])('normalization preserves the root of %s', (path, expected) => {
  expect(normalizeSegments(path)).toBe(expected);
});

test('a relative link on a UNC share keeps the server and share', () => {
  expect(resolveLink({ ...file, baseDir: '\\\\server\\share\\specs' }, '../../schema.json'))
    .toEqual({ type: 'file', path: '//server/share/schema.json', anchor: null });
});

test.each(['file:///C:/a.md', 'C:/a.md', 'C:\\a.md', '/a.md', '//server/share/a.md', '\\\\server\\share\\a.md',
  'javascript:alert(1)', 'data:text/plain,hello', '%2fetc/passwd', '%43%3a/a.md', '%00bad.md', '%zz', 'a.md#%zz', ''])
('rejects unsupported or malformed document link %s', href => {
  expect(resolveLink(file, href)).toBeNull();
});

test('URL documents resolve before decoding escaped path delimiters and discard query/fragment', () => {
  const meta = { source: { type: 'url', url: 'https://example.test/specs/guide.md?old=1' } as DocSource, baseDir: null };
  expect(resolveLink(meta, '../%ED%95%9C%EA%B8%80%20a%23b.json?new=2#part'))
    .toEqual({ type: 'url', url: 'https://example.test/%ED%95%9C%EA%B8%80%20a%23b.json', anchor: 'part' });
});

test('archive siblings use the immediate containing archive, including nested archives', () => {
  const root: DocSource = { type: 'file', path: 'C:/bundle.zip' };
  const source: DocSource = { type: 'archiveEntry', root, entries: [
    { index: 1, name: 'inside.zip' }, { index: 7, name: 'docs/guide.md' },
  ] };
  expect(resolveLink({ source, baseDir: null }, '../schema.json#part'))
    .toEqual({ type: 'archiveEntry', name: 'schema.json', anchor: 'part',
      parent: { ...source, entries: source.entries.slice(0, -1) } });
  expect(resolveLink({ source: { ...source, entries: source.entries.slice(-1) }, baseDir: null }, './next.md'))
    .toEqual({ type: 'archiveEntry', name: 'docs/next.md', anchor: null, parent: root });
  expect(resolveLink({ source, baseDir: null }, '../../outside.md')).toBeNull();
});

test('pasted text and a file with no base directory have no relative location', () => {
  expect(resolveLink({ source: { type: 'text' }, baseDir: null }, './schema.json')).toBeNull();
  expect(resolveLink({ ...file, baseDir: null }, './schema.json')).toBeNull();
});
