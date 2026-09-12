import { beforeEach, expect, test, vi } from "vitest";
import { pageWidthOptions, pageWidthLabel, Settings } from "./settings.svelte";
import { i18n, t } from "../i18n";
import { getValue, setValue } from "../persist";

vi.mock("../persist", () => ({ getValue: vi.fn(), setValue: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test('session restoration defaults on and round-trips the disabled choice', async () => {
  const settings = new Settings();
  expect(settings.restoreSession).toBe(true);
  vi.mocked(getValue).mockResolvedValueOnce({ restoreSession: false });
  await settings.load();
  expect(settings.restoreSession).toBe(false);
  settings.save();
  expect(setValue).toHaveBeenLastCalledWith('settings', expect.objectContaining({ restoreSession: false }));
  settings.reset();
  expect(settings.restoreSession).toBe(true);
});

test('styled HTML choice loads, saves and resets to off', async () => {
  vi.mocked(getValue).mockResolvedValueOnce({ markdownCopyStyled: true });
  const settings = new Settings();
  expect(settings.markdownCopyStyled).toBe(false);
  await settings.load();
  expect(settings.markdownCopyStyled).toBe(true);
  settings.save();
  expect(setValue).toHaveBeenLastCalledWith('settings', expect.objectContaining({ markdownCopyStyled: true }));
  settings.reset();
  expect(settings.markdownCopyStyled).toBe(false);
  expect(setValue).toHaveBeenLastCalledWith('settings', expect.objectContaining({ markdownCopyStyled: false }));
});

test('an invalid saved styled HTML flag does not enable the option', async () => {
  vi.mocked(getValue).mockResolvedValueOnce({ markdownCopyStyled: 'true' });
  const settings = new Settings();
  await settings.load();
  expect(settings.markdownCopyStyled).toBe(false);
});

test("concurrent settings loads wait for the same saved default", async () => {
  let resolve!: (value: { markdownTableMode: string; markdownPageWidth: number }) => void;
  vi.mocked(getValue).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const settings = new Settings();
  const first = settings.load();
  expect(settings.load()).toBe(first);
  expect(settings.markdownTableMode).toBe("fill");
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

test.each([undefined, { markdownTableMode: "invalid" }])("missing or invalid table mode defaults to fill: %s", async (saved) => {
  vi.mocked(getValue).mockResolvedValueOnce(saved);
  const settings = new Settings();
  await settings.load();
  expect(settings.markdownTableMode).toBe("fill");
});

test("save and reset include the table default", () => {
  const settings = new Settings();
  settings.markdownTableMode = "fill";
  settings.markdownPageWidth = 0;
  settings.save();
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "fill", markdownPageWidth: 0 }));
  settings.reset();
  expect(settings.markdownTableMode).toBe("fill");
  expect(settings.markdownPageWidth).toBe(52);
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "fill", markdownPageWidth: 52 }));
});

test("page width menu keeps preset order and marks exactly the current value", () => {
  for (const current of [44, 52, 72, 0]) {
    const items = pageWidthOptions(current);
    expect(items.map((item) => item.width)).toEqual([44, 52, 72, 0]);
    expect(items.map((item) => item.label)).toEqual([
      "markdown.width.narrow", "markdown.width.normal", "markdown.width.wide", "markdown.width.full",
    ]);
    expect(items.filter((item) => item.checked).map((item) => item.width)).toEqual([current]);
  }
});

test("custom page width is the fifth marked option without replacing a preset", () => {
  for (const current of [40, 48, 60, 120]) {
    const items = pageWidthOptions(current);
    expect(items.map((item) => item.width)).toEqual([44, 52, 72, 0, current]);
    expect(items.map((item) => item.checked)).toEqual([false, false, false, false, true]);
    expect(items[4].label).toBe("markdown.width.custom");
  }
});

test("page width labels describe the actual preset or custom value", () => {
  const locale = i18n.setting;
  i18n.setting = "en";
  try {
    expect([44, 52, 72, 0, 60].map(pageWidthLabel)).toEqual([
      "Narrow (44rem)", "Normal (52rem)", "Wide (72rem)", "Full width", "60rem",
    ]);
    expect(t(pageWidthOptions(60)[4].label, { width: 60 })).toBe("Custom 60rem");
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
  expect(settings.markdownTableMode).toBe("fill");
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test("a saved scroll default survives the new fill default", async () => {
  vi.mocked(getValue).mockResolvedValueOnce({ markdownTableMode: "scroll" });
  const settings = new Settings();
  await settings.load();
  expect(settings.markdownTableMode).toBe("scroll");
});
