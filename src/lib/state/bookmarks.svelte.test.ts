import { beforeEach, expect, test, vi } from 'vitest';
import { getValue, setValue } from '../persist';
import { Bookmarks, bookmarkTarget, canBookmark } from './bookmarks.svelte';
import { proseAnchor } from '../bookmarks';
import { DocTab, workspace } from './docs.svelte';
import { toasts } from './toast.svelte';
import type { DocMeta, TableStats, TreeStats, GridStats } from '../ipc';
import * as ipc from '../ipc';
import { i18n, t } from '../i18n';

vi.mock('../persist', () => ({getValue:vi.fn(),setValue:vi.fn(async () => {})}));
const source = {type:'file' as const,path:'/bookmarks.md'}, anchor = {id:'part',text:'Section'};
const stored = {id:'old',label:'keep',source,anchor,created:10};
const page = () => {
  const tab = new DocTab({id:1,source,title:'bookmarks.md',kind:'markdown',view:'prose',byteLen:1,
    encoding:{name:'UTF-8',label:'UTF-8',source:'utf8',warning:null},baseDir:null} as DocMeta);
  workspace.tabs = [...workspace.tabs,tab];
  return tab;
};
beforeEach(() => {
  i18n.setting = 'ko';
  workspace.tabs = []; workspace.activeId = null;
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


test('JSON paths, original table rows, log lines and PDF pages supply typed targets', () => {
  const tab = page();
  tab.meta.kind = 'json'; tab.meta.view = 'tree';
  tab.treeStats = {visibleRows:1} as TreeStats; tab.selectedNode = 0;
  tab.position = {kind:'tree',path:'$.items[4]'};
  expect(bookmarkTarget(tab)?.target).toEqual({kind:'tree',path:'$.items[4]'});
  tab.meta.kind = 'csv'; tab.meta.view = 'table';
  tab.tableStats = {hasHeader:true,plain:false,expanded:false} as TableStats;
  tab.position = {kind:'grid',row:70};
  tab.selectedCell = {row:2,column:3,sourceRow:91};
  expect(bookmarkTarget(tab)?.target).toEqual({kind:'grid',row:91,hasHeader:true,plain:false,expanded:false});
  tab.collection = 'Sales';
  expect(bookmarkTarget(tab)?.target).toMatchObject({row:91,collection:'Sales'});
  tab.meta.kind = 'text';
  expect(bookmarkTarget(tab)).toMatchObject({logRow:91,target:{kind:'log',line:91,sourceLine:true,plain:false,expanded:false}});
  tab.meta.kind = 'pdf'; tab.meta.view = 'frame'; tab.framePage = 4; tab.framePages = 4; tab.frameReady = true;
  expect(bookmarkTarget(tab)).toBeNull();
  tab.frameContentLoaded = true;
  expect(bookmarkTarget(tab)?.target).toEqual({kind:'pdf',page:4});
});

test('fingerprint mismatch stops navigation and reassignment preserves identity with a new verified location', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.meta.kind = 'json'; tab.meta.view = 'tree';
  tab.treeStats = {visibleRows:1} as TreeStats; tab.selectedNode = 0;
  tab.position = {kind:'tree',path:'$.new'};
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:new');
  vi.spyOn(ipc,'treePositionPath').mockResolvedValue('$.new');
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  const item = state.add(source,{id:'',text:''},'place',{kind:'tree',path:'$.old'},'v1:old')!;
  await state.open(item);
  expect(state.results[item.id]).toBe(false); expect(tab.pendingBookmark).toBeNull();
  expect(await state.reassignCurrent(item.id,tab)).toBe(true);
  expect(state.entries[0]).toMatchObject({id:item.id,created:item.created,target:{kind:'tree',path:'$.new'},fingerprint:'v1:new'});
  await state.open(state.entries[0]);
  expect(tab.pendingBookmark?.target).toEqual({kind:'tree',path:'$.new'});
  state.complete(tab,tab.pendingBookmark!,true);
  expect(state.results[item.id]).toBe(true);
});

test('an asynchronous fingerprint captured before a document refresh cannot save a stale location', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.readBookmarkAnchor = () => anchor;
  let finish!: (value:string) => void;
  vi.spyOn(ipc,'bookmarkFingerprint').mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const saving = state.addCurrent(tab,bookmarkTarget(tab)!,'stale');
  tab.meta.generation = 1;
  finish('v1:old');
  expect(await saving).toBeNull(); expect(state.entries).toEqual([]);
  expect(setValue).not.toHaveBeenCalled();
});

