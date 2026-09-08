import { expect, test } from "vitest";
import { fillWidths, rectangularColumns, resizeWidths, widthRatios } from "./tables";

const row = (count: number) => ({ cells: Array.from({ length: count }, () => ({ colSpan: 1, rowSpan: 1 })) });
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

test("a plain table has the same logical columns in every row", () => {
  expect(rectangularColumns([row(3), row(3), row(3)])).toBe(3);
});

test("merged columns retain their original table behavior", () => {
  const header = row(2);
  header.cells[0].colSpan = 2;
  expect(rectangularColumns([header, row(3)])).toBe(0);
});

test("row spans, including spans to the end, are not resizeable grids", () => {
  for (const span of [0, 2]) {
    const header = row(2);
    header.cells[0].rowSpan = span;
    expect(rectangularColumns([header, row(2)])).toBe(0);
  }
});

test("empty and ragged tables cannot acquire mismatched colgroups", () => {
  expect(rectangularColumns([])).toBe(0);
  expect(rectangularColumns([row(0)])).toBe(0);
  expect(rectangularColumns([row(2), row(3)])).toBe(0);
});

test("filling preserves content proportions when both columns fit", () => {
  expect(fillWidths([80, 320], 1000, 48)).toEqual([200, 800]);
});

test("a short id cannot collapse below the minimum beside a long description", () => {
  expect(fillWidths([1, 999], 400, 48)).toEqual([48, 352]);
});

test("several clamped columns leave the remainder to the long column", () => {
  expect(fillWidths([1, 2, 97], 600, 100)).toEqual([100, 100, 400]);
});

test("a narrow page scrolls the minimum total instead of violating the minimum", () => {
  expect(fillWidths([40, 200, 160], 100, 48)).toEqual([48, 48, 48]);
});

test("unmeasured weights have a finite even fallback", () => {
  expect(fillWidths([], 300, 48)).toEqual([]);
  expect(fillWidths([0, NaN, Infinity], 300, 48)).toEqual([100, 100, 100]);
});

test("ratios total a hundred even when equal columns need a residual", () => {
  const ratios = widthRatios([100, 100, 100]);
  expect(ratios).toHaveLength(3);
  expect(ratios[0]).toBeCloseTo(100 / 3, 10);
  expect(sum(ratios)).toBe(100);
  expect(widthRatios([])).toEqual([]);
});

test("scroll dragging changes only that column and its table total", () => {
  const before = [100, 200, 300];
  const after = resizeWidths(before, 1, 50, "scroll", 48);
  expect(after).toEqual([100, 250, 300]);
  expect(sum(after)).toBe(650);
  expect(before).toEqual([100, 200, 300]);
});

test("scroll dragging stops at the minimum", () => {
  expect(resizeWidths([100, 200], 1, -900, "scroll", 48)).toEqual([100, 48]);
});

test("fill dragging compensates the right neighbor and keeps the total", () => {
  const after = resizeWidths([100, 200, 300], 0, 40, "fill", 48);
  expect(after).toEqual([140, 160, 300]);
  expect(sum(after)).toBe(600);
});

test("a neighbor at its minimum limits growing and shrinking", () => {
  expect(resizeWidths([100, 60, 300], 0, 90, "fill", 48)).toEqual([112, 48, 300]);
  expect(resizeWidths([100, 60, 300], 0, -900, "fill", 48)).toEqual([48, 112, 300]);
});

test("the last column uses its left neighbor", () => {
  expect(resizeWidths([100, 200, 300], 2, 70, "fill", 48)).toEqual([100, 130, 370]);
});

test("one fill column has nowhere to redistribute, but one scroll column can grow", () => {
  expect(resizeWidths([240], 0, 70, "fill", 48)).toEqual([240]);
  expect(resizeWidths([240], 0, 70, "scroll", 48)).toEqual([310]);
});
