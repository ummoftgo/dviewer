/**
 * How wide a column has to be, in characters.
 *
 * The ranges in `isWide` are the part that has gone wrong before: treating
 * everything past Hangul Jamo as wide was close enough for CJK and wrong for
 * what sits between — arrows, dashes, bullets and maths signs are one column
 * each, and a table of them came out with columns twice the width they needed.
 */
import { describe, expect, test } from "vitest";
import { MAX_AUTO_COLUMN, MAX_FIT_COLUMN, MIN_COLUMN, fitColumn, measureColumns, visualLength, layoutColumns, resizeColumn } from "./columns";
import type { DocTab } from "../../state/docs.svelte";
import type { TableRow } from "../../ipc";

describe("counting columns rather than characters", () => {
  test("Latin text is one column each", () => {
    expect(visualLength("")).toBe(0);
    expect(visualLength("hello")).toBe(5);
    expect(visualLength("id=1234")).toBe(7);
  });

  test("Hangul and CJK are two", () => {
    expect(visualLength("서울")).toBe(4);
    expect(visualLength("東京")).toBe(4);
    expect(visualLength("매출 120")).toBe(8);
  });

  /** The regression the ranges were narrowed for. */
  test("the symbols between the CJK blocks are not wide", () => {
    for (const ch of ["→", "—", "•", "±", "×", "√", "…"]) {
      expect(visualLength(ch)).toBe(1);
    }
  });

  test("emoji are wide, and count once despite their length in code units", () => {
    expect(visualLength("🔒")).toBe(2);
    expect("🔒".length).toBe(2);
  });
});

describe("guessing a width from one page", () => {
  test("fitting one column uses its actual collection name and preserves other widths", () => {
    const tab = { header: [], columnWidths: [95, 190, 285] } as unknown as DocTab;
    fitColumn(tab, [], 1, 13, "collection column name ".repeat(8));
    expect(tab.columnWidths).toEqual([95, MAX_AUTO_COLUMN, 285]);
  });
  /** `measureColumns` reads `header` and writes `columnWidths`; nothing else on
   *  the tab is touched, so this is the whole tab as far as it is concerned. */
  function tabWith(header: string[]): DocTab {
    return { header, columnWidths: [] } as unknown as DocTab;
  }

  const row = (...cells: string[]): TableRow =>
    ({ cells: cells.map((text) => ({ text, truncated: false })) }) as unknown as TableRow;

  test("the widest of the header and the sampled rows decides", () => {
    const narrow = tabWith(["id"]);
    measureColumns(narrow, [row("1")], 1, 13, (column) => narrow.header[column] ?? "");
    const wide = tabWith(["id"]);
    measureColumns(wide, [row("a much longer value than the header")], 1, 13, (column) => wide.header[column] ?? "");
    expect(wide.columnWidths[0]).toBeGreaterThan(narrow.columnWidths[0]);
  });

  test("a column is never narrower than the floor or wider than the ceiling", () => {
    const tab = tabWith(["", "x".repeat(500)]);
    measureColumns(tab, [], 2, 13, (column) => tab.header[column] ?? "");
    expect(tab.columnWidths[0]).toBe(MIN_COLUMN);
    expect(tab.columnWidths[1]).toBe(MAX_AUTO_COLUMN);
  });

  /** A short sample must not make a column that cannot hold its own header. */
  test("a header with no rows still gets measured", () => {
    const tab = tabWith(["지역", "매출"]);
    measureColumns(tab, [], 2, 13, (column) => tab.header[column] ?? "");
    expect(tab.columnWidths).toHaveLength(2);
    expect(tab.columnWidths.every((width) => width >= MIN_COLUMN)).toBe(true);
  });

  /** Rows shorter than the header row are ordinary in CSV, and used to read
   *  `undefined` into the measurement. */
  test("a ragged row is not a hole", () => {
    const tab = tabWith(["a", "b", "c"]);
    expect(() => measureColumns(tab, [row("1")], 3, 13, (column) => tab.header[column] ?? "")).not.toThrow();
    expect(tab.columnWidths).toHaveLength(3);
  });
});

describe('table width layout', () => {
  test('one column fills the viewport after the gutter and proportional columns shrink from their baseline', () => {
    expect(layoutColumns([100], null, 944, 44, 'fill')).toEqual({ widths: [900], mode: 'fill' });
    const base = [100, 200];
    expect(layoutColumns(base, null, 944, 44, 'fill').widths).toEqual([300, 600]);
    expect(layoutColumns(base, null, 644, 44, 'fill').widths).toEqual([200, 400]);
    expect(base).toEqual([100, 200]);
  });
  test('overflow and explicit scroll retain their baseline, including the gutter', () => {
    expect(layoutColumns([100, 200], null, 343, 44, 'fill')).toEqual({ widths: [100, 200], mode: 'scroll' });
    expect(layoutColumns([100, 200], [1, 1], 944, 44, 'scroll')).toEqual({ widths: [100, 200], mode: 'scroll' });
    expect(layoutColumns([], null, 944, 44, 'fill').widths).toEqual([]);
  });
  test('a fill drag stores ratios without turning the viewport into a minimum width', () => {
    const tab = { columnWidths: [100, 200], tableFillRatios: null } as unknown as DocTab;
    resizeColumn(tab, [300, 600], 0, 100, 'fill');
    expect(tab.columnWidths).toEqual([100, 200]);
    const narrow = layoutColumns(tab.columnWidths, tab.tableFillRatios, 644, 44, 'fill');
    expect(narrow.widths[0]).toBeCloseTo(600 * 4 / 9);
    expect(narrow.widths[1]).toBeCloseTo(600 * 5 / 9);
    expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 244, 44, 'fill').mode).toBe('scroll');
  });
  test('fill compensation respects the neighbor minimum and a single column cannot shrink', () => {
    const tab = { columnWidths: [100, 200], tableFillRatios: null } as unknown as DocTab;
    resizeColumn(tab, [300, 600], 0, 1000, 'fill');
    expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill').widths[1]).toBeCloseTo(MIN_COLUMN);
    resizeColumn(tab, [100, 200], 0, -200, 'scroll');
    expect(tab.columnWidths).toEqual([MIN_COLUMN, 200]);
    expect(tab.tableFillRatios).toBeNull();
    resizeColumn(tab, [900], 0, -800, 'fill');
    expect(tab.tableFillRatios).toEqual([100]);
  });
  test('explicit fit lifts the automatic ceiling only when its caller opts in', () => {
    const tab = { columnWidths: [95, 190, 285], tableFillRatios: null } as unknown as DocTab;
    fitColumn(tab, [], 1, 15, 'x'.repeat(1000), MAX_FIT_COLUMN);
    expect(tab.columnWidths).toEqual([95, 4000, 285]);
    fitColumn(tab, [], 1, 15, 'x'.repeat(1000));
    expect(tab.columnWidths).toEqual([95, 420, 285]);
  });
  test('recommendation resamples all columns and reset returns to the automatic ceiling', () => {
    const tab = { columnWidths: [95, 190], tableFillRatios: [40, 60], tableWidthMode: 'fill' } as unknown as DocTab;
    const names = ['', 'x'.repeat(1000)];
    measureColumns(tab, [], 2, 15, column => names[column], MAX_FIT_COLUMN);
    expect(tab.columnWidths).toEqual([MIN_COLUMN, 4000]);
    expect(tab.tableFillRatios).toBeNull();
    measureColumns(tab, [], 2, 15, column => names[column]);
    expect(tab.columnWidths).toEqual([MIN_COLUMN, 420]);
    expect(tab.tableWidthMode).toBe('fill');
  });
});