test('typed grid navigation clears sorted order and retains source row and collection identity', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.meta.kind = 'sqlite'; tab.meta.view = 'collection'; tab.collection = 'Other';
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  const item = state.add(source,{id:'',text:''},'row',{kind:'grid',row:81,collection:'Orders'})!;
  await state.open(item);
  expect(ipc.gridOrderCancel).toHaveBeenCalledWith(tab.id);
  expect(tab.pendingBookmark?.target).toEqual({kind:'grid',row:81,collection:'Orders'});
  expect(tab.pendingPosition).toEqual({kind:'grid',row:81,collection:'Orders'});
  expect(tab.collection).toBeNull(); expect(tab.pendingCell).toEqual({row:81,column:0});
  const old = tab.pendingBookmark!;
  state.reassign(item.id,{source,anchor:{id:'',text:''},target:{kind:'grid',row:82,collection:'Orders'}});
  state.complete(tab,old,false);
  expect(state.results[item.id]).toBe(true);
});


test('bookmark table shape restoration clears hidden and reordered columns when the schema shrinks', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.meta.kind = 'text'; tab.meta.view = 'table';
  tab.tableStats = {columnCount:4,plain:false,expanded:false} as TableStats;
  tab.header = ['time','level','message','source'];
  tab.hiddenColumns = [0,1]; tab.columnOrder = [3,2,1,0]; tab.frozenCount = 2; tab.columnWidths = [100,100,100,100];
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  vi.spyOn(ipc,'tableSetPlain').mockResolvedValue({stats:{columnCount:1,plain:true,expanded:false} as TableStats,header:['line']});
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  await state.open(state.add(source,{id:'',text:''},'line',{kind:'log',line:2,plain:true,expanded:false})!);
  expect(tab.tableStats?.columnCount).toBe(1);
  expect(tab.hiddenColumns).toEqual([]); expect(tab.columnOrder).toEqual([]); expect(tab.frozenCount).toBe(0);
  expect(tab.columnWidths).toEqual([]); expect(tab.gridRestoreOrderAllowed).toBe(false);
});


test('canceling a pending fingerprint capture cannot create a bookmark after the editor closes', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.readBookmarkAnchor = () => anchor;
  let valid = true, finish!: (value:string) => void;
  vi.spyOn(ipc,'bookmarkFingerprint').mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const saving = state.addCurrent(tab,bookmarkTarget(tab)!,'cancelled',() => valid);
  valid = false; finish('v1:verified');
  expect(await saving).toBeNull(); expect(state.entries).toEqual([]);
  expect(setValue).not.toHaveBeenCalled();
});


test('bookmark sample verification wording explicitly declines a whole-file equality guarantee', () => {
  expect(t('bookmarkLocation.sampled')).toBe('원본 표본 확인 · 전체 파일 일치 보장 아님');
  expect(t('bookmarkLocation.sampledDetail')).toBe('최대 12 KiB 원본 표본을 확인하며 로컬 파일은 크기·수정 시각도 확인합니다. 전체 파일의 내용이 같은지는 보장하지 않습니다.');
});

test('a JSON selection made before the position tracker IPC finishes saves the captured node, not the old path', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.meta.kind = 'json'; tab.meta.view = 'tree';
  tab.treeStats = {visibleRows:1} as TreeStats; tab.selectedNode = 0;
  tab.position = {kind:'tree',path:'old-path'}; tab.selectedNode = 27;
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:unchanged');
  let finish!: (value:string|null) => void;
  const path = vi.spyOn(ipc,'treePositionPath').mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const draft = bookmarkTarget(tab)!;
  const saving = state.addCurrent(tab,draft,'selected node');
  await vi.waitFor(() => expect(path).toHaveBeenCalledWith(tab.id,27));
  // The reader moves again while the draft resolves; the draft must retain node 27.
  tab.selectedNode = 45; tab.position = {kind:'tree',path:'newer-path'};
  finish('captured-node-27');
  expect((await saving)?.target).toEqual({kind:'tree',path:'captured-node-27'});
  expect(state.entries[0].target).toEqual({kind:'tree',path:'captured-node-27'});
  expect(Reflect.get(state.entries[0],'treeNode')).toBeUndefined();
});

