/**
 * What a tab says when the strip is full.
 *
 * These two functions decide what a reader can tell apart at a glance, and
 * both of them fail quietly: a badly cut name still looks like a name, and a
 * missing hint looks like two tabs that happen to match. Nothing throws, so
 * nothing but assertions will notice.
 */
import { describe, expect, test } from "vitest";
import { disambiguate, splitTitle, type TabLike } from "./tabs";
import type { ArchiveEntry, DocSource } from "./ipc";

/** The whole title back, spelled the way a tab renders it. */
function shown({ head, tail }: { head: string; tail: string }): string {
  return head + tail;
}

describe("splitting a title so the end survives", () => {
  test("a long name keeps its extension and four characters of stem", () => {
    const split = splitTitle("2026-09-report-final.json");
    expect(split.tail).toBe("inal.json");
    expect(shown(split)).toBe("2026-09-report-final.json");

    // The whole reason for the tail: these two differ only at the end, and a
    // browser cutting from the right would make both of them `2026-09-repo…`.
    expect(splitTitle("2026-09-report-draft.json").tail).toBe("raft.json");
  });

  test("a long extension does not eat the stem", () => {
    // Eight fixed characters would have been `.sqlite` and one letter.
    expect(splitTitle("nightly-backup-prod.sqlite").tail).toBe("prod.sqlite");
    expect(splitTitle("service-events-2026.jsonl").tail).toBe("2026.jsonl");
  });

  test("a name short enough to fit is not split at all", () => {
    for (const title of ["a.json", "sample.jsonc", "config.json"]) {
      expect(splitTitle(title)).toEqual({ head: title, tail: "" });
    }
  });

  test("a name with no extension is measured by characters", () => {
    expect(splitTitle("README")).toEqual({ head: "README", tail: "" });
    expect(splitTitle("Makefile")).toEqual({ head: "Makefile", tail: "" });
    // Long enough that eight characters are less than half of it.
    expect(splitTitle("Makefile-for-the-whole-project").tail).toBe("-project");
  });

  test("a double extension counts as one", () => {
    // The case this exists for: gzip is opened without being asked, so these
    // are ordinary names here. Counting only `.gz` would leave `.log.gz` and
    // no stem at all — the wrapper, and nothing about the document.
    expect(splitTitle("2026-09-05-access.log.gz").tail).toBe("cess.log.gz");
    expect(splitTitle("quarterly-revenue.json.gz").tail).toBe("enue.json.gz");
    expect(splitTitle("2026-09-nightly-backup.tar.gz").tail).toBe("ckup.tar.gz");

    // Only when the inner segment reads as part of a name: short and plain.
    // Here it is ten characters, so it is the document's own name and the
    // extension is just `.gz`.
    expect(splitTitle("archive.backup2026.gz").tail).toBe("2026.gz");

    // Two levels and no further, and a short name is still left whole.
    expect(splitTitle("a.tar.gz")).toEqual({ head: "a.tar.gz", tail: "" });
    // A leading dot is a dotfile, not an extension: there is no stem under it.
    expect(splitTitle(".gitignore")).toEqual({ head: ".gitignore", tail: "" });
  });

  test("a Korean name is counted in characters, not in bytes", () => {
    const title = "아주-긴-이름의-한글-보고서-최종.json";
    const split = splitTitle(title);
    expect(split.tail).toBe("서-최종.json");
    expect(shown(split)).toBe(title);
    // Nine characters, which is many more bytes — a tail measured in bytes
    // would land three characters short and inside one of them.
    expect([...split.tail].length).toBe(9);
  });

  test("a character outside the basic plane is one character", () => {
    // Hangul does not catch this on its own: every syllable is a single
    // UTF-16 unit, so counting units and counting characters agree. An emoji
    // is two units and one character, and it is the only shape that tells a
    // correct count from a plausible-looking wrong one.
    const title = "2026-09-분기-보고서-📊-최종.json";
    const split = splitTitle(title);
    expect(split.tail).toBe("📊-최종.json");
    expect(shown(split)).toBe(title);
    // Nine characters again, and never a lone half of the emoji.
    expect([...split.tail].length).toBe(9);
    expect(split.head.endsWith("-")).toBe(true);
  });
});

