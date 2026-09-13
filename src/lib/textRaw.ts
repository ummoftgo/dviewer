import { anchorRow, type ScrollMetrics } from './virtual';
import { findMatches } from './components/markdown/search';

export const RAW_OVERSCAN = 24;
export const RAW_PAGE_LINES = 2000;

export function visibleLines(metrics: ScrollMetrics, scrollTop: number) {
  const start = Math.min(metrics.totalRows, Math.max(0, Math.floor(anchorRow(metrics, scrollTop))));
  const count = metrics.rowHeight > 0 ? Math.ceil(metrics.viewportHeight / metrics.rowHeight) + 1 : 0;
  return { start, end: Math.min(metrics.totalRows, start + count) };
}

export function rawWindow(metrics: ScrollMetrics, scrollTop: number) {
  const visible = visibleLines(metrics, scrollTop);
  const start = Math.max(0, visible.start - RAW_OVERSCAN);
  const end = Math.min(metrics.totalRows, visible.end + RAW_OVERSCAN, start + RAW_PAGE_LINES);
  return { start, count: end - start };
}

export function containsLines(start: number, count: number, visible: { start: number; end: number }) {
  return count > 0 && start <= visible.start && start + count >= visible.end;
}

/** Literal Unicode highlighting shares the existing /giu matcher and its cap. */
export function rawHighlights(text: string, query: string) {
  const parts: { text: string; matched: boolean }[] = [];
  let at = 0;
  for (const [start, end] of findMatches(text, query, { how: 'literal', caseSensitive: false }).ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), matched: false });
    parts.push({ text: text.slice(start, end), matched: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), matched: false });
  return parts;
}