test('a JSON path response after refresh or close cannot save or reassign an obsolete location', async () => {
  const state = new Bookmarks(); await state.load();
  const tab = page(); tab.meta.kind = 'json'; tab.meta.view = 'tree';
  tab.treeStats = {visibleRows:1} as TreeStats; tab.selectedNode = 0;
  tab.position = {kind:'tree',path:'old'}; tab.selectedNode = 3;
  workspace.tabs = [tab];
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:source');
  let finish!: (value:string|null) => void;
  const path = vi.spyOn(ipc,'treePositionPath').mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const saving = state.addCurrent(tab,bookmarkTarget(tab)!,'old');
  await vi.waitFor(() => expect(path).toHaveBeenCalledTimes(1));
  tab.meta.generation = 1; finish('obsolete');
  expect(await saving).toBeNull(); expect(state.entries).toEqual([]);
  const item = state.add(source,{id:'',text:''},'stable',{kind:'tree',path:'stable'})!;
  const assigning = state.reassignCurrent(item.id,tab);
  await vi.waitFor(() => expect(path).toHaveBeenCalledTimes(2));
  workspace.tabs = []; finish('closed');
  expect(await assigning).toBe(false); expect(state.entries[0].target).toEqual({kind:'tree',path:'stable'});
});

test('a closed document cannot receive a late bookmark completion or a pending fingerprint navigation', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  workspace.tabs = [tab];
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  const item = state.add(source,anchor,'place')!;
  await state.open(item); const jump = tab.pendingBookmark!;
  workspace.tabs = [];
  state.complete(tab,jump,true);
  expect(state.results[item.id]).toBeUndefined();
  expect(tab.pendingBookmark?.request).toBe(jump.request);
  workspace.tabs = [tab]; tab.pendingBookmark = null;
  let finish!: (value:string) => void;
  const fingerprint = vi.spyOn(ipc,'bookmarkFingerprint').mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const opening = state.open({...item,fingerprint:'v1:source'});
  await vi.waitFor(() => expect(fingerprint).toHaveBeenCalled());
  workspace.tabs = []; finish('v1:source'); await opening;
  expect(tab.pendingBookmark).toBeNull(); expect(state.results[item.id]).toBeUndefined();
});

test('missing named collections finish as mismatch while valid collection names remain pending', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'sqlite'; tab.meta.view = 'collection';
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab); vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  const item = state.add(source,{id:'',text:''},'table row',{kind:'grid',row:2,collection:'removed'})!;
  await state.open(item);
  expect(state.collectionAvailable(tab,['removed','other'])).toBe(true);
  expect(tab.pendingBookmark).not.toBeNull();
  expect(state.collectionAvailable(tab,['other'])).toBe(false);
  expect(state.results[item.id]).toBe(false);
  expect(tab.pendingBookmark).toBeNull(); expect(tab.pendingPosition).toBeUndefined(); expect(tab.pendingCell).toBeNull();
});

test('the latest reassignment wins even if older fingerprint requests finish after a new third request begins', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.readBookmarkAnchor = () => anchor;
  const item = state.add(source,anchor,'reason')!;
  const finishes: ((value:string) => void)[] = [];
  vi.spyOn(ipc,'bookmarkFingerprint').mockImplementation(() => new Promise(resolve => {finishes.push(resolve);}));
  const first = state.reassignCurrent(item.id,tab);
  const second = state.reassignCurrent(item.id,tab);
  finishes[1]('v1:second'); expect(await second).toBe(true);
  const third = state.reassignCurrent(item.id,tab);
  finishes[0]('v1:first'); expect(await first).toBe(false);
  finishes[2]('v1:third'); expect(await third).toBe(true);
  expect(state.entries[0].fingerprint).toBe('v1:third');
});

test('refresh and same-coordinate reassignment prevent an old completion from overwriting new mismatch state', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:source');
  const item = state.add(source,anchor,'reason',undefined,'v1:source')!;
  await state.open(item); const old = tab.pendingBookmark!;
  tab.meta.generation = 1;
  state.complete(tab,old,false); expect(state.results[item.id]).toBeUndefined();
  tab.meta.generation = 0;
  state.reassign(item.id,{source,anchor,fingerprint:'v1:new'});
  state.complete(tab,old,false); expect(state.results[item.id]).toBe(true);
});

test('deletion and reassignment cancel an already pending live-document navigation before a late view response', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  workspace.tabs = [tab]; vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  const item = state.add(source,anchor,'place')!;
  await state.open(item); const deleted = tab.pendingBookmark!;
  state.remove(item.id); state.complete(tab,deleted,true);
  expect(tab.pendingBookmark).toBeNull(); expect(tab.pendingAnchor).toBeNull();
  expect(state.results[item.id]).toBeUndefined();
  const replacement = state.add(source,anchor,'replacement')!;
  await state.open(replacement); const obsolete = tab.pendingBookmark!;
  state.reassign(replacement.id,{source,anchor:{id:'new',text:'New'}});
  state.complete(tab,obsolete,false);
  expect(tab.pendingBookmark).toBeNull(); expect(state.results[replacement.id]).toBe(true);
});

