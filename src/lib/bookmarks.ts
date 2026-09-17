import type { DocSource, TocEntry } from './ipc';
import { sameSource } from './source';
import { prosePosition, type HeadingPosition } from './position';

export type BookmarkSource = Extract<DocSource, {type:'file' | 'url'}>;
export interface BookmarkAnchor { id: string; text: string }
export interface Bookmark {
  id: string;
  label: string;
  source: BookmarkSource;
  anchor: BookmarkAnchor;
  created: number;
}
export interface BookmarkJump { id: string; anchor: BookmarkAnchor; request: number }

const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65536;

export function readBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) return [];
  const saved: Bookmark[] = [], ids = new Set<string>();
  for (const item of value) {
    if (!item || !text(item.id) || !item.id || ids.has(item.id) || !text(item.label) || !item.label.trim()
      || !text(item.anchor?.id) || !text(item.anchor?.text)
      || !Number.isSafeInteger(item.created) || item.created < 0) continue;
    const source = item.source;
    if (source?.type !== 'file' && source?.type !== 'url') continue;
    const address = source.type === 'file' ? source.path : source.url;
    if (!text(address) || !address) continue;
    saved.push({id:item.id, label:item.label, created:item.created,
      source:source.type === 'file' ? {type:'file',path:address} : {type:'url',url:address},
      anchor:{id:item.anchor.id,text:item.anchor.text}});
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
    && (!needle || `${item.label}\n${bookmarkDocument(item.source)}`.toLocaleLowerCase().includes(needle)));
  if (all) return selected.reverse().sort((a,b) => b.created - a.created);
  const order = new Map(headings.map((heading,index) => [heading.id,index]));
  const byText = new Map<string, number>();
  headings.forEach((heading,index) => { if (!byText.has(heading.text)) byText.set(heading.text,index); });
  const rank = (item: Bookmark) => item.anchor.id === '' ? -1
    : order.get(item.anchor.id) ?? byText.get(item.anchor.text) ?? Infinity;
  return selected.map(item => ({item,rank:rank(item)})).sort((a,b) => a.rank - b.rank || a.item.created - b.item.created).map(({item}) => item);
}
