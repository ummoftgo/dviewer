/**
 * Typed wrappers over the Rust commands and events.
 *
 * Every shape here mirrors a `#[serde(rename_all = "camelCase")]` struct in
 * `src-tauri/src`. Keeping the mapping in one file means a backend rename
 * breaks the build in exactly one place.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type DocKind = "markdown" | "json";

export type DocSource =
  | { type: "file"; path: string }
  | { type: "url"; url: string }
  | { type: "text" };

export interface DocMeta {
  id: number;
  title: string;
  kind: DocKind;
  source: DocSource;
  byteLen: number;
  baseDir: string | null;
}

export interface TocEntry {
  level: number;
  text: string;
  id: string;
}

export interface RenderedMarkdown {
  html: string;
  toc: TocEntry[];
}

export interface HighlightCss {
  light: string;
  dark: string;
}

export type JsonKind = "object" | "array" | "string" | "number" | "bool" | "null";

export interface JsonRow {
  id: number;
  depth: number;
  key: string | null;
  index: number | null;
  kind: JsonKind;
  value: string | null;
  truncated: boolean;
  childCount: number;
  container: boolean;
  collapsed: boolean;
}

export interface JsonStats {
  nodeCount: number;
  maxDepth: number;
  visibleRows: number;
  byteLen: number;
  /** Memory the flat node index occupies — can reach a gigabyte on huge files. */
  indexBytes: number;
  syntheticRoot: boolean;
  filtered: boolean;
}

/** One node's direct children, for the key/value table beside the tree. */
export interface ChildrenPage {
  /** Not always the node asked about — selecting a scalar shows its parent. */
  target: number;
  targetPath: string;
  targetKind: JsonKind;
  total: number;
  start: number;
  rows: JsonRow[];
}

export interface RevealResult {
  row: number | null;
  stats: JsonStats;
}

export interface NodeText {
  text: string;
  truncated: boolean;
  path: string;
}

export type SearchScope = "all" | "keys" | "values" | "paths";
/** Which part of a node a hit landed in. Path hits belong to neither key nor value. */
export type SearchField = "key" | "value" | "path";

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  scope: SearchScope;
}

export interface SearchHit {
  node: number;
  offset: number;
  field: SearchField;
}

export interface FontFamily {
  name: string;
  monospace: boolean;
}

export interface SearchSummary {
  total: number;
  capped: boolean;
}

// --- documents ------------------------------------------------------------

export const openPath = (path: string) => invoke<DocMeta>("open_path", { path });
export const openUrl = (url: string) => invoke<DocMeta>("open_url", { url });
export const openText = (content: string, title?: string, kind?: DocKind) =>
  invoke<DocMeta>("open_text", { content, title, kind });
export const closeDoc = (docId: number) => invoke<void>("close_doc", { docId });
export const setDocKind = (docId: number, kind: DocKind) =>
  invoke<DocMeta>("set_doc_kind", { docId, kind });
export const startupPaths = () => invoke<string[]>("startup_paths");

// --- markdown -------------------------------------------------------------

export const docSourceText = (docId: number) => invoke<string>("doc_source_text", { docId });
export const renderMarkdown = (docId: number) =>
  invoke<RenderedMarkdown>("render_markdown", { docId });
export const highlightCss = () => invoke<HighlightCss>("highlight_css");
export const systemFonts = () => invoke<FontFamily[]>("system_fonts");

// --- JSON -----------------------------------------------------------------

export const jsonOpen = (docId: number) => invoke<void>("json_open", { docId });
export const jsonRows = (docId: number, start: number, count: number) =>
  invoke<JsonRow[]>("json_rows", { docId, start, count });
export const jsonToggle = (docId: number, nodeId: number) =>
  invoke<JsonStats>("json_toggle", { docId, nodeId });
export const jsonExpandAll = (docId: number) => invoke<JsonStats>("json_expand_all", { docId });
export const jsonCollapseAll = (docId: number) => invoke<JsonStats>("json_collapse_all", { docId });
export const jsonSetExpandDepth = (docId: number, depth: number) =>
  invoke<JsonStats>("json_set_expand_depth", { docId, depth });
export const jsonChildren = (docId: number, nodeId: number, start: number, count: number) =>
  invoke<ChildrenPage | null>("json_children", { docId, nodeId, start, count });
export const jsonReveal = (docId: number, nodeId: number) =>
  invoke<RevealResult>("json_reveal", { docId, nodeId });
export const jsonPath = (docId: number, nodeId: number) =>
  invoke<string>("json_path", { docId, nodeId });
export const jsonNodeText = (docId: number, nodeId: number) =>
  invoke<NodeText>("json_node_text", { docId, nodeId });
export const jsonSearch = (docId: number, options: SearchOptions) =>
  invoke<void>("json_search", { docId, options });
export const jsonSearchCancel = (docId: number) => invoke<void>("json_search_cancel", { docId });
export const jsonFilterMatches = (docId: number) =>
  invoke<JsonStats>("json_filter_matches", { docId });
export const jsonClearFilter = (docId: number) => invoke<JsonStats>("json_clear_filter", { docId });
export const jsonClearSearch = (docId: number) => invoke<JsonStats>("json_clear_search", { docId });
export const jsonHitRow = (docId: number, ordinal: number) =>
  invoke<RevealResult>("json_hit_row", { docId, ordinal });

// --- events ---------------------------------------------------------------

export interface IndexProgress {
  docId: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface IndexReady {
  docId: number;
  stats: JsonStats;
  elapsedMs: number;
}

export interface DocErrorEvent {
  docId: number;
  message: string;
}

export interface SearchBatch {
  docId: number;
  hits: SearchHit[];
  total: number;
}

export interface SearchDone {
  docId: number;
  summary: SearchSummary;
  elapsedMs: number;
}

type EventMap = {
  "json:progress": IndexProgress;
  "json:ready": IndexReady;
  "json:error": DocErrorEvent;
  "json:search-batch": SearchBatch;
  "json:search-done": SearchDone;
  "json:search-error": DocErrorEvent;
};

export function on<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventMap[K]>(name, (event) => handler(event.payload));
}

/** Backend errors arrive as plain strings; anything else is a bug in the bridge. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
