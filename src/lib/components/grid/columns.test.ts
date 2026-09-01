/**
 * How wide a column has to be, in characters.
 *
 * The ranges in `isWide` are the part that has gone wrong before: treating
 * everything past Hangul Jamo as wide was close enough for CJK and wrong for
 * what sits between — arrows, dashes, bullets and maths signs are one column
 * each, and a table of them came out with columns twice the width they needed.
 */
import { describe, expect, test } from "vitest";
import { MAX_AUTO_COLUMN, MIN_COLUMN, measureColumns, visualLength } from "./columns";
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
  /** `measureColumns` reads `header` and writes `columnWidths`; nothing else on
   *  the tab is touched, so this is the whole tab as far as it is concerned. */
  function tabWith(header: string[]): DocTab {
    return { header, columnWidths: [] } as unknown as DocTab;
  }

  const row = (...cells: string[]): TableRow =>
    ({ cells: cells.map((text) => ({ text, truncated: false })) }) as unknown as TableRow;

  test("the widest of the header and the sampled rows decides", () => {
    const narrow = tabWith(["id"]);
    measureColumns(narrow, [row("1")], 1, 13);
    const wide = tabWith(["id"]);
    measureColumns(wide, [row("a much longer value than the header")], 1, 13);
    expect(wide.columnWidths[0]).toBeGreaterThan(narrow.columnWidths[0]);
  });

  test("a column is never narrower than the floor or wider than the ceiling", () => {
    const tab = tabWith(["", "x".repeat(500)]);
    measureColumns(tab, [], 2, 13);
    expect(tab.columnWidths[0]).toBe(MIN_COLUMN);
    expect(tab.columnWidths[1]).toBe(MAX_AUTO_COLUMN);
  });

  /** A short sample must not make a column that cannot hold its own header. */
  test("a header with no rows still gets measured", () => {
    const tab = tabWith(["지역", "매출"]);
    measureColumns(tab, [], 2, 13);
    expect(tab.columnWidths).toHaveLength(2);
    expect(tab.columnWidths.every((width) => width >= MIN_COLUMN)).toBe(true);
  });

  /** Rows shorter than the header row are ordinary in CSV, and used to read
   *  `undefined` into the measurement. */
  test("a ragged row is not a hole", () => {
    const tab = tabWith(["a", "b", "c"]);
    expect(() => measureColumns(tab, [row("1")], 3, 13)).not.toThrow();
    expect(tab.columnWidths).toHaveLength(3);
  });
});
