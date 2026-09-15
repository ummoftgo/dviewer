import type { DocSource, LaunchRequest } from '../ipc';
import { getValue, setValue } from '../persist';
import { t } from '../i18n';
import { toasts } from './toast.svelte';
import { workspace, type DocTab } from './docs.svelte';
import { compatiblePosition, readPosition, type Position } from '../position';

// The default toast expired at startup before the reader could notice it.
const RESTORE_FAILURE_MS = 6000;

type Source = Extract<DocSource, { type: 'file' | 'url' }>;
type Item = { source: Source; mode: 'rendered' | 'raw'; pos?: Position };
export type SessionSnapshot = { tabs: Item[]; active: Source | null };
const key = (source: Source) => JSON.stringify(source);

function persistentSource(source: DocSource): Source | null {
  if (source.type === 'file') return { type: 'file', path: source.path };
  if (source.type === 'url') return { type: 'url', url: source.url };
  if (source.type === 'archiveEntry' && source.root.type === 'file') return { type: 'file', path: source.root.path };
  return null;
}

export function captureSession(tabs: readonly DocTab[], activeId: number | null): SessionSnapshot {
  const saved: Item[] = [];
  const seen = new Set<string>();
  let active: Source | null = null;
  const selected = tabs.find(tab => tab.id === activeId);
  const selectedId = selected?.meta.source.type === 'treeSlice' ? selected.meta.source.parent : activeId;
  for (const tab of tabs) {
    if (tab.status !== 'ready') continue;
    const source = persistentSource(tab.meta.source);
    if (!source) continue;
    if (tab.id === selectedId) active = source;
    if (seen.has(key(source))) continue;
    seen.add(key(source));
    const pos = tab.meta.source.type === 'archiveEntry' ? undefined : tab.savedPosition;
    saved.push({ source, mode: tab.meta.source.type === 'archiveEntry' ? 'rendered' : tab.mode,
      ...(pos ? {pos:{...pos}} : {}) });
  }
  return { tabs: saved, active: active ?? saved[0]?.source ?? null };
}

function readSource(value: unknown): Source | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<Source>;
  if (source.type === 'file' && typeof source.path === 'string' && source.path) return { type: 'file', path: source.path };
  if (source.type === 'url' && typeof source.url === 'string' && source.url) return { type: 'url', url: source.url };
  return null;
}

export function readSession(value: unknown): SessionSnapshot {
  const saved = value as Partial<SessionSnapshot> | null;
  const tabs: Item[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved?.tabs)) for (const item of saved.tabs) {
    const source = readSource(item?.source);
    if (!source || seen.has(key(source))) continue;
    seen.add(key(source));
    const pos = readPosition(item.pos);
    tabs.push({ source, mode: item.mode === 'raw' ? 'raw' : 'rendered', ...(pos ? {pos} : {}) });
  }
  const active = readSource(saved?.active);
  return { tabs, active: active && seen.has(key(active)) ? active : tabs[0]?.source ?? null };
}

/** One queue owns startup and later deliveries, including those arriving during restoration. */
export class Session {
  ready = $state(false);
  private started = false;
  private requests: LaunchRequest[] = [];
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private structure = '';
  private snapshot = '';
  private writing = Promise.resolve();

  constructor(private target = workspace) {}

  receive(request: LaunchRequest): Promise<void> {
    this.requests.push(request);
    return this.started ? this.drain() : Promise.resolve();
  }

  private drain(): Promise<void> {
    return this.draining ??= (async () => {
      while (this.requests.length) await this.target.openLaunch(this.requests.shift()!);
    })().finally(() => {
      this.draining = null;
      if (this.requests.length) return this.drain();
    });
  }

  async start(request: LaunchRequest, restore: boolean, save: boolean): Promise<void> {
    if (restore) {
      const saved = readSession(await getValue('session').catch(error => {
        console.warn('[dviewer] could not load session:', error);
        return null;
      }));
      const opened = new Map<string, number>();
      let failed = 0;
      for (const item of saved.tabs) {
        const tab = item.source.type === 'file'
          ? await this.target.openPath(item.source.path) : await this.target.openUrl(item.source.url);
        if (tab) {
          tab.mode = item.mode;
          tab.pendingPosition = compatiblePosition(item.pos,tab.view,tab.mode === 'raw',tab.kind);
          opened.set(key(item.source), tab.id);
        }
        else failed++;
      }
      if (saved.active) {
        const id = opened.get(key(saved.active));
        if (id !== undefined) this.target.activate(id);
      }
      if (failed) { this.target.notice = null; toasts.show(t('session.failed', { count: failed }), 'info', RESTORE_FAILURE_MS); }
    }
    this.requests.unshift(request);
    this.started = true;
    await this.drain();
    this.ready = save;
  }

  watch(): void {
    if (!this.ready) return;
    const saved = captureSession(this.target.tabs, this.target.activeId);
    const structure = JSON.stringify({tabs:saved.tabs.map(({source,mode}) => ({source,mode})),active:saved.active});
    const snapshot = JSON.stringify(saved);
    if (snapshot === this.snapshot) return;
    const immediate = structure !== this.structure;
    this.structure = structure; this.snapshot = snapshot;
    clearTimeout(this.timer);
    if (immediate) void this.save(saved);
    else this.timer = setTimeout(() => { void this.save(); }, 1000);
  }

  save(saved = captureSession(this.target.tabs, this.target.activeId)): Promise<void> {
    clearTimeout(this.timer);
    if (!this.ready) return Promise.resolve();
    this.writing = this.writing.then(() => setValue('session', saved))
      .catch(error => console.warn('[dviewer] could not save session:', error));
    return this.writing;
  }
}

export const session = new Session();
