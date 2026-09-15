import type { DocSource, TocEntry } from './ipc';

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

export function resolveAnchor(anchor: BookmarkAnchor, headings: readonly TocEntry[]): BookmarkAnchor | null {
  if (anchor.id === '') return {id:'',text:''};
  const heading = headings.find(entry => entry.id === anchor.id)
    ?? headings.find(entry => entry.text === anchor.text);
  return heading ? {id:heading.id,text:heading.text} : null;
}
