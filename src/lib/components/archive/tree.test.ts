/**
 * The archive list's shape, and what a filter leaves of it.
 *
 * A wrong answer here is not an error either — the list simply comes back
 * missing rows, which reads as an archive that does not contain them.
 *
 * Moved here from `scripts/check-archive.ts`.
 */
import { describe, expect, test } from "vitest";
import { buildTree, flatten, type Row } from "./tree";
import type { ArchiveEntry } from "../../ipc";

function entry(index: number, name: string): ArchiveEntry {
  return { index, name, size: 1, encrypted: false, kind: "text" };
}

const ENTRIES = [
  entry(0, "readme.md"),
  entry(1, "src/lib/a.ts"),
  entry(2, "src/lib/b.ts"),
  entry(3, "src/main.ts"),
  entry(4, "docs/guide.md"),
];

const TREE = buildTree(ENTRIES);
const paths = (rows: Row[]) => rows.map((row) => row.node.path);

describe("the shape", () => {
  /**
   * Ordered by name rather than by position in the central directory: an
   * archive's own order is an artefact of whatever wrote it, and directories
   * come first so a folder is never lost among its files.
   */
  test("directories first, then names", () => {
    expect(paths(flatten(TREE, new Set(), ""))).toEqual([
      "docs",
      "docs/guide.md",
      "src",
      "src/lib",
      "src/lib/a.ts",
      "src/lib/b.ts",
      "src/main.ts",
      "readme.md",
    ]);
  });

  test("a directory says how many documents are under it", () => {
    const src = TREE.children.find((node) => node.path === "src");
    expect(src?.count).toBe(3);
    expect(TREE.children.find((node) => node.path === "docs")?.count).toBe(1);
  });

  /** A zip stores directories as zero-byte entries; the backend drops those, so
   *  every directory here is one the names implied. */
  test("directories are inferred and carry no entry", () => {
    const src = TREE.children.find((node) => node.path === "src");
    expect(src?.entry).toBeNull();
    expect(src?.children.find((n) => n.path === "src/main.ts")?.entry).not.toBeNull();
  });

  test("an archive with no entries is an empty list", () => {
    expect(paths(flatten(buildTree([]), new Set(), ""))).toEqual([]);
  });

  test("entries at the root need no directory row", () => {
    expect(paths(flatten(buildTree([entry(0, "only.txt")]), new Set(), ""))).toEqual(["only.txt"]);
  });
});

describe("collapsing", () => {
  test("a closed directory hides what is under it, and stays visible itself", () => {
    expect(paths(flatten(TREE, new Set(["src"]), ""))).toEqual([
      "docs",
      "docs/guide.md",
      "src",
      "readme.md",
    ]);
  });

  test("closing a nested directory leaves its parent open", () => {
    expect(paths(flatten(TREE, new Set(["src/lib"]), ""))).toEqual([
      "docs",
      "docs/guide.md",
      "src",
      "src/lib",
      "src/main.ts",
      "readme.md",
    ]);
  });

  test("open is the default — an archive is opened to see what is in it", () => {
    const rows = flatten(TREE, new Set(), "");
    expect(rows.filter((row) => !row.node.entry).every((row) => row.open)).toBe(true);
  });
});

describe("filtering", () => {
  /** A match behind a closed folder is a match the reader was not shown. */
  test("a filter reaches into closed directories", () => {
    expect(paths(flatten(TREE, new Set(["src", "src/lib"]), "b.ts"))).toEqual([
      "src",
      "src/lib",
      "src/lib/b.ts",
    ]);
  });

  /**
   * Not a special case: a directory's path is a prefix of everything under it,
   * so a file below a matching directory matches on its own path too.
   */
  test("a directory name brings out everything under it", () => {
    expect(paths(flatten(TREE, new Set(), "lib/"))).toEqual([
      "src",
      "src/lib",
      "src/lib/a.ts",
      "src/lib/b.ts",
    ]);
  });

  test("case does not matter", () => {
    expect(paths(flatten(TREE, new Set(), "README"))).toEqual(["readme.md"]);
  });

  test("surrounding space is not part of the query", () => {
    expect(paths(flatten(TREE, new Set(), "  readme  "))).toEqual(["readme.md"]);
  });

  test("nothing matching is an empty list, not the whole tree", () => {
    expect(paths(flatten(TREE, new Set(), "nothing"))).toEqual([]);
  });

  test("an empty query is not a filter", () => {
    expect(paths(flatten(TREE, new Set(), ""))).toEqual(paths(flatten(TREE, new Set(), "   ")));
  });

  /** A directory kept only because something under it matched must not then
   *  show its non-matching siblings. */
  test("only the matching documents survive", () => {
    expect(paths(flatten(TREE, new Set(), "a.ts"))).toEqual(["src", "src/lib", "src/lib/a.ts"]);
  });
});

describe("names that are not paths", () => {
  test("a leading slash does not make an empty directory", () => {
    expect(paths(flatten(buildTree([entry(0, "/rooted.txt")]), new Set(), ""))).toEqual([
      "/rooted.txt",
    ]);
  });

  test("two entries in one directory share the one row", () => {
    const tree = buildTree([entry(0, "d/a.txt"), entry(1, "d/b.txt")]);
    expect(paths(flatten(tree, new Set(), ""))).toEqual(["d", "d/a.txt", "d/b.txt"]);
  });
});
