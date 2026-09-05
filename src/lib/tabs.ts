/**
 * What a tab can say about itself when there is not room to say it all.
 *
 * Two problems, one file. A long name does not fit, and the end of it — the
 * part that differs between `…report-final.json` and `…report-draft.json` — is
 * exactly the part the browser drops. And two files with the same name look
 * identical in the strip even when they are nothing alike.
 *
 * Both answers are computed from the text and nothing else: no element is
 * measured, no font is asked about. `splitTitle` decides *where* a name may be
 * cut and leaves the cutting to CSS, so the same tab reads correctly at any
 * window width, zoom level or font — the browser is the one thing that knows
 * how wide a glyph is, and it re-answers on every resize for free.
 */
import type { DocSource } from "./ipc";

/** A tab, as much of one as this file needs to know about. */
export interface TabLike {
  id: number;
  /** What the strip shows — the file's name, or the blank tab's label. */
  title: string;
  source: DocSource;
}

/**
 * A title split into the part that may be shortened and the part that may not.
 *
 * `tail` is what has to survive: the end of the stem plus the extension. The
 * badge already says what format a document is, so the extension is not there
 * to name the format — it is there because dropping it would cut mid-word and
 * leave `…-fin`, which reads as a truncation of nothing in particular.
 *
 * Four characters of stem, whatever the extension costs. A fixed tail loses
 * that stem to a long extension: eight characters of `backup-prod.sqlite` is
 * `.sqlite` and one letter, which is the one letter that does not distinguish
 * it from anything.
 */
export function splitTitle(title: string): { head: string; tail: string } {
  // Code points, not bytes and not UTF-16 units: a Korean name is as long as
  // it has characters, and cutting it by bytes would cut inside one.
  const characters = [...title];
  let dot = characters.lastIndexOf(".");
  if (dot > 0) {
    // A double extension is one extension. This viewer opens gzip without
    // being asked, so `access.log.gz` is an everyday name here and the two
    // halves name the format together — keeping only `.gz` would spend the
    // whole tail on the wrapper and leave nothing of the stem.
    //
    // Short and plain is what makes an inner segment part of the name rather
    // than part of the document: `.json.gz` and `.tar.gz` qualify,
    // `archive.backup2026.gz` does not. Two levels is as far as it goes.
    const inner = characters.lastIndexOf(".", dot - 1);
    if (inner > 0 && /^[a-z0-9]{1,5}$/i.test(characters.slice(inner + 1, dot).join(""))) {
      dot = inner;
    }
  }
  // A dot at the front is a dotfile, not an extension — `.gitignore` has no
  // stem to keep the end of.
  const wanted = dot > 0 ? characters.length - dot + 4 : 8;

  // Nothing to gain: a tail that is most of the title would leave a head too
  // short to be worth the `…`, and a title shorter than the tail is already
  // whole.
  if (wanted * 2 > characters.length) {
    return { head: title, tail: "" };
  }
  const at = characters.length - wanted;
  return {
    head: characters.slice(0, at).join(""),
    tail: characters.slice(at).join(""),
  };
}

/**
 * The shortest thing that tells same-named tabs apart, for each of them.
 *
 * Only tabs whose title collides get one; a name that is already unique is
 * shown the way it always was. The fragment grows one step at a time until the
 * whole group differs, which is what makes `a/config.json` and `b/config.json`
 * read as `a` and `b` rather than as two full paths.
 *
 * Every source is treated as a path here — a URL's host is its first segment,
 * an archive's own name is a segment above the entries inside it. That means
 * one rule covers four kinds of source, and it widens correctly in each: two
 * entries in different archives fall back to the archive names, two in the
 * same archive are told apart by the folder inside it.
 */
export function disambiguate(tabs: readonly TabLike[]): Map<number, string> {
  const hints = new Map<number, string>();
  const byTitle = new Map<string, TabLike[]>();
  for (const tab of tabs) {
    const group = byTitle.get(tab.title);
    if (group) group.push(tab);
    else byTitle.set(tab.title, [tab]);
  }

  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const parents = group.map((tab) => above(tab.source));
    const deepest = Math.max(...parents.map((path) => path.length));

    // The first depth at which no two of them read the same. Widening past
    // the point where they differ would say more than the reader asked.
    let depth = 1;
    for (; depth < deepest; depth += 1) {
      const shown = parents.map((path) => join(path, depth));
      if (new Set(shown).size === shown.length) break;
    }

    group.forEach((tab, at) => {
      const hint = join(parents[at], depth);
      // Pasted text has no path, so there is nothing to distinguish it by.
      // Better silent than a `#2` that means nothing to anyone.
      if (hint) hints.set(tab.id, hint);
    });
  }
  return hints;
}

/** The last `depth` segments of a path, still in the order a path is read. */
function join(path: readonly string[], depth: number): string {
  return path.slice(Math.max(0, path.length - depth)).join("/");
}

/** Everything above a source's own name, outermost first. */
function above(source: DocSource): string[] {
  return whole(source).slice(0, -1);
}

/**
 * A source as one path, its own name last.
 *
 * The way in, flattened: where the archive sits, then the archive itself, then
 * each step inside it — and an entry's name can hold folders of its own. A URL
 * joins the same way with its host as the outermost segment, which is what
 * lets one rule serve every kind of source.
 *
 * Both separators, because a path arrives from the backend the way the
 * platform writes it and a tab opened on Windows is read by the same code as
 * one opened anywhere else.
 */
function whole(source: DocSource): string[] {
  switch (source.type) {
    case "file":
      return segments(source.path);
    case "url":
      return urlSegments(source.url);
    case "archiveEntry":
      return [
        ...whole(source.root),
        ...source.entries.flatMap((entry) => segments(entry.name)),
      ];
    case "text":
      return [];
  }
}

function segments(path: string): string[] {
  return path.split(/[/\\]/).filter((part) => part.length > 0);
}

/**
 * A URL as host-then-path, so the host is simply its outermost folder.
 *
 * Anything unparseable is read as a plain path rather than thrown away — a
 * tab exists for it either way, and half a hint beats none.
 */
function urlSegments(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [parsed.host, ...segments(parsed.pathname)];
  } catch {
    return segments(url);
  }
}
