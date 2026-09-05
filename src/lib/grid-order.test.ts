import { expect, test } from "vitest";
import { nextSort } from "./grid-order";

test("sort cycles on one column and restarts on another", () => {
  const ascending = nextSort(null, 2);
  expect(ascending).toEqual({ column: 2, descending: false });
  const descending = nextSort(ascending, 2);
  expect(descending).toEqual({ column: 2, descending: true });
  expect(nextSort(descending, 2)).toBeNull();
  expect(nextSort(descending, 1)).toEqual({ column: 1, descending: false });
});
