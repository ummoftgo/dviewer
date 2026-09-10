import { describe, expect, it } from 'vitest';
import { findMatches, MatchError, spanAt, type SearchOptions } from './search';

const literal: SearchOptions = { how: 'literal', caseSensitive: true };
const regex: SearchOptions = { how: 'regex', caseSensitive: true };
describe('findMatches', () => {
  it('does not search an empty query', () => expect(findMatches('abc', '', literal)).toEqual({ ranges: [], capped: false }));
  it('finds literal punctuation without interpreting it', () => expect(findMatches('a+b aab [x].*', 'a+b', literal).ranges).toEqual([[0, 3]]));
  it('escapes every regexp metacharacter', () => {
    const text = '.*+?^${}()|[]\\';
    expect(findMatches(text, text, literal).ranges).toEqual([[0, text.length]]);
  });
  it('preserves whitespace in literal queries', () => expect(findMatches('a b', ' ', literal).ranges).toEqual([[1, 2]]));
  it('matches case only when requested', () => {
    expect(findMatches('AaA', 'a', literal).ranges).toEqual([[1, 2]]);
    expect(findMatches('AaA', 'a', { ...literal, caseSensitive: false }).ranges).toEqual([[0, 1], [1, 2], [2, 3]]);
  });
  it('does not overlap adjacent matches', () => expect(findMatches('aaaaa', 'aa', literal).ranges).toEqual([[0, 2], [2, 4]]));
  it('finds a regular expression', () => expect(findMatches('id12 id3', 'id\\d+', regex).ranges).toEqual([[0, 4], [5, 8]]));
  it('reports a malformed pattern', () => {
    try { findMatches('text', '[', regex); throw new Error('expected invalid pattern'); }
    catch (error) { expect(error).toBeInstanceOf(MatchError); expect((error as MatchError).code).toBe('pattern'); }
  });
  it('limits regex to 256 Unicode code points, not UTF-16 units', () => {
    expect(findMatches('😀'.repeat(256), '😀'.repeat(256), regex).ranges).toEqual([[0, 512]]);
    try { findMatches('', '😀'.repeat(257), regex); throw new Error('expected length error'); }
    catch (error) { expect(error).toBeInstanceOf(MatchError); expect((error as MatchError).code).toBe('length'); }
  });
  it('does not impose the regex length limit on literal text', () => expect(findMatches('x'.repeat(300), 'x'.repeat(300), literal).ranges).toEqual([[0, 300]]));
  it('returns DOM-compatible UTF-16 offsets', () => expect(findMatches('😀한😀', '😀', literal).ranges).toEqual([[0, 2], [3, 5]]));
  it('does not change indices during Unicode case folding', () => expect(findMatches('İA😀a', 'a', { ...literal, caseSensitive: false }).ranges).toEqual([[1, 2], [4, 5]]));
  it('skips zero-width matches and advances across emoji', () => expect(findMatches('😀a', '(?=.)|$', regex).ranges).toEqual([]));
  it('still finds nonempty matches after zero-width ones', () => expect(findMatches('ab', '(?=a)|b', regex).ranges).toEqual([[1, 2]]));
  it('distinguishes exactly 2000 matches from overflow', () => {
    expect(findMatches('x'.repeat(2000), 'x', literal)).toMatchObject({ capped: false });
    const result = findMatches('x'.repeat(2001), 'x', literal);
    expect(result.ranges).toHaveLength(2000); expect(result.capped).toBe(true);
  });
  it('honors a smaller cap and verifies an additional match', () => {
    expect(findMatches('xx', 'x', { ...literal, cap: 2 }).capped).toBe(false);
    expect(findMatches('xxx', 'x', { ...literal, cap: 2 })).toEqual({ ranges: [[0, 1], [1, 2]], capped: true });
  });
  it('does not count zero-width matches as overflow', () => expect(findMatches('x', 'x|$', { ...regex, cap: 1 }).capped).toBe(false));
});

describe('spanAt', () => {
  const spans = [{ start: 0, end: 2 }, { start: 3, end: 6 }, { start: 6, end: 8 }];
  it('finds positions inside a node', () => expect(spanAt(spans, 1)).toBe(0));
  it('assigns an end boundary to the next node', () => expect(spanAt(spans, 6)).toBe(2));
  it('skips a separator without assigning it to the preceding node', () => expect(spanAt(spans, 2)).toBe(1));
  it('returns length for end of text and for no nodes', () => {
    expect(spanAt(spans, 8)).toBe(3); expect(spanAt([], 0)).toBe(0);
  });
});
