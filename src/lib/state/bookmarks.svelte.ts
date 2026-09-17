import { currentAnchor, readBookmarks, type Bookmark, type BookmarkAnchor, type BookmarkJump, type BookmarkSource } from '../bookmarks';
import { getValue, setValue } from '../persist';
import { sameSource } from '../source';
import { t } from '../i18n';
import { workspace, type DocTab } from './docs.svelte';
import { toasts } from './toast.svelte';

export function canBookmark(tab: DocTab | null): boolean {
  return !!tab && tab.status === 'ready' && tab.mode === 'rendered'
    && (tab.kind === 'markdown' || tab.kind === 'html')
    && (tab.meta.source.type === 'file' || tab.meta.source.type === 'url')
    && (tab.view === 'prose' ? tab.readBookmarkAnchor !== null
      : tab.view === 'frame' && tab.frameContentLoaded && tab.bookmarkHeading !== null);
}

export function bookmarkTarget(tab: DocTab | null): {source:BookmarkSource; anchor:BookmarkAnchor} | null {
  if (!tab || !canBookmark(tab)) return null;
  const source = tab.meta.source;
  if (source.type !== 'file' && source.type !== 'url') return null;
  const anchor = tab.view === 'prose' ? tab.readBookmarkAnchor!() : currentAnchor(tab.frameToc,tab.bookmarkHeading!);
  if (!anchor) return null;
  return {source:source.type === 'file' ? {type:'file',path:source.path} : {type:'url',url:source.url},
    anchor};
}

export class Bookmarks {
  entries = $state<Bookmark[]>([]);
  ready = $state(false);
  error = $state(false);
  results = $state<Record<string, boolean | undefined>>({});
  private loading: Promise<void> | undefined;
  private writing = Promise.resolve();
  private request = 0;

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

  add(source: BookmarkSource, anchor: BookmarkAnchor, label: string): Bookmark | null {
    if (!this.ready || !label.trim()) return null;
    const item = readBookmarks([{id:crypto.randomUUID(),source,anchor,label:label.trim(),created:Date.now()}])[0];
    if (!item) return null;
    this.entries = [...this.entries, item];
    void this.save();
    return item;
  }

  async open(item: Bookmark) {
    const request = ++this.request;
    const tab = item.source.type === 'file' ? await workspace.openPath(item.source.path) : await workspace.openUrl(item.source.url);
    if (!tab || request !== this.request) return;
    if ((tab.kind !== 'markdown' && tab.kind !== 'html') || !sameSource(tab.meta.source, item.source)) {
      this.results[item.id] = false;
      return;
    }
    tab.pendingPosition = undefined;
    tab.pendingBookmark = {id:item.id,anchor:{...item.anchor},request};
    tab.pendingAnchor = item.anchor.id;
    tab.mode = 'rendered';
  }

  rename(id: string, label: string): boolean {
    const current = this.entries.find(item => item.id === id);
    if (!this.ready || !current) return false;
    const renamed = readBookmarks([{...current,label:label.trim()}])[0];
    if (!renamed) return false;
    this.entries = this.entries.map(item => item.id === id ? renamed : item);
    void this.save(); return true;
  }

  remove(id: string) {
    if (!this.ready || !this.entries.some(item => item.id === id)) return;
    this.entries = this.entries.filter(item => item.id !== id);
    delete this.results[id];
    void this.save();
  }

  reassign(id: string, target: {source:BookmarkSource; anchor:BookmarkAnchor}): boolean {
    const current = this.entries.find(item => item.id === id);
    if (!this.ready || !current || !sameSource(current.source,target.source)) return false;
    const updated = readBookmarks([{...current,anchor:target.anchor}])[0];
    if (!updated) return false;
    this.entries = this.entries.map(item => item.id === id ? updated : item);
    this.results[id] = true;
    void this.save(); return true;
  }

  clear() {
    if (!this.ready) return;
    this.entries = []; this.results = {};
    void this.save();
  }

  complete(tab: DocTab, jump: BookmarkJump, found: boolean) {
    if (tab.pendingBookmark?.request !== jump.request) return;
    const item = this.entries.find(item => item.id === jump.id);
    if (item && item.anchor.id === jump.anchor.id && item.anchor.text === jump.anchor.text) this.results[item.id] = found;
    tab.pendingBookmark = null;
    tab.pendingAnchor = null;
  }
}

export const bookmarks = new Bookmarks();
