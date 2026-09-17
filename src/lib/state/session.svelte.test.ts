import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DocMeta, DocSource } from '../ipc';
import { getValue, setValue } from '../persist';
import { DocTab, workspace } from './docs.svelte';
import { captureSession, readSession, Session } from './session.svelte';
import { toasts } from './toast.svelte';
import { i18n } from '../i18n';

vi.mock('../persist', () => ({ getValue: vi.fn(), setValue: vi.fn(async () => {}) }));
let id = 0;
function tab(source: DocSource) {
  return new DocTab({ id: ++id, source, title: 'document', kind: 'markdown', view: 'prose',
    byteLen: 2, encoding: { name: 'UTF-8', label: 'UTF-8', source: 'utf8', warning: null }, baseDir: null } as DocMeta);
}
const file = (path: string): DocSource => ({ type: 'file', path });
beforeEach(() => { vi.restoreAllMocks(); vi.mocked(getValue).mockReset(); vi.mocked(setValue).mockClear(); id = 0; });
afterEach(() => vi.useRealTimers());

test('restoring a PDF keeps its page through the frame view contract', async () => {
  for (const rotation of [undefined,0,90,180,270]) {
  const pdf = tab(file('/reading.pdf')); pdf.meta.kind = 'pdf'; pdf.meta.view = 'frame';
  const pos = {kind:'pdf' as const,page:2,...(rotation === undefined ? {} : {rotation})};
  pdf.rememberPosition(pos);
  const snapshot = captureSession([pdf],pdf.id);
  expect(readSession(snapshot).tabs[0].pos).toEqual(pos);
  vi.mocked(getValue).mockResolvedValue(snapshot);
  vi.spyOn(workspace,'openPath').mockResolvedValue(pdf);
  vi.spyOn(workspace,'activate').mockImplementation(() => {});
  vi.spyOn(workspace,'openLaunch').mockResolvedValue();
  await new Session(workspace).start({files:[],urls:[]},true,false);
  expect(pdf.pendingPosition).toEqual(pos);
  }
});

test('positions round trip and broken positions preserve the source tab', () => {
  const page = tab(file('/position.md'));
  page.rememberPosition({kind:'prose',heading:'section',ratio:0.4});
  expect(readSession(captureSession([page],page.id)).tabs[0].pos).toEqual({kind:'prose',heading:'section',ratio:0.4});
  for (const pos of [{kind:'raw',line:'bad'}, {kind:'frame',ratio:Infinity}, {kind:'tree',path:null}]) {
    expect(readSession({tabs:[{source:page.meta.source,pos}]}).tabs).toEqual([{source:page.meta.source,mode:'rendered'}]);
  }
  page.pendingPosition = {kind:'prose',heading:'later',ratio:0.6};
  page.rememberPosition({kind:'prose',ratio:0});
  expect(captureSession([page],page.id).tabs[0].pos).toEqual(page.pendingPosition);
  page.mode = 'raw'; page.pendingPosition = undefined;
  page.rememberPosition({kind:'raw',line:99});
  expect(captureSession([page],page.id).tabs[0].pos).toEqual({kind:'raw',line:99});
});

test('position writes debounce but tab switches and closes flush immediately', async () => {
  vi.useFakeTimers();
  const first = tab(file('/a')), second = tab(file('/b'));
  const target = {tabs:[first,second],activeId:first.id} as typeof workspace;
  const session = new Session(target); session.ready = true;
  session.watch(); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(setValue).mockClear();
  first.rememberPosition({kind:'prose',ratio:0.3}); session.watch();
  await vi.advanceTimersByTimeAsync(999); expect(setValue).not.toHaveBeenCalled();
  first.rememberPosition({kind:'prose',ratio:0.4}); session.watch();
  await vi.advanceTimersByTimeAsync(999); expect(setValue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(setValue).toHaveBeenCalledTimes(1);
  first.rememberPosition({kind:'prose',ratio:0.5}); session.watch();
  target.activeId = second.id; session.watch(); await vi.advanceTimersByTimeAsync(0);
  expect(setValue).toHaveBeenCalledTimes(2);
  expect(vi.mocked(setValue).mock.calls[1][1]).toMatchObject({tabs:[{pos:{ratio:0.5}},{}],active:second.meta.source});
  target.tabs = [second]; session.watch(); await vi.advanceTimersByTimeAsync(0);
  expect(setValue).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2000); expect(setValue).toHaveBeenCalledTimes(3);
});