test('an unresolved grid selection or another collection’s remembered row cannot create a wrong-source bookmark', () => {
  const tab = page(); tab.meta.kind = 'csv'; tab.meta.view = 'table';
  tab.tableStats = {rowCount:20,hasHeader:true,plain:false,expanded:false} as TableStats;
  tab.position = {kind:'grid',row:12}; tab.selectedCell = {row:2,column:0};
  expect(canBookmark(tab)).toBe(false); expect(bookmarkTarget(tab)).toBeNull();
  tab.selectedCell = null; expect(canBookmark(tab)).toBe(true);
  tab.meta.kind = 'sqlite'; tab.meta.view = 'collection'; tab.tableStats = null;
  tab.gridStats = {rowCount:20} as GridStats; tab.collection = 'new';
  tab.position = {kind:'grid',row:12,collection:'old'};
  expect(canBookmark(tab)).toBe(false); expect(bookmarkTarget(tab)).toBeNull();
  tab.position = {kind:'grid',row:12,collection:'new'}; expect(canBookmark(tab)).toBe(true);
  tab.position = {kind:'grid',row:20,collection:'new'}; expect(canBookmark(tab)).toBe(false);
});

test('stale tree reading coordinates and unloaded or out-of-bounds PDF pages cannot supply a current bookmark', () => {
  const tab = page(); tab.meta.kind = 'json'; tab.meta.view = 'tree';
  tab.position = {kind:'tree',path:'prior-file-path'};
  expect(canBookmark(tab)).toBe(false);
  tab.treeStats = {visibleRows:1} as TreeStats;
  expect(canBookmark(tab)).toBe(false);
  tab.selectedNode = 0; expect(canBookmark(tab)).toBe(true);
  tab.meta.kind = 'pdf'; tab.meta.view = 'frame'; tab.frameContentLoaded = true;
  expect(canBookmark(tab)).toBe(false);
  tab.frameReady = true; tab.framePages = 4; tab.framePage = 4;
  expect(bookmarkTarget(tab)?.target).toEqual({kind:'pdf',page:4});
  tab.framePage = 5; expect(bookmarkTarget(tab)).toBeNull();
});

test('capture APIs reject a document that was already removed from the workspace before the call', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.readBookmarkAnchor = () => anchor; const target = bookmarkTarget(tab)!;
  const item = state.add(source,anchor,'place')!;
  workspace.tabs = [];
  const fingerprint = vi.spyOn(ipc,'bookmarkFingerprint');
  expect(await state.addCurrent(tab,target,'already closed')).toBeNull();
  expect(await state.reassignCurrent(item.id,tab)).toBe(false);
  expect(fingerprint).not.toHaveBeenCalled(); expect(state.entries).toHaveLength(1);
});

test('a grouped log captures physical source line using the selected row and captured mode', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'text'; tab.meta.view = 'table';
  tab.tableStats = {rowCount:4,plain:false,expanded:false} as TableStats;
  tab.selectedCell = {row:3,column:0,sourceRow:3};
  const target = bookmarkTarget(tab)!;
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:source');
  const line = vi.spyOn(ipc,'bookmarkLogLine').mockResolvedValue(5);
  tab.selectedCell = {row:0,column:0,sourceRow:0};
  tab.tableStats = {...tab.tableStats,plain:true};
  const item = await state.addCurrent(tab,target,'sixth line');
  expect(line).toHaveBeenCalledWith(tab.id,3,false);
  expect(item?.target).toEqual({kind:'log',line:5,sourceLine:true,plain:false,expanded:false});
  expect(item).not.toHaveProperty('logRow');
});

test('physical log navigation maps its source line to the grouped row, while legacy records remain unchanged', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'text'; tab.meta.view = 'table';
  tab.tableStats = {rowCount:4,plain:false,expanded:false} as TableStats;
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  const mapping = vi.spyOn(ipc,'bookmarkLogRow').mockResolvedValue(3);
  const physical = state.add(source,{id:'',text:''},'sixth line',{kind:'log',line:5,sourceLine:true,plain:false})!;
  await state.open(physical);
  expect(mapping).toHaveBeenCalledWith(tab.id,5,false);
  expect(tab.pendingBookmark).toMatchObject({row:3,ready:true,target:{line:5}});
  expect(tab.pendingPosition).toEqual({kind:'grid',row:3});
  expect(tab.pendingCell).toEqual({row:3,column:0});
  const legacy = state.add(source,{id:'',text:''},'fourth record',{kind:'log',line:3,plain:false})!;
  await state.open(legacy);
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(tab.pendingCell).toEqual({row:3,column:0});
});

