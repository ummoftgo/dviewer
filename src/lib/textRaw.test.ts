import { describe, expect, test } from 'vitest';
import { containsLines, rawHighlights, rawWindow, visibleLines, RawRequests } from './textRaw';
import { scrollTopForRow } from './virtual';

const metrics = { rowHeight: 20, viewportHeight: 200, totalRows: 1000 };

describe('the raw window and its single cached range', () => {
  test('fetches actual content before and after the visible lines', () => {
    expect(visibleLines(metrics, 2000)).toEqual({ start: 100, end: 111 });
    expect(rawWindow(metrics, 2000)).toEqual({ start: 76, count: 59 });
    expect(rawWindow(metrics, 0)).toEqual({ start: 0, count: 35 });
    expect(rawWindow(metrics, 19800)).toEqual({ start: 966, count: 34 });
  });
  test('does not refetch until scrolling exhausts the cached window', () => {
    expect(containsLines(76, 59, visibleLines(metrics, 2020))).toBe(true);
    expect(containsLines(76, 59, visibleLines(metrics, 2480))).toBe(true);
    expect(containsLines(76, 59, visibleLines(metrics, 2500))).toBe(false);
    expect(containsLines(76, 59, visibleLines(metrics, 1500))).toBe(false);
    expect(containsLines(0, 0, { start: 0, end: 0 })).toBe(false);
  });
  test('a size-refused empty window stays blocked after finally until its key changes', () => {
    const requests = new RawRequests();
    const keyAt = (top: number) => {
      const window = rawWindow(metrics, top);
      return `${window.start}:${window.count}`;
    };
    const key = keyAt(2000);
    expect(requests.begin(key)).toBe(true);
    requests.finish(key, { code: 'tooLarge', params: { limitMb: 8 } });
    requests.finish(key); // The component's finally runs after catch.
    expect(requests.pending).toBe('');
    expect(containsLines(0, 0, visibleLines(metrics, 2001))).toBe(false);
    for (const top of [2000, 2001, 2019]) expect(requests.begin(keyAt(top))).toBe(false);
    const next = keyAt(2020);
    expect(requests.begin(next)).toBe(true);
    requests.finish(key, { code: 'tooLarge' }); // A stale completion cannot refuse the new range.
    expect(requests.pending).toBe(next);
    requests.finish(next, { code: 'io' });
    expect(requests.begin(next)).toBe(true); // Transient errors remain retryable.
    requests.finish(next);
    expect(requests.begin(key)).toBe(true);
  });
  test('reaches the last source line beyond the browser height ceiling', () => {
    const large = { ...metrics, totalRows: 50_000_000 };
    const top = scrollTopForRow(large, large.totalRows - 1);
    const page = rawWindow(large, top);
    expect(page.start + page.count).toBe(large.totalRows);
    expect(page.count).toBeLessThan(100);
  });
  test('keeps empty, tiny and unusually tall viewports bounded', () => {
    expect(rawWindow({ ...metrics, totalRows: 0 }, 0)).toEqual({ start: 0, count: 0 });
    expect(rawWindow({ ...metrics, totalRows: 1 }, 0)).toEqual({ start: 0, count: 1 });
    expect(rawWindow({ ...metrics, viewportHeight: 100_000, totalRows: 10_000 }, 0).count).toBe(2000);
  });
});

test('raw highlights preserve content and share the Rust Unicode and literal cases', () => {
  for (const [text, query] of [['ÄPFEL', 'äpfel'], ['Σς', 'σσ'], ['K ſ', 'k s'], ['😀', '😀'], ['[a]+', '[A]+']]) {
    expect(rawHighlights(text, query)).toEqual([{ text, matched: true }]);
  }
  expect(rawHighlights('before 😀ÄPFEL after', '😀äpfel')).toEqual([
    { text: 'before ', matched: false }, { text: '😀ÄPFEL', matched: true }, { text: ' after', matched: false },
  ]);
  expect(rawHighlights('a\tb', '').map(part => part.text).join('')).toBe('a\tb');
});
