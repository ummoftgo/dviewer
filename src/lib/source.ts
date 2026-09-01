/**
 * What a document's source says, and when two of them say the same thing.
 *
 * Separate from the tab state because none of this is state: a source is a
 * value the backend sent, and these are three questions asked of it.
 *
 * Separate from the tab state for a second reason too: all three fail quietly.
 * A wrong answer here throws nothing and looks like nothing — it just opens one
 * more copy of what is already on screen. `source.test.ts` is where that is
 * held down.
 */
import type { ArchiveEntry, DocSource } from "./ipc";

/**
 * Whether two sources name the same document.
 *
 * Structural, because a source is a value and holds no id: two chains are the
 * same when they start at the same place and take the same numbered steps.
 *
 * The names are deliberately not compared. They are display text, frozen when
 * the list was read, and an archive re-read under a different guess at its name
 * encoding carries different ones for the very same entries — so comparing them
 * would quietly stop recognising a tab that is already open.
 */
export function sameSource(a: DocSource, b: DocSource): boolean {
  if (a.type === "file" && b.type === "file") return a.path === b.path;
  if (a.type === "url" && b.type === "url") return a.url === b.url;
  if (a.type === "archiveEntry" && b.type === "archiveEntry") {
    return (
      sameSource(a.root, b.root) &&
      a.entries.length === b.entries.length &&
      a.entries.every((step, at) => step.index === b.entries[at].index)
    );
  }
  return false;
}

/**
 * The chain naming `entry` of the document `source` belongs to.
 *
 * Mirrors `DocSource::entry` in Rust. Built on this side too so that a click on
 * a row already open can raise that tab without unpacking anything to find out.
 */
export function chainOf(source: DocSource, entry: ArchiveEntry): DocSource | null {
  const step = { index: entry.index, name: entry.name };
  if (source.type === "file" || source.type === "url") {
    return { type: "archiveEntry", root: source, entries: [step] };
  }
  if (source.type === "archiveEntry") {
    return { type: "archiveEntry", root: source.root, entries: [...source.entries, step] };
  }
  // Pasted text is a string and was never an archive.
  return null;
}

/**
 * Whether `tab` is the tab that opening `path` produces.
 *
 * The first clause is the ordinary one. The second is the transparent unwrap:
 * an archive holding a single document opens as that document, so a tab for
 * `a.zip` is not a file tab at all — it is that entry, one step in, rooted at
 * this file. Which is exactly what makes it recognisable, and without it
 * opening the same archive twice makes two tabs.
 */
export function opensAs(source: DocSource, path: string): boolean {
  if (source.type === "file") return source.path === path;
  return (
    source.type === "archiveEntry" &&
    source.entries.length === 1 &&
    source.root.type === "file" &&
    source.root.path === path
  );
}
