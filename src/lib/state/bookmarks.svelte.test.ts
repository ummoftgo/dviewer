import { beforeEach, expect, test, vi } from 'vitest';
import { getValue, setValue } from '../persist';
import { Bookmarks, bookmarkTarget, canBookmark } from './bookmarks.svelte';
import { proseAnchor } from '../bookmarks';
import { DocTab, workspace } from './docs.svelte';
import { toasts } from './toast.svelte';
import type { DocMeta } from '../ipc';
import { i18n } from '../i18n';

vi.mock('../persist', () => ({getValue:vi.fn(),setValue:vi.fn(async () => {})}));
const source = {type:'file' as const,path:'/bookmarks.md'}, anchor = {id:'part',text:'Section'};
const stored = {id:'old',label:'keep',source,anchor,created:10};
const page = () => new DocTab({id:1,source,title:'bookmarks.md',kind:'markdown',view:'prose',byteLen:1,
  encoding:{name:'UTF-8',label:'UTF-8',source:'utf8',warning:null},baseDir:null} as DocMeta);
beforeEach(() => {
  i18n.setting = 'ko';
  vi.restoreAllMocks(); vi.mocked(getValue).mockReset(); vi.mocked(setValue).mockClear();
  vi.spyOn(toasts,'show').mockImplementation(() => {});
});

test('loading never writes an empty list, and additions cannot race an unfinished load', async () => {
  let finish!: (value:unknown) => void;
  vi.mocked(getValue).mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const state = new Bookmarks(), loading = state.load();
  expect(state.add(source,anchor,'early')).toBeNull();
  state.clear(); state.remove('old'); expect(state.rename('old','changed')).toBe(false);
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
  expect(toasts.show).toHaveBeenCalledWith('책갈피를 읽지 못했습니다. 다시 실행해 주세요. 기존 책갈피는 덮어쓰지 않습니다.','error');
});

test('failed saves keep the in-memory list and the next write can persist the complete list', async () => {
  vi.spyOn(console,'warn').mockImplementation(() => {});
  vi.mocked(setValue).mockRejectedValueOnce(new Error('write failed'));
  const state = new Bookmarks(); await state.load();
  state.add(source,anchor,'first'); await state.flush();
  expect(state.entries).toHaveLength(1);
  expect(toasts.show).toHaveBeenCalledWith('책갈피를 저장하지 못했습니다. 이 창에서는 유지되지만 다시 실행하면 사라질 수 있습니다.','error');
  state.add(source,anchor,'second'); await state.flush();
  expect(vi.mocked(setValue).mock.calls[1][1]).toHaveLength(2);
});

test('only ready rendered file/url Markdown or HTML can supply a bookmark target', () => {
  const tab = page();
  expect(bookmarkTarget(tab)).toBeNull();
  tab.readBookmarkAnchor = () => anchor; tab.toc = [{...anchor,level:2}];
  expect(bookmarkTarget(tab)).toEqual({source,anchor});
  tab.mode = 'raw'; expect(bookmarkTarget(tab)).toBeNull(); tab.mode = 'rendered';
  tab.meta.source = {type:'text'}; expect(bookmarkTarget(tab)).toBeNull();
  tab.meta.source = {type:'archiveEntry',root:source,entries:[]}; expect(bookmarkTarget(tab)).toBeNull();
});

test('adding reads live prose coordinates even when the heading tracker is stale or unset', () => {
  const tab = page();
  tab.toc = [{id:'first',text:'First',level:1},{...anchor,level:2}];
  let top = 0;
  const read = vi.fn(() => proseAnchor(tab.toc,[{id:'first',top:32},{id:'part',top:900}],top,2000));
  tab.readBookmarkAnchor = read;
  expect(canBookmark(tab)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(bookmarkTarget(tab)?.anchor.id).toBe('first');
  top = 1200;
  for (const tracked of ['first','',null]) {
    tab.bookmarkHeading = tracked;
    expect(bookmarkTarget(tab)).toEqual({source,anchor});
  }
  tab.readBookmarkAnchor = () => null;
  expect(bookmarkTarget(tab)).toBeNull();
  tab.invalidate();
  expect(tab.readBookmarkAnchor).toBeNull();
  expect(canBookmark(tab)).toBe(false);
});

test('HTML still requires a loaded frame and its heading report', () => {
  const tab = page(); tab.meta.kind = 'html'; tab.meta.view = 'frame';
  tab.frameToc = [{...anchor,level:2}];
  tab.bookmarkHeading = 'part';
  expect(bookmarkTarget(tab)).toBeNull();
  tab.frameContentLoaded = true;
  expect(bookmarkTarget(tab)).toEqual({source,anchor});
  tab.bookmarkHeading = null;
  expect(bookmarkTarget(tab)).toBeNull();
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

test('rename and reassignment preserve identity, source and creation time, and deletion does not merge equal labels', async () => {
  vi.mocked(getValue).mockResolvedValue([stored]);
  const state = new Bookmarks(); await state.load();
  const other = state.add(source,anchor,'keep')!;
  expect(state.rename(stored.id,' ')).toBe(false);
  expect(state.rename(stored.id,'new reason')).toBe(true);
  expect(state.reassign(stored.id,{source:{type:'file',path:'/other.md'},anchor:{id:'',text:''}})).toBe(false);
  expect(state.reassign(stored.id,{source,anchor:{id:'',text:''}})).toBe(true);
  expect(state.entries[0]).toEqual({...stored,label:'new reason',anchor:{id:'',text:''}});
  state.remove(other.id); await state.flush();
  expect(state.entries).toHaveLength(1);
  state.clear(); await state.flush();
  expect(setValue).toHaveBeenLastCalledWith('bookmarks',[]);
  expect(state.entries).toEqual([]);
});
