import { beforeEach, expect, test, vi } from 'vitest';
import { getValue, setValue } from '../persist';
import { Bookmarks, bookmarkTarget } from './bookmarks.svelte';
import { DocTab, workspace } from './docs.svelte';
import { toasts } from './toast.svelte';
import type { DocMeta } from '../ipc';

vi.mock('../persist', () => ({getValue:vi.fn(),setValue:vi.fn(async () => {})}));
const source = {type:'file' as const,path:'/bookmarks.md'}, anchor = {id:'part',text:'Section'};
const stored = {id:'old',label:'keep',source,anchor,created:10};
const page = () => new DocTab({id:1,source,title:'bookmarks.md',kind:'markdown',view:'prose',byteLen:1,
  encoding:{name:'UTF-8',label:'UTF-8',source:'utf8',warning:null},baseDir:null} as DocMeta);
beforeEach(() => {
  vi.restoreAllMocks(); vi.mocked(getValue).mockReset(); vi.mocked(setValue).mockClear();
  vi.spyOn(toasts,'show').mockImplementation(() => {});
});

test('loading never writes an empty list, and additions cannot race an unfinished load', async () => {
  let finish!: (value:unknown) => void;
  vi.mocked(getValue).mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const state = new Bookmarks(), loading = state.load();
  expect(state.add(source,anchor,'early')).toBeNull();
  finish([null,stored]); await loading;
  expect(state.entries).toEqual([stored]); expect(setValue).not.toHaveBeenCalled();
  state.add(source,anchor,'same'); state.add(source,anchor,'same'); await state.flush();
  expect(state.entries.map(item => item.label)).toEqual(['keep','same','same']);
  expect(new Set(state.entries.map(item => item.id)).size).toBe(3);
  expect(vi.mocked(setValue).mock.calls.map(([key]) => key)).toEqual(['bookmarks','bookmarks']);
  expect(vi.mocked(setValue).mock.calls[0][1]).toHaveLength(2);
});

test('a failed read leaves writes disabled and preserves the stored value', async () => {
  vi.spyOn(console,'warn').mockImplementation(() => {});
  vi.mocked(getValue).mockRejectedValue(new Error('read failed'));
  const state = new Bookmarks(); await state.load();
  expect(state.error).toBe(true); expect(state.ready).toBe(false);
  expect(state.add(source,anchor,'new')).toBeNull(); expect(setValue).not.toHaveBeenCalled();
});

test('only ready rendered file/url Markdown or HTML can supply a bookmark target', () => {
  const tab = page();
  expect(bookmarkTarget(tab)).toBeNull();
  tab.bookmarkHeading = 'part'; tab.toc = [{...anchor,level:2}];
  expect(bookmarkTarget(tab)).toEqual({source,anchor});
  tab.mode = 'raw'; expect(bookmarkTarget(tab)).toBeNull(); tab.mode = 'rendered';
  tab.meta.source = {type:'text'}; expect(bookmarkTarget(tab)).toBeNull();
  tab.meta.source = {type:'archiveEntry',root:source,entries:[]}; expect(bookmarkTarget(tab)).toBeNull();
});

test('bookmark navigation supersedes restoration and keeps a pending anchor until its matching result', async () => {
  const state = new Bookmarks(); await state.load();
  const item = state.add(source,anchor,'reason')!, tab = page();
  tab.pendingPosition = {kind:'prose',heading:'old',ratio:0.5}; tab.mode = 'raw';
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  await state.open(item);
  expect(tab.pendingPosition).toBeUndefined(); expect(tab.mode).toBe('rendered');
  expect(tab.pendingAnchor).toBe('part');
  const first = tab.pendingBookmark!;
  await state.open(item);
  state.complete(tab,first,false); expect(state.results[item.id]).toBeUndefined();
  state.complete(tab,tab.pendingBookmark!,true);
  expect(tab.pendingAnchor).toBeNull(); expect(state.results[item.id]).toBe(true);
  tab.invalidate(); expect(tab.pendingBookmark).toBeNull(); expect(tab.bookmarkHeading).toBeNull();
});
