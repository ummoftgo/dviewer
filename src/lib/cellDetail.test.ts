import { describe, expect, it } from 'vitest';
import { cellDetail, MAX_CELL_BYTES, SHOWN_CHARS } from './cellDetail';

describe('cellDetail', () => {
  it('tells the three kinds of nothing apart from each other and from a value', () => {
    expect(cellDetail({ text: '', truncated: false, null: true }).kind).toBe('null');
    expect(cellDetail({ text: '', truncated: false }).kind).toBe('empty');
    expect(cellDetail({ text: '', truncated: false, missing: true }).kind).toBe('missing');
    expect(cellDetail({ text: 'NULL', truncated: false }).kind).toBe('value');
    expect(cellDetail({ text: ' ', truncated: false }).kind).toBe('value');
  });

  it('counts characters as code points and lines by their breaks', () => {
    const detail = cellDetail({ text: '가😀\nb', truncated: false });
    expect(detail.chars).toBe(4);
    expect(detail.lines).toBe(2);
    expect(cellDetail({ text: '', truncated: false }).lines).toBe(0);
  });

  it('draws only the first characters of a long value, and never half of one', () => {
    const text = 'a'.repeat(SHOWN_CHARS - 1) + '😀' + 'tail';
    const detail = cellDetail({ text, truncated: false });
    expect(detail.clipped).toBe(true);
    expect(detail.shown).toBe('a'.repeat(SHOWN_CHARS - 1) + '😀');
    expect(detail.text).toBe(text);
    expect(detail.truncated).toBe(false);
  });

  it('holds a value to the copy ceiling even if the reader hands back more', () => {
    const detail = cellDetail({ text: '가'.repeat(MAX_CELL_BYTES / 3 + 1), truncated: false });
    expect(detail.truncated).toBe(true);
    expect(new TextEncoder().encode(detail.text).length).toBeLessThanOrEqual(MAX_CELL_BYTES);
    expect(detail.text.length).toBe(Math.floor(MAX_CELL_BYTES / 3));
  });

  it('says a value was cut when the reader did the cutting', () => {
    expect(cellDetail({ text: 'abc', truncated: true }).truncated).toBe(true);
  });

  it('offers a JSON tree only for a whole object or array', () => {
    expect(cellDetail({ text: ' {"a":[1,2]}', truncated: false }).json).toBe(true);
    expect(cellDetail({ text: '[1,2]', truncated: false }).json).toBe(true);
    expect(cellDetail({ text: '42', truncated: false }).json).toBe(false);
    expect(cellDetail({ text: '"text"', truncated: false }).json).toBe(false);
    expect(cellDetail({ text: '{broken', truncated: false }).json).toBe(false);
    expect(cellDetail({ text: '{"a":1}', truncated: true }).json).toBe(false);
  });
});
