import { beforeEach, expect, test, vi } from "vitest";
import { nextPageWidth, pageWidthLabel, Settings } from "./settings.svelte";
import { i18n } from "../i18n";
import { getValue, setValue } from "../persist";

vi.mock("../persist", () => ({ getValue: vi.fn(), setValue: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test("concurrent settings loads wait for the same saved default", async () => {
  let resolve!: (value: { markdownTableMode: string; markdownPageWidth: number }) => void;
  vi.mocked(getValue).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const settings = new Settings();
  const first = settings.load();
  expect(settings.load()).toBe(first);
  expect(settings.markdownTableMode).toBe("scroll");
  resolve({ markdownTableMode: "fill", markdownPageWidth: 72 });
  await first;
  expect(settings.markdownTableMode).toBe("fill");
  expect(settings.markdownPageWidth).toBe(72);
  settings.markdownTableMode = "scroll";
  settings.markdownPageWidth = 0;
  await settings.load();
  expect(settings.markdownTableMode).toBe("scroll");
  expect(settings.markdownPageWidth).toBe(0);
  expect(getValue).toHaveBeenCalledTimes(1);
});

test.each([undefined, { markdownTableMode: "invalid" }])("missing or invalid table mode keeps scrolling: %s", async (saved) => {
  vi.mocked(getValue).mockResolvedValueOnce(saved);
  const settings = new Settings();
  await settings.load();
  expect(settings.markdownTableMode).toBe("scroll");
});

test("save and reset include the table default", () => {
  const settings = new Settings();
  settings.markdownTableMode = "fill";
  settings.markdownPageWidth = 0;
  settings.save();
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "fill", markdownPageWidth: 0 }));
  settings.reset();
  expect(settings.markdownTableMode).toBe("scroll");
  expect(settings.markdownPageWidth).toBe(52);
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "scroll", markdownPageWidth: 52 }));
});

test("page width presets cycle from normal through full and back", () => {
  let width = 52;
  const sequence = Array.from({ length: 4 }, () => width = nextPageWidth(width));
  expect(sequence).toEqual([72, 0, 44, 52]);
});

test("custom page widths advance to the next larger preset", () => {
  expect([40, 48, 56, 68, 76, 120].map(nextPageWidth)).toEqual([44, 52, 72, 72, 0, 0]);
});

test("page width labels describe the actual preset or custom value", () => {
  const locale = i18n.setting;
  i18n.setting = "en";
  try {
    expect([44, 52, 72, 0, 60].map(pageWidthLabel)).toEqual([
      "Narrow (44rem)", "Normal (52rem)", "Wide (72rem)", "Full width", "60rem",
    ]);
  } finally { i18n.setting = locale; }
});

test("page width accepts full width and finite values inside the documented range", async () => {
  for (const width of [0, 40, 44, 52, 60, 72, 120]) {
    vi.mocked(getValue).mockResolvedValueOnce({ markdownPageWidth: width });
    const settings = new Settings();
    await settings.load();
    expect(settings.markdownPageWidth).toBe(width);
  }
});

test("invalid saved page widths retain the default rather than breaking layout", async () => {
  for (const width of [undefined, null, "72", -1, 39, 121, 124, NaN, Infinity]) {
    vi.mocked(getValue).mockResolvedValueOnce({ markdownPageWidth: width });
    const settings = new Settings();
    await settings.load();
    expect(settings.markdownPageWidth).toBe(52);
  }
});

test("unreadable settings resolve to defaults so document opening can continue", async () => {
  vi.mocked(getValue).mockRejectedValueOnce(new Error("invalid stored JSON"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const settings = new Settings();
  await expect(settings.load()).resolves.toBeUndefined();
  expect(settings.markdownTableMode).toBe("scroll");
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});
