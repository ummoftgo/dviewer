import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../ipc";
import { Updates } from "./updates.svelte";

vi.mock("../ipc", () => ({
  on: vi.fn(), updateStatus: vi.fn(), updateCheck: vi.fn(), updateSkip: vi.fn(),
}));

function status(revision: number, available = true): ipc.UpdateStatus {
  return {
    revision, configured: true, flavor: "portableExe", check: true,
    lastCheck: null, skipped: null, phase: "idle", progress: null, error: null,
    available: available ? { version: "0.14.0", notes: "", publishedAt: null,
      canInstall: true, releaseUrl: "https://github.com/ummoftgo/dviewer/releases/tag/v0.14.0" } : null,
  };
}

beforeEach(() => vi.resetAllMocks());

test("a delayed new-window snapshot cannot overwrite a newer skip event", async () => {
  const updates = new Updates();
  const off = vi.fn();
  let receive!: (value: ipc.UpdateStatus) => void;
  vi.mocked(ipc.on).mockImplementation(async (_event, callback) => {
    receive = callback as typeof receive;
    return off;
  });
  let resolve!: (value: ipc.UpdateStatus) => void;
  vi.mocked(ipc.updateStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
  const stop = updates.watch();
  await vi.waitFor(() => expect(ipc.updateStatus).toHaveBeenCalledOnce());
  receive(status(2, false));
  resolve(status(1));
  await Promise.resolve();
  expect(updates.status?.available).toBeNull();
  stop();
  expect(off).toHaveBeenCalledOnce();
});

test("a new window receives the existing badge and stopping before subscription cleans up", async () => {
  const updates = new Updates();
  const off = vi.fn();
  vi.mocked(ipc.on).mockResolvedValue(off);
  vi.mocked(ipc.updateStatus).mockResolvedValue(status(3));
  const stop = updates.watch();
  await vi.waitFor(() => expect(updates.status?.available?.version).toBe("0.14.0"));
  stop();
  const earlyStop = updates.watch();
  earlyStop();
  await Promise.resolve();
  expect(off).toHaveBeenCalledTimes(2);
  expect(ipc.updateStatus).toHaveBeenCalledOnce();
});

test("manual check can show a skipped version, and skipping does not claim the app is current", async () => {
  const updates = new Updates();
  vi.mocked(ipc.updateCheck).mockResolvedValue({ ...status(4), skipped: "0.14.0" });
  await updates.checkNow();
  expect(updates.dialogOpen).toBe(true);
  vi.mocked(ipc.updateSkip).mockResolvedValue(status(5, false));
  await updates.skip("0.14.0");
  expect(updates.dialogOpen).toBe(false);
  expect(updates.checked).toBe(false);
  vi.mocked(ipc.updateCheck).mockRejectedValue({ code: "updateBadSignature" });
  await updates.checkNow();
  expect(updates.checked).toBe(false);
  expect(updates.error).toEqual({ code: "updateBadSignature" });
});
