import { expect, test } from "vitest";
import { fillWidths, recommendWidths, rectangularColumns, resizeWidths, widthRatios } from "./tables";

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

test('fill bounds recommended long-token widths by the viewport and only overflows for the UI minimum', () => {
  const columns = [{min:40,max:80},{min:4000,max:4000}];
  for (const available of [95,96,97,600]) {
    const widths = fillWidths(recommendWidths(columns,available,48),available,48);
    expect(widths.every(width => width >= 48)).toBe(true);
    expect(sum(widths)).toBeCloseTo(Math.max(available,96));
  }
  expect(fillWidths(recommendWidths(columns,600,48),600,48)).toEqual([48,552]);
});

test('fill leaves recommendations that already fit unchanged', () => {
  const recommended = recommendWidths([{min:80,max:300},{min:120,max:900}],600,48);
  const widths = fillWidths(recommended,600,48);
  widths.forEach((width,index) => expect(width).toBeCloseTo(recommended[index]));
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

test('recommendation reserves each sampled word width before sharing spare room', () => {
  const widths = recommendWidths([{ min: 120, max: 500 }, { min: 80, max: 700 }], 320, 48);
  expect(widths[0]).toBeGreaterThanOrEqual(120);
  expect(widths[1]).toBeGreaterThanOrEqual(80);
  expect(sum(widths)).toBeCloseTo(320);
});

test('a sentence with nine times the spare capacity receives only three times the spare width', () => {
  expect(recommendWidths([{ min: 50, max: 150 }, { min: 50, max: 950 }], 300, 48)).toEqual([100, 200]);
});

test('a saturated short column gives its excess share to the remaining column', () => {
  expect(recommendWidths([{ min: 50, max: 75 }, { min: 50, max: 950 }], 300, 48)).toEqual([75, 225]);
});

test('once every column saturates, the unused document width is shared evenly', () => {
  expect(recommendWidths([{ min: 40, max: 60 }, { min: 80, max: 120 }], 300, 20)).toEqual([120, 180]);
});

test('sampled words wider than the document keep their minimum and overflow', () => {
  expect(recommendWidths([{ min: 100, max: 500 }, { min: 80, max: 200 }], 90, 48)).toEqual([100, 80]);
});

test('short cells still keep the UI minimum', () => {
  expect(recommendWidths([{ min: 0, max: 20 }, { min: 10, max: 30 }], 96, 48)).toEqual([48, 48]);
});

test('a single recommended column fills the page or retains its minimum', () => {
  expect(recommendWidths([{ min: 10, max: 40 }], 100, 48)).toEqual([100]);
  expect(recommendWidths([{ min: 10, max: 40 }], 5, 48)).toEqual([48]);
});

test('equal columns receive equal recommended widths', () => {
  const widths = recommendWidths(Array.from({ length: 3 }, () => ({ min: 40, max: 200 })), 300, 48);
  for (const width of widths) expect(width).toBeCloseTo(100);
});

test('recommendation preserves column order and leaves the measurements intact', () => {
  const columns = [{ min: 50, max: 950 }, { min: 50, max: 150 }];
  expect(recommendWidths(columns, 300, 48)).toEqual([200, 100]);
  expect(columns).toEqual([{ min: 50, max: 950 }, { min: 50, max: 150 }]);
});

test('a document without columns has no recommendation', () => {
  expect(recommendWidths([], 300, 48)).toEqual([]);
});
