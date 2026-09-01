import { describe, expect, test } from "vitest";
import { formatBytes } from "./format";

describe("sizes as a reader wants them", () => {
  test("each unit takes over where the last one stops", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  /** Gigabytes get two decimals because the step between them is a long way. */
  test("the precision grows with the unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_610_612_736)).toBe("1.50 GB");
  });
});
