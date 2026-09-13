/**
 * How wide a column has to be, in characters.
 *
 * The ranges in `isWide` are the part that has gone wrong before: treating
 * everything past Hangul Jamo as wide was close enough for CJK and wrong for
 * what sits between — arrows, dashes, bullets and maths signs are one column
 * each, and a table of them came out with columns twice the width they needed.
 */
import { describe, expect, test } from "vitest";
import { MAX_AUTO_COLUMN, MAX_FIT_COLUMN, MIN_COLUMN, fitColumn, measureColumns, visualLength, layoutColumns, resizeColumn, resetColumns, automaticColumnLimit, resizeColumnKey } from "./columns";
import type { DocTab } from "../../state/docs.svelte";
import type { TableRow } from "../../ipc";
import { visibleColumns, hideColumn, revealColumn, moveColumn, projectLayout, freezeThrough, frozenOffsets } from './columns';
import { i18n, t } from '../../i18n';

function columnTab(): DocTab {
  return { columnOrder: [], hiddenColumns: [], frozenCount: 0, columnWidths: [100, 200, 300], tableFillRatios: null,
    selectedCell: null, pendingCell: null, revealedColumn: null } as unknown as DocTab;
}

test('frozen offsets follow displayed widths after the gutter and shrink when a pinned column is hidden', () => {
  const tab = columnTab(); tab.columnOrder = [2, 0, 1];
  freezeThrough(tab, 0, 3);
  expect(tab.frozenCount).toBe(2);
  const layout = projectLayout(tab, visibleColumns(tab, 3), 644, 44, 'scroll');
  expect(frozenOffsets(layout.widths, tab.frozenCount, 44)).toEqual([44, 344, null]);
  hideColumn(tab, 2, 3);
  expect(tab.frozenCount).toBe(1);
  expect(frozenOffsets([100, 200], tab.frozenCount, 44)).toEqual([44, null]);
  revealColumn(tab, 2);
  expect(tab.frozenCount).toBe(1);
});

test('frozen offsets update with fill width and unfreezing leaves no offsets', () => {
  expect(frozenOffsets([150, 450, 300], 2, 44)).toEqual([44, 194, null]);
  expect(frozenOffsets([100, 200], 0, 44)).toEqual([null, null]);
  expect(frozenOffsets([], 2, 44)).toEqual([]);
});

test('hide/move/reveal preserves source identity and protects the last column', () => {
  const tab = columnTab(); tab.selectedCell = { row: 4, column: 1 };
  expect(hideColumn(tab, 1, 3)).toBe(true); expect(tab.selectedCell).toBeNull();
  moveColumn(tab, 2, -1, 3);
  expect(visibleColumns(tab, 3)).toEqual([2, 0]);
  expect(hideColumn(tab, 0, 3)).toBe(true); expect(hideColumn(tab, 2, 3)).toBe(false);
  revealColumn(tab, 1, true);
  expect(visibleColumns(tab, 3)).toEqual([2, 1]); expect(tab.revealedColumn).toBe(1);
  const locale = i18n.setting; i18n.setting = 'ko';
  try { expect(t('grid.revealedColumn', { column: '이름' })).toBe('검색 결과의 이름 열을 다시 표시했습니다.'); }
  finally { i18n.setting = locale; }
  expect(tab.columnWidths).toEqual([100, 200, 300]);
});

test('projected fill compensates displayed neighbors and writes to source numbers', () => {
  const tab = columnTab(); tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [1];
  let layout = projectLayout(tab, visibleColumns(tab, 3), 844, 44, 'fill');
  expect(layout.widths).toEqual([600, 200]);
  resizeColumnKey(tab, layout, 2, 'ArrowRight');
  layout = projectLayout(tab, visibleColumns(tab, 3), 844, 44, 'fill');
  expect(layout.widths).toEqual([expect.closeTo(608), expect.closeTo(192)]);
  fitColumn(tab, [row('', '', 'x'.repeat(150))], 2, 10, '', MAX_FIT_COLUMN, layout);
  expect(tab.columnWidths).toEqual([expect.closeTo(192), 200, 956]);
  expect(projectLayout(tab, visibleColumns(tab, 3), 844, 44, 'fill').mode).toBe('scroll');
});

test('width reset preserves configuration and recommendation skips hidden columns', () => {
  const tab = columnTab(); tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [1];
  measureColumns(tab, [row('short', 'hidden'.repeat(100), 'wide'.repeat(15))], 3, 10, () => '', MAX_FIT_COLUMN, [2, 0]);
  expect(tab.columnWidths[1]).toBe(200);
  resetColumns(tab);
  expect(tab.columnOrder).toEqual([2, 1, 0]); expect(tab.hiddenColumns).toEqual([1]);
});

const row = (...cells: string[]): TableRow =>
  ({ cells: cells.map((text) => ({ text, truncated: false })) }) as unknown as TableRow;

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
    expect(tab.columnWidths).toEqual([95, 8000, 285]);
    fitColumn(tab, [], 1, 15, 'x'.repeat(1000));
    expect(tab.columnWidths).toEqual([95, 420, 285]);
  });
  test('recommendation resamples all columns and reset returns to the automatic ceiling', () => {
    const tab = { columnWidths: [95, 190], tableFillRatios: [40, 60], tableWidthMode: 'fill' } as unknown as DocTab;
    const names = ['', 'x'.repeat(1000)];
    measureColumns(tab, [], 2, 15, column => names[column], MAX_FIT_COLUMN);
    expect(tab.columnWidths).toEqual([MIN_COLUMN, 8000]);
    expect(tab.tableFillRatios).toBeNull();
    measureColumns(tab, [], 2, 15, column => names[column]);
    expect(tab.columnWidths).toEqual([MIN_COLUMN, 420]);
    expect(tab.tableWidthMode).toBe('fill');
  });
});


