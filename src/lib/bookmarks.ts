import type { DocSource, TocEntry } from './ipc';
import { sameSource } from './source';
import { prosePosition, type HeadingPosition } from './position';

export type BookmarkSource = Extract<DocSource, {type:'file' | 'url'}>;
export interface BookmarkAnchor { id: string; text: string }
/** Source coordinates, independent of filtered/sorted display row numbers. */
export type BookmarkLocation =
  | {kind:'tree'; path:string}
  | {kind:'grid'; row:number; collection?:string; hasHeader?:boolean; plain?:boolean; expanded?:boolean}
  | {kind:'log'; line:number; plain?:boolean; expanded?:boolean}
  | {kind:'pdf'; page:number};
export interface BookmarkTarget {source:BookmarkSource; anchor:BookmarkAnchor; target?:BookmarkLocation; fingerprint?:string}
export interface Bookmark {
  id: string;
  label: string;
  source: BookmarkSource;
  anchor: BookmarkAnchor;
  created: number;
  target?: BookmarkLocation;
  fingerprint?: string;
}
export interface BookmarkJump { id: string; anchor: BookmarkAnchor; request: number; target?: BookmarkLocation; ready?: boolean }

const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65536;
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** Reject malformed coordinates, including unknown kinds, rather than opening at document top. */
export function readBookmarkLocation(value: unknown): BookmarkLocation | undefined {
  if (!value || typeof value !== 'object') return;
  const loc = value as Record<string, unknown>;
  switch (loc.kind) {
    case 'tree': return text(loc.path) && !!loc.path ? {kind:'tree',path:loc.path} : undefined;
    case 'pdf': return natural(loc.page) && loc.page >= 1 ? {kind:'pdf',page:loc.page} : undefined;
    case 'log':
    case 'grid': {
      const coordinate = loc.kind === 'log' ? loc.line : loc.row;
      if (!natural(coordinate) || (loc.collection !== undefined && (!text(loc.collection) || !loc.collection))
        || ['hasHeader','plain','expanded'].some(key => loc[key] !== undefined && typeof loc[key] !== 'boolean')) return;
      const modes = {...(loc.plain === undefined ? {} : {plain:loc.plain as boolean}),
        ...(loc.expanded === undefined ? {} : {expanded:loc.expanded as boolean})};
      return loc.kind === 'log' ? {kind:'log',line:coordinate,...modes}
        : {kind:'grid',row:coordinate,...(loc.collection === undefined ? {} : {collection:loc.collection as string}),
          ...(loc.hasHeader === undefined ? {} : {hasHeader:loc.hasHeader as boolean}),...modes};
    }
  }
}
export function bookmarkLocationText(item: Pick<Bookmark,'target'|'anchor'>): string {
  const target = item.target;
  if (!target) return item.anchor.text;
  switch (target.kind) {
    case 'tree': {
      // Durable tree coordinates store exact source key bytes and sibling ordinals.
      // Show the corresponding readable path without dropping that stronger identity.
      try {
        const parts: unknown = JSON.parse(target.path);
        if (!Array.isArray(parts) || !parts.length || parts.length > 1024) return target.path;
        let path = '$';
        for (const part of parts.slice(1)) {
          if (!part || typeof part.key !== 'string' || !natural(part.index)) return target.path;
          if (part.key === '') path += `[${part.index}]`;
          else {
            let key = part.key;
            try { const parsed = JSON.parse(key); if (typeof parsed === 'string') key = parsed; } catch { /* Bare YAML/TOML keys remain literal. */ }
            path += `[${JSON.stringify(key)}]`;
          }
        }
        return path;
      } catch { return target.path; }
    }
    case 'grid': return `${target.collection ? target.collection + ' · ' : ''}${target.row + 1}`;
    case 'log': return String(target.line + 1);
    case 'pdf': return String(target.page);
  }
}
export function sameBookmarkLocation(a?: BookmarkLocation, b?: BookmarkLocation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}


