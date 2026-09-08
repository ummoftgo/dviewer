import { beforeEach, expect, test, vi } from "vitest";
import { Settings } from "./settings.svelte";
import { getValue, setValue } from "../persist";

vi.mock("../persist", () => ({ getValue: vi.fn(), setValue: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test("concurrent settings loads wait for the same saved default", async () => {
  let resolve!: (value: { markdownTableMode: string }) => void;
  vi.mocked(getValue).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const settings = new Settings();
  const first = settings.load();
  expect(settings.load()).toBe(first);
  expect(settings.markdownTableMode).toBe("scroll");
  resolve({ markdownTableMode: "fill" });
  await first;
  expect(settings.markdownTableMode).toBe("fill");
  settings.markdownTableMode = "scroll";
  await settings.load();
  expect(settings.markdownTableMode).toBe("scroll");
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
  settings.save();
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "fill" }));
  settings.reset();
  expect(settings.markdownTableMode).toBe("scroll");
  expect(setValue).toHaveBeenLastCalledWith("settings", expect.objectContaining({ markdownTableMode: "scroll" }));
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
