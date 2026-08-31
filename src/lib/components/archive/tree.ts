/**
 * An archive's entry names, as a tree.
 *
 * A zip has no directory structure of its own — it is a flat list of entries
 * whose names happen to contain slashes. Every tool that shows one nonetheless
 * shows a tree, because that is what whoever packed it was looking at, and a
 * thousand rows with `src/lib/components/` repeated down the left edge is a
 * list nobody can read.
 *
 * So the shape is derived from the names once, and flattened into rows on every
 * change of what is open or filtered. Keeping those two apart is what makes
 * filtering cheap: the tree is built from a hundred thousand names one time,
 * and a keystroke only walks it.
 */
import type { ArchiveEntry } from "../../ipc";

/** A directory, or a document. Directories are the ones with children. */
export interface TreeNode {
  /** The last segment — what the row shows. */
  label: string;
  /** The whole path, which is what an open or closed state is keyed on. */
  path: string;
  /**
   * Null for a directory. A zip's directories are inferred from the names, and
   * the zero-byte entry that sometimes declares one carries nothing to open.
   */
  entry: ArchiveEntry | null;
  children: TreeNode[];
  /** Documents at or below this node, for what a folder row says it holds. */
  count: number;
}

/** One line of the list, with the depth it is drawn at. */
export interface Row {
  node: TreeNode;
  depth: number;
  /** Directories only: whether this row's children are drawn below it. */
  open: boolean;
}

/** Reused, because building one per comparison is what makes sorting slow. */
const ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Build the tree from the entry names.
 *
 * Ordered by name rather than by position in the central directory. An
 * archive's own order is an artefact of whatever wrote it — often the order
 * files were visited on a disk — and a reader looking for one name among a
 * thousand is helped by neither that nor by grouping alone.
 */
export function buildTree(entries: ArchiveEntry[]): TreeNode {
  const root: TreeNode = { label: "", path: "", entry: null, children: [], count: 0 };
  // Directories are looked up far more often than they are made, so they are
  // indexed by path rather than searched for among their siblings.
  const directories = new Map<string, TreeNode>([["", root]]);

  for (const entry of entries) {
    const segments = entry.name.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;

    let parent = root;
    for (let at = 0; at < segments.length - 1; at += 1) {
      const path = segments.slice(0, at + 1).join("/");
      let directory = directories.get(path);
      if (!directory) {
        directory = { label: segments[at], path, entry: null, children: [], count: 0 };
        directories.set(path, directory);
        parent.children.push(directory);
      }
      parent = directory;
    }
    parent.children.push({
      label: segments[segments.length - 1],
      path: entry.name,
      entry,
      children: [],
      count: 1,
    });
  }

  tally(root);
  return root;
}

/** Count what each directory holds, and put its children in reading order. */
function tally(node: TreeNode): number {
  if (node.entry) return 1;
  node.children.sort(compare);
  node.count = node.children.reduce((total, child) => total + tally(child), 0);
  return node.count;
}

/** Directories first, then names, so a folder is never lost among its files. */
function compare(a: TreeNode, b: TreeNode): number {
  const aIsDirectory = a.entry === null;
  if (aIsDirectory !== (b.entry === null)) return aIsDirectory ? -1 : 1;
  return ORDER.compare(a.label, b.label);
}

/**
 * The rows to draw.
 *
 * `closed` holds the directories the reader has collapsed, so the default is
 * open: an archive is opened to see what is in it, and a list that starts shut
 * answers a question nobody asked.
 *
 * A filter overrides that. A directory with a match inside it is drawn open
 * however it was left, because a match behind a closed folder is a match the
 * reader was not shown.
 */
export function flatten(root: TreeNode, closed: Set<string>, filter: string): Row[] {
  const needle = filter.trim().toLowerCase();
  // A directory's path is a prefix of everything under it, so a file below a
  // matching directory matches on its own path too. That is why only the files
  // are tested, and the directories simply follow.
  const shown = needle === "" ? null : showing(root, needle, new Set<TreeNode>());
  const rows: Row[] = [];

  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      if (shown && !shown.has(child)) continue;
      if (child.entry) {
        rows.push({ node: child, depth, open: false });
        continue;
      }
      const open = needle !== "" || !closed.has(child.path);
      rows.push({ node: child, depth, open });
      if (open) walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/**
 * Every node to draw for `needle`, in one pass over the tree.
 *
 * Computed as a set rather than asked per row, because asking would walk each
 * subtree once for every directory above it — which on a deep archive turns a
 * keystroke into quadratic work.
 */
function showing(node: TreeNode, needle: string, into: Set<TreeNode>): Set<TreeNode> {
  for (const child of node.children) {
    if (child.entry) {
      if (child.path.toLowerCase().includes(needle)) into.add(child);
      continue;
    }
    const before = into.size;
    showing(child, needle, into);
    if (into.size > before) into.add(child);
  }
  return into;
}