export function readBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) return [];
  const saved: Bookmark[] = [], ids = new Set<string>();
  for (const item of value) {
    if (!item || !text(item.id) || !item.id || ids.has(item.id) || !text(item.label) || !item.label.trim()
      || !text(item.anchor?.id) || !text(item.anchor?.text)
      || !Number.isSafeInteger(item.created) || item.created < 0) continue;
    const target = item.target === undefined ? undefined : readBookmarkLocation(item.target);
    if ((item.target !== undefined && !target) || (item.fingerprint !== undefined && (!text(item.fingerprint) || !item.fingerprint || item.fingerprint.length > 256))) continue;
    const source = item.source;
    if (source?.type !== 'file' && source?.type !== 'url') continue;
    const address = source.type === 'file' ? source.path : source.url;
    if (!text(address) || !address) continue;
    saved.push({id:item.id, label:item.label, created:item.created,
      source:source.type === 'file' ? {type:'file',path:address} : {type:'url',url:address},
      anchor:{id:item.anchor.id,text:item.anchor.text},...(target ? {target} : {}),
      ...(item.fingerprint === undefined ? {} : {fingerprint:item.fingerprint})});
    ids.add(item.id);
  }
  return saved;
}

export function currentAnchor(headings: readonly TocEntry[], id: string): BookmarkAnchor {
  const heading = headings.find(entry => entry.id === id) ?? headings[0];
  return heading ? {id:heading.id,text:heading.text} : {id:'',text:''};
}

export function proseAnchor(headings: readonly TocEntry[], positions: readonly HeadingPosition[], top: number, max: number): BookmarkAnchor | null {
  if (!headings.length) return {id:'',text:''};
  const id = prosePosition(positions,top,max).heading ?? positions[0]?.id;
  const heading = headings.find(entry => entry.id === id);
  return heading ? {id:heading.id,text:heading.text} : null;
}

export function resolveAnchor(anchor: BookmarkAnchor, headings: readonly TocEntry[]): BookmarkAnchor | null {
  if (anchor.id === '') return {id:'',text:''};
  const heading = headings.find(entry => entry.id === anchor.id)
    ?? headings.find(entry => entry.text === anchor.text);
  return heading ? {id:heading.id,text:heading.text} : null;
}

export function bookmarkDocument(source: BookmarkSource): string {
  if (source.type === 'file') return source.path.split(/[\\/]/).pop() || source.path;
  try {
    const url = new URL(source.url);
    return decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
  } catch { return source.url; }
}

/** Closed documents are represented solely by their saved metadata. */
export function selectBookmarks(entries: readonly Bookmark[], source: DocSource | null,
  headings: readonly TocEntry[], all: boolean, query: string): Bookmark[] {
  const needle = query.trim().toLocaleLowerCase();
  const selected = entries.filter(item => (all || (source && sameSource(item.source,source)))
    && (!needle || `${item.label}\n${bookmarkDocument(item.source)}\n${bookmarkLocationText(item)}`.toLocaleLowerCase().includes(needle)));
  if (all) return selected.reverse().sort((a,b) => b.created - a.created);
  const order = new Map(headings.map((heading,index) => [heading.id,index]));
  const byText = new Map<string, number>();
  headings.forEach((heading,index) => { if (!byText.has(heading.text)) byText.set(heading.text,index); });
  const rank = (item: Bookmark) => item.target ? (item.target.kind === 'tree' ? Infinity : item.target.kind === 'grid' ? item.target.row : item.target.kind === 'log' ? item.target.line : item.target.page) : item.anchor.id === '' ? -1
    : order.get(item.anchor.id) ?? byText.get(item.anchor.text) ?? Infinity;
  return selected.map(item => ({item,rank:rank(item)})).sort((a,b) => a.rank - b.rank || a.item.created - b.item.created).map(({item}) => item);
}