test('switching collections discards both widths and drag ratios before the next page arrives', () => {
  const tab = { columnWidths: [100, 200], tableFillRatios: [90, 10], tableWidthMode: 'fill' } as unknown as DocTab;
  resetColumns(tab);
  expect(tab.columnWidths).toEqual([]);
  expect(tab.tableFillRatios).toBeNull();
  expect(tab.tableWidthMode).toBe('fill');
});


test('automatic scroll widths use the preview up to 8000 and switching back to fill restores 420', () => {
  const tab = { columnWidths: [], tableFillRatios: [90, 10] } as unknown as DocTab;
  const sample = [row('x'.repeat(100), 'x'.repeat(1000))];
  for (const mode of ['scroll', 'fill', 'scroll'] as const) {
    measureColumns(tab, sample, 2, 15, () => '', automaticColumnLimit(mode));
    expect(tab.columnWidths).toEqual(mode === 'scroll' ? [956, 8000] : [420, 420]);
    expect(tab.tableFillRatios).toBeNull();
  }
});


test('keyboard resize uses 8 or 24 pixels and keeps fill compensation separate from scroll baselines', () => {
  const tab = { columnWidths: [100, 200], tableFillRatios: null } as unknown as DocTab;
  expect(resizeColumnKey(tab, { widths: [300, 600], mode: 'fill' }, 0, 'ArrowRight')).toBe(true);
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill').widths).toEqual([expect.closeTo(308), expect.closeTo(592)]);
  expect(tab.columnWidths).toEqual([100, 200]);
  resizeColumnKey(tab, { widths: [308, 592], mode: 'fill' }, 0, 'ArrowLeft', true);
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill').widths).toEqual([expect.closeTo(284), expect.closeTo(616)]);
  resizeColumnKey(tab, { widths: [100, 200], mode: 'scroll' }, 0, 'ArrowRight', true);
  expect(tab.columnWidths).toEqual([124, 200]); expect(tab.tableFillRatios).toBeNull();
  resizeColumnKey(tab, { widths: [70, 200], mode: 'scroll' }, 0, 'ArrowLeft');
  expect(tab.columnWidths).toEqual([64, 200]);
  expect(resizeColumnKey(tab, { widths: [64, 200], mode: 'scroll' }, 0, 'Tab')).toBe(false);
});

test('content fit keeps fill and the neighbor minimum, overflowing only for content wider than the viewport', () => {
  const tab = { columnWidths: [100, 200], tableFillRatios: null } as unknown as DocTab;
  const fit = (contentLength: number, widths = [300, 600]) => fitColumn(tab, [row('x'.repeat(contentLength))], 0, 10, '', MAX_FIT_COLUMN, { widths, mode: 'fill' });
  fit(60); // 60 * 6.2 + 26 = 398
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill')).toEqual({ widths: [expect.closeTo(398), expect.closeTo(502)], mode: 'fill' });
  expect(tab.columnWidths).toEqual([100, 200]);
  fit(140); // 894 fits the viewport, but its neighbor must retain 64.
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill')).toEqual({ widths: [expect.closeTo(836), expect.closeTo(64)], mode: 'fill' });
  fit(150); // 956 exceeds the 900px available width.
  expect(tab.columnWidths).toEqual([956, 600]); expect(tab.tableFillRatios).toBeNull();
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill').mode).toBe('scroll');
  fitColumn(tab, [row('x'.repeat(60))], 0, 10, '', MAX_FIT_COLUMN, { widths: [956, 600], mode: 'scroll' });
  expect(tab.columnWidths).toEqual([398, 600]);
  const single = { columnWidths: [100], tableFillRatios: null } as unknown as DocTab;
  fitColumn(single, [row('x'.repeat(60))], 0, 10, '', MAX_FIT_COLUMN, { widths: [900], mode: 'fill' });
  expect(layoutColumns(single.columnWidths, single.tableFillRatios, 944, 44, 'fill').widths).toEqual([900]);
});


test('overflowing fit preserves every displayed neighbor without mutating the layout snapshot', () => {
  const baseline = [100, 200];
  const displayed = [300, 600];
  const tab = { columnWidths: baseline, tableFillRatios: [1, 2] } as unknown as DocTab;
  fitColumn(tab, [row('x'.repeat(150))], 0, 10, '', MAX_FIT_COLUMN, { widths: displayed, mode: 'fill' });
  expect(tab.columnWidths).toEqual([956, 600]);
  expect(tab.tableFillRatios).toBeNull();
  expect(layoutColumns(tab.columnWidths, tab.tableFillRatios, 944, 44, 'fill').mode).toBe('scroll');
  expect(baseline).toEqual([100, 200]);
  expect(displayed).toEqual([300, 600]);
});