test('only ready restorable sources are saved, with root archives deduplicated and active source retained', () => {
  const first = tab(file('/first.md')); first.mode = 'raw';
  const text = tab({ type: 'text' });
  const child = tab({ type: 'treeSlice', parent: first.id, generation: 0, node: 0, path: '$' });
  const opening = tab(file('/opening')); opening.status = 'opening';
  const archive = tab({ type: 'archiveEntry', root: file('/a.zip'), entries: [{ index: 2, name: 'a.md' }] });
  const archiveRoot = tab(file('/a.zip'));
  const remoteEntry = tab({ type: 'archiveEntry', root: { type: 'url', url: 'https://example.com/a.zip' }, entries: [] });
  const url = tab({ type: 'url', url: 'https://example.com/doc' });
  expect(captureSession([first, text, child, opening, archive, archiveRoot, remoteEntry, url], archive.id)).toEqual({
    tabs: [{ source: file('/first.md'), mode: 'raw' }, { source: file('/a.zip'), mode: 'rendered' },
      { source: url.meta.source, mode: 'rendered' }], active: file('/a.zip'),
  });
  expect(captureSession([first, child], child.id).active).toEqual(first.meta.source);
});

test('text files retain raw mode in the session snapshot', () => {
  const text = tab(file('/reading.txt')); text.meta.kind = 'text'; text.meta.view = 'table'; text.mode = 'raw';
  expect(readSession(captureSession([text], text.id))).toEqual({
    tabs: [{ source: file('/reading.txt'), mode: 'raw' }], active: file('/reading.txt'),
  });
});

test('saved data rejects ephemeral and malformed sources and maps active through filtered entries', () => {
  expect(readSession({ tabs: [{ source: { type: 'text' } }, { source: file('/last'), mode: 'raw' },
    { source: file('/last'), mode: 'rendered' }, null], active: file('/last') })).toEqual({
    tabs: [{ source: file('/last'), mode: 'raw' }], active: file('/last'),
  });
  expect(readSession(null)).toEqual({ tabs: [], active: null });
});

test('restoration gates saving and finishes before startup and queued external requests', async () => {
  const first = tab(file('/first')), last = tab(file('/last'));
  vi.mocked(getValue).mockResolvedValue({ tabs: [{ source: first.meta.source, mode: 'raw' },
    { source: last.meta.source, mode: 'rendered' }], active: first.meta.source });
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(workspace, 'openPath').mockImplementation(async path => {
    calls.push(path); if (path === '/first') await gate;
    return path === '/first' ? first : last;
  });
  vi.spyOn(workspace, 'activate').mockImplementation(value => { calls.push(`active:${value}`); });
  vi.spyOn(workspace, 'openLaunch').mockImplementation(async request => { calls.push(...request.files); });
  const session = new Session(workspace);
  const start = session.start({ files: ['/startup'], urls: [] }, true, true);
  await Promise.resolve();
  session.save();
  expect(setValue).not.toHaveBeenCalled();
  await session.receive({ files: ['/external'], urls: [] });
  release(); await start;
  expect(calls).toEqual(['/first', '/last', `active:${first.id}`, '/startup', '/external']);
  expect(first.mode).toBe('raw');
  expect(session.ready).toBe(true);
});

test('failed entries are counted once without shifting the saved active document', async () => {
  i18n.setting = 'ko';
  const last = tab(file('/last'));
  vi.mocked(getValue).mockResolvedValue({ tabs: [{ source: file('/missing') }, { source: file('/last') }], active: file('/last') });
  vi.spyOn(workspace, 'openPath').mockImplementation(async path => path === '/last' ? last : null);
  const activate = vi.spyOn(workspace, 'activate').mockImplementation(() => {});
  vi.spyOn(workspace, 'openLaunch').mockResolvedValue();
  const notify = vi.spyOn(toasts, 'show').mockImplementation(() => 0);
  await new Session(workspace).start({ files: [], urls: [] }, true, true);
  expect(activate).toHaveBeenCalledWith(last.id);
  expect(notify).toHaveBeenCalledExactlyOnceWith('이전 문서 1개를 열지 못했습니다', 'info', 6000);
});

test('non-main and new-window sessions do not load or save previous documents', async () => {
  const open = vi.spyOn(workspace, 'openLaunch').mockResolvedValue();
  const session = new Session(workspace);
  const request = { files: ['/new'], urls: [] };
  await session.start(request, false, false); session.save();
  expect(open).toHaveBeenCalledWith(request);
  expect(getValue).not.toHaveBeenCalled(); expect(setValue).not.toHaveBeenCalled();
});
