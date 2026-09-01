/**
 * When two tabs are showing the same document.
 *
 * Every failure here is silent. Nothing throws and nothing looks wrong — each
 * click just opens one more copy of what is already on screen, and the reader
 * is left wondering why their tab strip fills up. That is why these three
 * functions were pulled out of the tab state in the first place, and why they
 * were the first frontend logic in this repository to get assertions at all.
 *
 * Moved here from `scripts/check-archive.ts`, which existed because there was
 * no runner. There is one now.
 */
import { describe, expect, test } from "vitest";
import { chainOf, opensAs, sameSource } from "./source";
import type { ArchiveEntry, DocSource } from "./ipc";

const FILE: DocSource = { type: "file", path: "C:/docs/bundle.zip" };
const URL: DocSource = { type: "url", url: "https://example.test/bundle.zip" };

function entry(index: number, name: string): ArchiveEntry {
  return { index, name, size: 1, encrypted: false, kind: "text" };
}

/** `a.zip → inner.zip → logs/app.log`, the shape a nested entry produces. */
function twoStepsIn(root: DocSource = FILE): DocSource {
  return chainOf(chainOf(root, entry(2, "inner.zip"))!, entry(7, "logs/app.log"))!;
}

describe("building the way in", () => {
  test("the first step roots itself at the file", () => {
    expect(chainOf(FILE, entry(2, "inner.zip"))).toEqual({
      type: "archiveEntry",
      root: FILE,
      entries: [{ index: 2, name: "inner.zip" }],
    });
  });

  test("further steps extend the chain without moving the root", () => {
    const deep = twoStepsIn();
    expect(deep.type === "archiveEntry" && deep.root).toEqual(FILE);
    expect(deep.type === "archiveEntry" && deep.entries.map((s) => s.index)).toEqual([2, 7]);
  });

  test("pasted text was never an archive", () => {
    expect(chainOf({ type: "text" }, entry(0, "a.txt"))).toBeNull();
  });
});

describe("recognising the same document", () => {
  test("the same chain, built twice", () => {
    expect(sameSource(twoStepsIn(), twoStepsIn())).toBe(true);
  });

  /**
   * The names are display text, frozen when the list was read. An archive
   * re-read under a different guess at its name encoding carries different ones
   * for the very same entries — so comparing names would quietly stop
   * recognising a tab that is already open.
   */
  test("mojibake names do not make it a different document", () => {
    const garbled = chainOf(chainOf(FILE, entry(2, "▒▒.zip"))!, entry(7, "▒▒▒/app.log"))!;
    expect(sameSource(twoStepsIn(), garbled)).toBe(true);
  });

  test("a different number is a different document", () => {
    const other = chainOf(chainOf(FILE, entry(2, "inner.zip"))!, entry(8, "logs/app.log"))!;
    expect(sameSource(twoStepsIn(), other)).toBe(false);
  });

  test("the same steps from a different root are not the same", () => {
    expect(sameSource(twoStepsIn(), twoStepsIn(URL))).toBe(false);
  });

  test("a prefix of a chain is not that chain", () => {
    expect(sameSource(chainOf(FILE, entry(2, "inner.zip"))!, twoStepsIn())).toBe(false);
  });

  test("plain sources compare on what names them", () => {
    expect(sameSource(FILE, { type: "file", path: "C:/docs/bundle.zip" })).toBe(true);
    expect(sameSource(FILE, { type: "file", path: "C:/docs/other.zip" })).toBe(false);
    expect(sameSource(URL, { type: "url", url: "https://example.test/bundle.zip" })).toBe(true);
  });

  test("a file and a chain rooted at it are different documents", () => {
    expect(sameSource(FILE, chainOf(FILE, entry(2, "inner.zip"))!)).toBe(false);
  });
});

describe("what opening a path produces", () => {
  test("an ordinary file tab", () => {
    expect(opensAs(FILE, "C:/docs/bundle.zip")).toBe(true);
    expect(opensAs(FILE, "C:/docs/other.zip")).toBe(false);
  });

  /**
   * The transparent unwrap. An archive holding one document opens as that
   * document, so the tab for `bundle.zip` is not a file tab at all — and
   * without this clause, opening the same archive twice makes two tabs.
   */
  test("a tab that is the single entry of that archive", () => {
    expect(opensAs(chainOf(FILE, entry(0, "only/report.json"))!, "C:/docs/bundle.zip")).toBe(true);
  });

  test("but not a tab two steps in", () => {
    expect(opensAs(twoStepsIn(), "C:/docs/bundle.zip")).toBe(false);
  });

  test("and not an entry of some other archive", () => {
    const elsewhere: DocSource = { type: "file", path: "C:/docs/other.zip" };
    expect(opensAs(chainOf(elsewhere, entry(0, "a.json"))!, "C:/docs/bundle.zip")).toBe(false);
  });

  test("a URL-rooted entry is not produced by opening a path", () => {
    expect(opensAs(chainOf(URL, entry(0, "a.json"))!, "C:/docs/bundle.zip")).toBe(false);
  });
});
