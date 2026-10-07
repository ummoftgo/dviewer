import { currentAnchor, readBookmarks, type Bookmark, type BookmarkAnchor, type BookmarkJump, sameBookmarkLocation, type BookmarkTarget, type BookmarkSource } from '../bookmarks';
import { getValue, setValue } from '../persist';
import { resetColumns } from '../components/grid/columns';
import { bookmarkFingerprint, bookmarkLogLine, bookmarkLogRow, gridOrderCancel, tableSetHasHeader, tableSetPlain, tableSetExpand, treePositionPath } from '../ipc';
import { sameSource } from '../source';
import { t } from '../i18n';
import { workspace, type DocTab } from './docs.svelte';
import { toasts } from './toast.svelte';

export function canBookmark(tab: DocTab | null): boolean {
  if (!tab || tab.status !== 'ready' || tab.mode !== 'rendered'
    || (tab.meta.source.type !== 'file' && tab.meta.source.type !== 'url')) return false;
  if (tab.kind === 'pdf') return tab.frameContentLoaded && tab.frameReady && Number.isSafeInteger(tab.framePage)
    && tab.framePage >= 1 && tab.framePage <= tab.framePages;
  if (tab.view === 'tree') return !!tab.treeStats && tab.selectedNode !== null;
  if (tab.view === 'table' || tab.view === 'collection') {
    if (!tab.tableStats && !tab.gridStats) return false;
    const pos = tab.position;
    if (!tab.selectedCell && (pos?.kind !== 'grid' || pos.collection !== (tab.collection ?? undefined))) return false;
    const row = tab.selectedCell ? tab.selectedCell.sourceRow : pos?.kind === 'grid' ? pos.row : undefined;
    const count = tab.tableStats?.rowCount ?? tab.gridStats?.rowCount;
    return row !== undefined && Number.isSafeInteger(row) && row >= 0 && (count === undefined || row < count);
  }
  return (tab.kind === 'markdown' || tab.kind === 'html')
    && (tab.view === 'prose' ? tab.readBookmarkAnchor !== null
      : tab.view === 'frame' && tab.frameContentLoaded && tab.bookmarkHeading !== null);
}

export function bookmarkTarget(tab: DocTab | null): BookmarkTarget | null {
  if (!tab || !canBookmark(tab)) return null;
  const source = tab.meta.source;
  if (source.type !== 'file' && source.type !== 'url') return null;
  const origin: BookmarkSource = source.type === 'file' ? {type:'file',path:source.path} : {type:'url',url:source.url};
  if (tab.kind === 'pdf') return {source:origin,anchor:{id:'',text:''},target:{kind:'pdf',page:tab.framePage}};
  if (tab.view === 'tree') {
    const path = tab.position?.kind === 'tree' ? tab.position.path : '';
    return {source:origin,anchor:{id:'',text:''},target:{kind:'tree',path},...(tab.selectedNode === null ? {} : {treeNode:tab.selectedNode})};
  }
  if (tab.view === 'table' || tab.view === 'collection') {
    const row = tab.selectedCell?.sourceRow ?? (tab.position?.kind === 'grid' ? tab.position.row : undefined);
    if (row === undefined) return null;
    const modes = tab.tableStats ? {plain:tab.tableStats.plain,expanded:tab.tableStats.expanded} : {};
    return {source:origin,anchor:{id:'',text:''},...(tab.kind === 'text' ? {logRow:row} : {}),target:tab.kind === 'text' ? {kind:'log',line:row,sourceLine:true,...modes}
      : {kind:'grid',row,...(tab.collection === null ? {} : {collection:tab.collection}),
        ...(tab.tableStats ? {hasHeader:tab.tableStats.hasHeader} : {}),...modes}};
  }
  const anchor = tab.view === 'prose' ? tab.readBookmarkAnchor!() : currentAnchor(tab.frameToc,tab.bookmarkHeading!);
  return anchor ? {source:origin,anchor} : null;
}

export class Bookmarks {
  entries = $state<Bookmark[]>([]);
  ready = $state(false);
  error = $state(false);
  results = $state<Record<string, boolean | undefined>>({});
  private loading: Promise<void> | undefined;
  private writing = Promise.resolve();
  private request = 0;
  private reassignRequests = new Map<string, number>();
  private reassignSequence = 0;