// --- telling same-named tabs apart -----------------------------------------

let next = 0;

function tab(title: string, source: DocSource): TabLike {
  next += 1;
  return { id: next, title, source };
}

function file(path: string): TabLike {
  return tab(path.split(/[/\\]/).at(-1)!, { type: "file", path });
}

function entry(name: string): ArchiveEntry {
  return { index: 0, name, size: 1, encrypted: false, kind: "json" };
}

/** A document taken out of the archive at `path`. */
function inside(path: string, name: string): TabLike {
  return tab(name.split("/").at(-1)!, {
    type: "archiveEntry",
    root: { type: "file", path },
    entries: [entry(name)],
  });
}

describe("telling same-named tabs apart", () => {
  test("a name nothing else has is left alone", () => {
    const tabs = [file("/w/a/config.json"), file("/w/b/settings.json")];
    expect(disambiguate(tabs).size).toBe(0);
  });

  test("two of the same name are told apart by their folder", () => {
    const [a, b] = [file("/w/alpha/config.json"), file("/w/beta/config.json")];
    const hints = disambiguate([a, b]);
    expect(hints.get(a.id)).toBe("alpha");
    expect(hints.get(b.id)).toBe("beta");
  });

  test("a folder they share widens to the one above it", () => {
    const [a, b] = [file("/w/one/src/config.json"), file("/w/two/src/config.json")];
    const hints = disambiguate([a, b]);
    expect(hints.get(a.id)).toBe("one/src");
    expect(hints.get(b.id)).toBe("two/src");
  });

  test("only the tabs that collide get a hint", () => {
    const [a, b, c] = [
      file("/w/alpha/config.json"),
      file("/w/beta/config.json"),
      file("/w/gamma/other.json"),
    ];
    const hints = disambiguate([a, b, c]);
    expect(hints.get(a.id)).toBe("alpha");
    expect(hints.get(b.id)).toBe("beta");
    expect(hints.has(c.id)).toBe(false);
  });

  test("a Windows path separates the same way a POSIX one does", () => {
    const [a, b] = [file("C:\\work\\alpha\\config.json"), file("/work/beta/config.json")];
    const hints = disambiguate([a, b]);
    expect(hints.get(a.id)).toBe("alpha");
    expect(hints.get(b.id)).toBe("beta");
  });

  test("two URLs are told apart by their host", () => {
    const [a, b] = [
      tab("config.json", { type: "url", url: "https://alpha.example.test/config.json" }),
      tab("config.json", { type: "url", url: "https://beta.example.test/config.json" }),
    ];
    const hints = disambiguate([a, b]);
    expect(hints.get(a.id)).toBe("alpha.example.test");
    expect(hints.get(b.id)).toBe("beta.example.test");
  });

  test("two entries are told apart by their archive, or by the folder in it", () => {
    const [a, b] = [inside("/w/alpha.zip", "config.json"), inside("/w/beta.zip", "config.json")];
    const across = disambiguate([a, b]);
    expect(across.get(a.id)).toBe("alpha.zip");
    expect(across.get(b.id)).toBe("beta.zip");

    // The same archive twice, so the archive's name says nothing and the
    // folder inside it does.
    const [c, d] = [inside("/w/one.zip", "dev/config.json"), inside("/w/one.zip", "prod/config.json")];
    const within = disambiguate([c, d]);
    expect(within.get(c.id)).toBe("dev");
    expect(within.get(d.id)).toBe("prod");
  });

  test("pasted text gets no hint, because there is nothing to hint at", () => {
    // Two of these can exist — the start pane titles every paste the same —
    // and neither has a path. A `#2` would be a number, not a distinction.
    const [a, b] = [
      tab("Pasted document", { type: "text" }),
      tab("Pasted document", { type: "text" }),
    ];
    const hints = disambiguate([a, b]);
    expect(hints.size).toBe(0);
  });
});
