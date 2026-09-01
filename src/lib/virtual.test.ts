/**
 * The scroll geometry, at its boundaries.
 *
 * This module has had no automated check at all until now — the compressed
 * mapping was worked out on paper and confirmed by scrolling a 38-million-node
 * file by hand. That is exactly the kind of arithmetic that stays right until
 * someone simplifies it, and the failure is silent: rows still render, they are
 * just the wrong rows, or the last few million become unreachable.
 */
import { describe, expect, test } from "vitest";
import {
  MAX_SPACER_PX,
  anchorRow,
  isCompressed,
  rowTop,
  scrollTopForRow,
  spacerHeight,
  type ScrollMetrics,
} from "./virtual";

const ROW = 26;
const VIEWPORT = 800;

function metrics(totalRows: number): ScrollMetrics {
  return { rowHeight: ROW, totalRows, viewportHeight: VIEWPORT };
}

/** The row count at which the spacer would first exceed what a browser allows. */
const AT_CAP = Math.floor(MAX_SPACER_PX / ROW);

describe("below the cap, the geometry is plain arithmetic", () => {
  test("the spacer is the true content height", () => {
    const m = metrics(1_000);
    expect(isCompressed(m)).toBe(false);
    expect(spacerHeight(m)).toBe(1_000 * ROW);
  });

  test("a row sits exactly where its index puts it", () => {
    const m = metrics(1_000);
    expect(scrollTopForRow(m, 0)).toBe(0);
    expect(scrollTopForRow(m, 500)).toBe(500 * ROW);
    expect(anchorRow(m, 500 * ROW)).toBe(500);
  });

  /**
   * The two `scrollTop` terms cancel here, which is what keeps sub-pixel
   * scrolling smooth. A version that rounded the anchor would pass every test
   * above and make the rows jitter.
   */
  test("drawing is independent of where the scroll happens to be", () => {
    const m = metrics(1_000);
    expect(rowTop(m, 13, 40)).toBeCloseTo(40 * ROW, 6);
    expect(rowTop(m, 1_234.5, 40)).toBeCloseTo(40 * ROW, 6);
  });
});

describe("past the cap, the scroll position is mapped instead", () => {
  test("the spacer stops growing at the browser's ceiling", () => {
    const m = metrics(38_000_000);
    expect(isCompressed(m)).toBe(true);
    expect(spacerHeight(m)).toBe(MAX_SPACER_PX);
    // The measured ceiling in this WebView. The constant must stay under it.
    expect(MAX_SPACER_PX).toBeLessThan(33_554_428);
  });

  /**
   * The point of the mapping: every row remains addressable. Before it, the
   * spacer silently stopped growing and a 38-million-row document became a
   * three-percent-of-it document with nothing saying so.
   */
  test("the last row is still reachable", () => {
    const m = metrics(38_000_000);
    const last = m.totalRows - 1;
    const back = anchorRow(m, scrollTopForRow(m, last));
    expect(back).toBeGreaterThan(m.totalRows - VIEWPORT / ROW - 1);
  });

  test("the round trip holds across the range", () => {
    const m = metrics(38_000_000);
    for (const row of [0, 1, 1_000, 5_000_000, 20_000_000, 37_000_000]) {
      expect(anchorRow(m, scrollTopForRow(m, row))).toBeCloseTo(row, 0);
    }
  });

  test("scrolling forward never moves the anchor backward", () => {
    const m = metrics(38_000_000);
    let previous = -1;
    for (let at = 0; at <= MAX_SPACER_PX; at += MAX_SPACER_PX / 64) {
      const anchor = anchorRow(m, at);
      expect(anchor).toBeGreaterThanOrEqual(previous);
      previous = anchor;
    }
  });
});

describe("the boundary itself", () => {
  test("one row either side of the cap behaves as its side does", () => {
    expect(isCompressed(metrics(AT_CAP - 1))).toBe(false);
    expect(isCompressed(metrics(AT_CAP + 2))).toBe(true);
  });

  /**
   * Crossing the cap must not move the reader. A document that grows by one
   * row — a format switch, a re-index — would otherwise jump.
   */
  test("the top and the first rows agree on both sides", () => {
    for (const rows of [AT_CAP - 1, AT_CAP + 2]) {
      const m = metrics(rows);
      expect(scrollTopForRow(m, 0)).toBe(0);
      expect(anchorRow(m, 0)).toBe(0);
    }
  });
});

describe("degenerate inputs do not produce nonsense", () => {
  /** A document that failed to index, or one being switched to another format. */
  test("no rows", () => {
    const m = metrics(0);
    expect(spacerHeight(m)).toBe(0);
    expect(anchorRow(m, 0)).toBe(0);
    expect(scrollTopForRow(m, 0)).toBe(0);
  });

  test("one row", () => {
    const m = metrics(1);
    expect(spacerHeight(m)).toBe(ROW);
    expect(scrollTopForRow(m, 0)).toBe(0);
  });

  /** Before the viewport has been measured, which is one frame every time. */
  test("a viewport of no height", () => {
    const m = { rowHeight: ROW, totalRows: 1_000, viewportHeight: 0 };
    expect(Number.isFinite(anchorRow(m, 0))).toBe(true);
    expect(Number.isFinite(scrollTopForRow(m, 10))).toBe(true);
  });

  /** Guards a division by zero rather than describing a real state. */
  test("a row height of zero", () => {
    const m = { rowHeight: 0, totalRows: 1_000, viewportHeight: VIEWPORT };
    expect(anchorRow(m, 100)).toBe(0);
  });
});
