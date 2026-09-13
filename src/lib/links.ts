import type { DocMeta, DocSource } from './ipc';

/** Collapse dot segments without letting a parent step consume a drive or UNC share. */
export function normalizeSegments(path: string): string {
  path = path.replace(/\\/g, '/');
  const root = path.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0] ?? '';
  const out: string[] = [];
  for (const segment of path.slice(root.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out.at(-1) !== '..') out.pop();
      else if (!root) out.push(segment);
    } else out.push(segment);
  }
  return (root && !root.endsWith('/') ? `${root}/` : root) + out.join('/');
}

type Link = (
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'archiveEntry'; parent: DocSource; name: string }
) & { anchor: string | null };

/** Only relative document links; external schemes and local anchors stay in interceptLinks. */
export function resolveLink(meta: Pick<DocMeta, 'source' | 'baseDir'>, href: string): Link | null {
  try {
    const hash = href.indexOf('#');
    const anchor = hash < 0 ? null : decodeURIComponent(href.slice(hash + 1));
    const path = (hash < 0 ? href : href.slice(0, hash)).split('?')[0];
    const decoded = decodeURIComponent(path).replace(/\\/g, '/');
    if (!decoded || decoded.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)
      || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
    const source = meta.source;
    if (source.type === 'file' && meta.baseDir) {
      return { type: 'file', path: normalizeSegments(`${meta.baseDir}/${decoded}`), anchor };
    }
    if (source.type === 'url') {
      const url = new URL(path.replace(/\\/g, '/'), source.url);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.search = ''; url.hash = '';
      return { type: 'url', url: url.href, anchor };
    }
    if (source.type === 'archiveEntry' && source.entries.length) {
      const entries = source.entries.slice(0, -1);
      const current = source.entries.at(-1)!.name.replace(/\\/g, '/');
      const name = normalizeSegments(current.slice(0, current.lastIndexOf('/') + 1) + decoded);
      if (name === '..' || name.startsWith('../')) return null;
      return { type: 'archiveEntry', name, anchor,
        parent: entries.length ? { ...source, entries } : source.root };
    }
  } catch {
    // Invalid percent escapes or an invalid URL have no document to open.
  }
  return null;
}