  load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        this.entries = readBookmarks(await getValue('bookmarks'));
        this.ready = true;
      } catch (error) {
        this.error = true;
        console.warn('[dviewer] could not load bookmarks:', error);
        toasts.show(t('bookmarks.loadFailed'), 'error');
      }
    })();
  }

  private save(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    const snapshot = $state.snapshot(this.entries);
    this.writing = this.writing.then(() => setValue('bookmarks', snapshot)).catch(error => {
      console.warn('[dviewer] could not save bookmarks:', error);
      toasts.show(t('bookmarks.saveFailed'), 'error');
    });
    return this.writing;
  }

  flush() { return this.writing; }

  async prepareTableJump(tab: DocTab, jump: BookmarkJump): Promise<void> {
    const target = jump.target;
    if (!target || (target.kind !== 'grid' && target.kind !== 'log') || !tab.tableStats || jump.ready !== false) return;
    const generation = tab.meta.generation ?? 0;
    const current = () => tab.pendingBookmark?.request === jump.request && tab.status === 'ready' && generation === (tab.meta.generation ?? 0)
      && (jump.generation === undefined || jump.generation === generation) && (!jump.workspaceBound || workspace.tabs.includes(tab));
    if (!current()) return;
    try {
      let shape;
      if (target.kind === 'grid' && target.hasHeader !== undefined && target.hasHeader !== tab.tableStats.hasHeader) shape = await tableSetHasHeader(tab.id,target.hasHeader);
      if (!current()) return;
      if (target.plain !== undefined && target.plain !== (shape?.stats ?? tab.tableStats).plain) shape = await tableSetPlain(tab.id,target.plain);
      if (!current()) return;
      if (target.expanded !== undefined && target.expanded !== (shape?.stats ?? tab.tableStats).expanded) shape = await tableSetExpand(tab.id,target.expanded);
      if (!current()) return;
      if (shape) {
        if (tab.tableStats?.columnCount !== shape.stats.columnCount || JSON.stringify(tab.header) !== JSON.stringify(shape.header)) {
          resetColumns(tab); tab.resetColumnView();
        }
        tab.tableStats = shape.stats; tab.header = shape.header;
      }
      if (target.kind === 'log' && target.sourceLine) {
        const row = await bookmarkLogRow(tab.id,target.line,target.plain ?? tab.tableStats.plain);
        if (!current()) return;
        if (row === null) { this.complete(tab,jump,false); return; }
        tab.pendingPosition = {kind:'grid',row}; tab.pendingCell = {row,column:0};
        tab.pendingBookmark = {...jump,ready:true,row};
      } else tab.pendingBookmark = {...jump,ready:true};
    } catch { if (current()) this.complete(tab,jump,false); }
  }

  add(source: BookmarkSource, anchor: BookmarkAnchor, label: string, target?: BookmarkTarget['target'], fingerprint?: string): Bookmark | null {
    if (!this.ready || !label.trim()) return null;
    const item = readBookmarks([{id:crypto.randomUUID(),source,anchor,label:label.trim(),created:Date.now(),...(target ? {target} : {}),...(fingerprint ? {fingerprint} : {})}])[0];
    if (!item) return null;
    this.entries = [...this.entries, item];
    void this.save();
    return item;
  }

  /** Capture the fingerprint asynchronously, rejecting a source refreshed during the request. */
  async addCurrent(tab: DocTab | null, target: BookmarkTarget, label: string, valid: () => boolean = () => true): Promise<Bookmark | null> {
    if (!tab || !workspace.tabs.includes(tab) || !sameSource(tab.meta.source,target.source)) return null;
    const generation = tab.meta.generation ?? 0;
    const current = () => valid() && workspace.tabs.includes(tab) && tab.status === 'ready'
      && generation === (tab.meta.generation ?? 0) && sameSource(tab.meta.source,target.source);
    try {
      const fingerprint = await bookmarkFingerprint(tab.id);
      if (!current()) return null;
      const location = await this.captureLocation(tab,target);
      if (!current()) return null;
      if (!location) { toasts.show(t('bookmarkLocation.captureFailed'),'error'); return null; }
      return this.add(target.source,target.anchor,label,location.target,fingerprint);
    } catch {
      if (current()) toasts.show(t('bookmarkLocation.captureFailed'),'error'); return null;
    }
  }

  private async captureLocation(tab: DocTab, target: BookmarkTarget): Promise<BookmarkTarget | null> {
    if (target.target?.kind === 'log' && target.logRow !== undefined) {
      const line = await bookmarkLogLine(tab.id,target.logRow,target.target.plain ?? false);
      return line === null ? null : {...target,target:{...target.target,line,sourceLine:true}};
    }
    if (target.target?.kind !== 'tree' || target.treeNode === undefined) return target;
    const path = await treePositionPath(tab.id,target.treeNode);
    return path ? {...target,target:{kind:'tree',path}} : null;
  }

  /** Missing named collections must finish as a mismatch, rather than wait on another grid. */
  collectionAvailable(tab: DocTab, names: readonly string[]): boolean {
    const jump = tab.pendingBookmark;
    const location = jump?.target;
    if (!jump || location?.kind !== 'grid' || !location.collection || names.includes(location.collection)) return true;
    this.complete(tab,jump,false);
    return false;
  }

  async open(item: Bookmark) {
    const entry = this.entries.find(saved => saved.id === item.id);
    if (!entry) return;
    const unchanged = () => {
      const saved = this.entries.find(saved => saved.id === item.id);
      return !!saved && saved.fingerprint === entry.fingerprint && saved.anchor.id === entry.anchor.id
        && saved.anchor.text === entry.anchor.text && sameBookmarkLocation(saved.target,entry.target);
    };
    const request = ++this.request;
    // A newer navigation supersedes an older view request even when its source
    // check subsequently fails. Late path/row responses must not move the view.
    for (const existing of workspace.tabs) {
      if (existing.pendingBookmark) this.cancelPending(existing.pendingBookmark.id);
    }
    const tab = item.source.type === 'file' ? await workspace.openPath(item.source.path) : await workspace.openUrl(item.source.url);
    if (!tab || request !== this.request) return;
    const generation = tab.meta.generation ?? 0;
    const current = () => request === this.request && unchanged() && tab.status === 'ready' && generation === (tab.meta.generation ?? 0)
      && workspace.tabs.includes(tab) && sameSource(tab.meta.source,item.source);
    const target = item.target;
    const compatible = target ? target.kind === 'pdf' ? tab.kind === 'pdf' : target.kind === 'tree' ? tab.view === 'tree'
      : target.kind === 'log' ? tab.kind === 'text' : tab.view === 'table' || tab.view === 'collection'
      : tab.kind === 'markdown' || tab.kind === 'html';
    if (!current()) return;
    if (!compatible) { this.results[item.id] = false; return; }
    if (target?.kind === 'grid' || target?.kind === 'log') tab.gridRestoreOrderAllowed = false;
    try {
      let logRow: number | undefined;
      if (item.fingerprint && await bookmarkFingerprint(tab.id) !== item.fingerprint) {
        if (current()) this.results[item.id] = false;
        return;
      }
      if (!current()) return;
      // A durable row is a source row. Clear displayed order before requesting it.
      if (target?.kind === 'grid' || target?.kind === 'log') {
        await gridOrderCancel(tab.id); if (!current()) return;
        tab.order.reset();
        if (tab.tableStats) {
          let shape;
          if (target.kind === 'grid' && target.hasHeader !== undefined && target.hasHeader !== tab.tableStats.hasHeader) shape = await tableSetHasHeader(tab.id,target.hasHeader);
          if (!current()) return;
          if (target.plain !== undefined && target.plain !== (shape?.stats ?? tab.tableStats).plain) shape = await tableSetPlain(tab.id,target.plain);
          if (!current()) return;
          if (target.expanded !== undefined && target.expanded !== (shape?.stats ?? tab.tableStats).expanded) shape = await tableSetExpand(tab.id,target.expanded);
          if (!current()) return;
          if (shape) {
            if (tab.tableStats?.columnCount !== shape.stats.columnCount || JSON.stringify(tab.header) !== JSON.stringify(shape.header)) {
              resetColumns(tab); tab.resetColumnView();
            }
            tab.tableStats = shape.stats; tab.header = shape.header;
          }
          if (target.kind === 'log' && target.sourceLine) {
            const row = await bookmarkLogRow(tab.id,target.line,target.plain ?? tab.tableStats.plain);
            if (!current()) return;
            if (row === null) { this.results[item.id] = false; return; }
            logRow = row;
          }
        }
      }
      if (!current()) return;
      tab.pendingPosition = undefined;
      tab.pendingBookmark = {id:item.id,anchor:{...item.anchor},request,generation,workspaceBound:true,fingerprint:item.fingerprint,...(target ? {target:{...target}} : {}),...(logRow === undefined ? {} : {row:logRow}),...((target?.kind === 'grid' || target?.kind === 'log') && tab.view === 'table' ? {ready:!!tab.tableStats} : {})};
      tab.mode = 'rendered';
      if (!target) tab.pendingAnchor = item.anchor.id;
      else if (target.kind === 'grid' || target.kind === 'log') {
        const row = target.kind === 'grid' ? target.row : target.sourceLine ? logRow : target.line;
        const collection = target.kind === 'grid' ? target.collection : undefined;
        if (row !== undefined) tab.pendingPosition = {kind:'grid',row,...(collection ? {collection} : {})};
        if (collection && collection !== tab.collection) { tab.collections = []; tab.collection = null; tab.gridStats = null; }
        tab.pendingCell = row === undefined ? null : {row,column:0};
      }
    } catch {
      if (current()) this.results[item.id] = false;
    }
  }

  rename(id: string, label: string): boolean {
    const current = this.entries.find(item => item.id === id);
    if (!this.ready || !current) return false;
    const renamed = readBookmarks([{...current,label:label.trim()}])[0];
    if (!renamed) return false;
    this.entries = this.entries.map(item => item.id === id ? renamed : item);
    void this.save(); return true;
  }

  private cancelPending(id: string) {
    for (const tab of workspace.tabs) {
      const jump = tab.pendingBookmark;
      if (jump?.id !== id) continue;
      tab.pendingBookmark = null; tab.pendingAnchor = null;
      if (jump.target) tab.pendingPosition = undefined;
      if (jump.target?.kind === 'grid' || jump.target?.kind === 'log') tab.pendingCell = null;
    }
  }

  remove(id: string) {
    if (!this.ready || !this.entries.some(item => item.id === id)) return;
    this.cancelPending(id);
    this.entries = this.entries.filter(item => item.id !== id);
    delete this.results[id];
    this.reassignRequests.delete(id);
    void this.save();
  }

  reassign(id: string, target: BookmarkTarget): boolean {
    const current = this.entries.find(item => item.id === id);
    if (!this.ready || !current || !sameSource(current.source,target.source)) return false;
    const updated = readBookmarks([{...current,anchor:target.anchor,target:target.target,fingerprint:target.fingerprint}])[0];
    if (!updated) return false;
    this.cancelPending(id);
    this.entries = this.entries.map(item => item.id === id ? updated : item);
    this.reassignRequests.delete(id);
    this.results[id] = true;
    void this.save(); return true;
  }

  async reassignCurrent(id: string, tab: DocTab | null): Promise<boolean> {
    const target = bookmarkTarget(tab);
    if (!target || !tab || !workspace.tabs.includes(tab)) return false;
    const generation = tab.meta.generation ?? 0;
    const request = ++this.reassignSequence;
    this.reassignRequests.set(id,request);
    const current = () => this.reassignRequests.get(id) === request && workspace.tabs.includes(tab)
      && generation === (tab.meta.generation ?? 0) && tab.status === 'ready' && sameSource(tab.meta.source,target.source);
    try {
      const fingerprint = await bookmarkFingerprint(tab.id);
      if (!current()) return false;
      const location = await this.captureLocation(tab,target);
      if (!current()) return false;
      if (!location) { toasts.show(t('bookmarkLocation.captureFailed'),'error'); return false; }
      return this.reassign(id,{...location,fingerprint});
    } catch { if (current()) toasts.show(t('bookmarkLocation.captureFailed'),'error'); return false; }
  }

  clear() {
    if (!this.ready) return;
    for (const item of this.entries) this.cancelPending(item.id);
    this.entries = []; this.results = {}; this.reassignRequests.clear();
    void this.save();
  }

  complete(tab: DocTab, jump: BookmarkJump, found: boolean) {
    if (tab.pendingBookmark?.request !== jump.request || tab.status !== 'ready'
      || (jump.generation !== undefined && jump.generation !== (tab.meta.generation ?? 0))
      || (jump.workspaceBound && !workspace.tabs.includes(tab))) return;
    const item = this.entries.find(item => item.id === jump.id);
    if (item && item.anchor.id === jump.anchor.id && item.anchor.text === jump.anchor.text && item.fingerprint === jump.fingerprint && sameBookmarkLocation(item.target,jump.target)) this.results[item.id] = found;
    tab.pendingBookmark = null;
    tab.pendingAnchor = null;
    if (jump.target) tab.pendingPosition = undefined;
    if (!found && (jump.target?.kind === 'grid' || jump.target?.kind === 'log')) tab.pendingCell = null;
  }
}

export const bookmarks = new Bookmarks();