test('a newly opened log waits for indexing before resolving physical lines and rejects missing lines', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'text'; tab.meta.view = 'table';
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  const mapping = vi.spyOn(ipc,'bookmarkLogRow').mockResolvedValue(3);
  const item = state.add(source,{id:'',text:''},'sixth line',{kind:'log',line:5,sourceLine:true,plain:true})!;
  await state.open(item);
  expect(tab.pendingBookmark?.ready).toBe(false);
  expect(tab.pendingCell).toBeNull(); expect(tab.pendingPosition).toBeUndefined();
  expect(mapping).not.toHaveBeenCalled();
  tab.tableStats = {rowCount:6,plain:true,expanded:false} as TableStats;
  mapping.mockResolvedValueOnce(5);
  await state.prepareTableJump(tab,tab.pendingBookmark!);
  expect(mapping).toHaveBeenCalledWith(tab.id,5,true);
  expect(tab.pendingPosition).toEqual({kind:'grid',row:5});
  expect(tab.pendingBookmark).toMatchObject({ready:true,row:5});
  state.complete(tab,tab.pendingBookmark!,true);
  expect(state.results[item.id]).toBe(true);
  tab.pendingCell = null; mapping.mockResolvedValueOnce(null);
  await state.open(item);
  expect(state.results[item.id]).toBe(false);
  expect(tab.pendingBookmark).toBeNull(); expect(tab.pendingCell).toBeNull();
});

test('delayed physical log capture and mapping cannot survive document refresh or close', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'text'; tab.meta.view = 'table';
  tab.tableStats = {rowCount:4,plain:false,expanded:false} as TableStats;
  tab.selectedCell = {row:3,column:0,sourceRow:3};
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:source');
  let finishLine!: (line:number|null) => void;
  const line = vi.spyOn(ipc,'bookmarkLogLine').mockReturnValue(new Promise(resolve => {finishLine = resolve;}));
  const saving = state.addCurrent(tab,bookmarkTarget(tab)!,'old');
  await vi.waitFor(() => expect(line).toHaveBeenCalled());
  tab.meta.generation = 1; finishLine(5);
  expect(await saving).toBeNull(); expect(state.entries).toEqual([]);
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  let finishRow!: (row:number|null) => void;
  const row = vi.spyOn(ipc,'bookmarkLogRow').mockReturnValue(new Promise(resolve => {finishRow = resolve;}));
  const item = state.add(source,{id:'',text:''},'sixth line',{kind:'log',line:5,sourceLine:true,plain:false})!;
  const opening = state.open(item);
  await vi.waitFor(() => expect(row).toHaveBeenCalled());
  workspace.tabs = []; finishRow(3); await opening;
  expect(tab.pendingBookmark).toBeNull(); expect(tab.pendingCell).toBeNull();
  expect(state.results[item.id]).toBeUndefined();
});

test('a newer navigation with a mismatched source cancels an older delayed log position', async () => {
  const state = new Bookmarks(); await state.load(); const tab = page();
  tab.meta.kind = 'text'; tab.meta.view = 'table';
  vi.spyOn(workspace,'openPath').mockResolvedValue(tab);
  vi.spyOn(ipc,'gridOrderCancel').mockResolvedValue();
  const older = state.add(source,{id:'',text:''},'sixth line',{kind:'log',line:5,sourceLine:true,plain:false})!;
  await state.open(older);
  tab.tableStats = {rowCount:4,plain:false,expanded:false} as TableStats;
  let finish!: (row:number|null) => void;
  const mapping = vi.spyOn(ipc,'bookmarkLogRow').mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const pending = state.prepareTableJump(tab,tab.pendingBookmark!);
  await vi.waitFor(() => expect(mapping).toHaveBeenCalled());
  const newer = state.add(source,{id:'',text:''},'changed file',{kind:'log',line:5,sourceLine:true,plain:false},'v1:expected')!;
  vi.spyOn(ipc,'bookmarkFingerprint').mockResolvedValue('v1:changed');
  await state.open(newer);
  finish(3); await pending;
  expect(tab.pendingBookmark).toBeNull(); expect(tab.pendingCell).toBeNull();
  expect(tab.pendingPosition).toBeUndefined();
  expect(state.results[older.id]).toBeUndefined(); expect(state.results[newer.id]).toBe(false);
});
