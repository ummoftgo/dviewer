export interface SearchOptions { caseSensitive: boolean; how: 'literal' | 'regex'; cap?: number }
export type Match = [number, number];
export interface Matches { ranges: Match[]; capped: boolean }
export type SearchError = 'length' | 'pattern' | 'timeout' | 'worker';

export class MatchError extends Error {
  constructor(readonly code: SearchError, message = '') { super(message); }
}

/** UTF-16 offsets deliberately match DOM Range offsets, including astral text. */
export function findMatches(text: string, query: string, options: SearchOptions): Matches {
  const ranges: Match[] = [];
  if (!query) return { ranges, capped: false };
  if (options.how === 'regex') {
    let length = 0;
    for (const _ of query) if (++length > 256) throw new MatchError('length');
  }
  const pattern = options.how === 'regex' ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex: RegExp;
  try { regex = new RegExp(pattern, options.caseSensitive ? 'gu' : 'giu'); }
  catch (error) { throw new MatchError('pattern', error instanceof Error ? error.message : String(error)); }
  const cap = options.cap ?? 2000;
  for (let match; (match = regex.exec(text));) {
    if (!match[0].length) {
      regex.lastIndex += (text.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    if (ranges.length >= cap) return { ranges, capped: true };
    ranges.push([match.index, match.index + match[0].length]);
  }
  return { ranges, capped: false };
}

export interface TextSpan { start: number; end: number }
/** First text node with content after this offset; separators belong to no node. */
export function spanAt(spans: readonly TextSpan[], offset: number): number {
  let low = 0, high = spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (spans[mid].end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}
