/**
 * Typed wrappers over the Rust commands and events.
 *
 * Every shape here mirrors a `#[serde(rename_all = "camelCase")]` struct in
 * `src-tauri/src`. Keeping the mapping in one file means a backend rename
 * breaks the build in exactly one place.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type DocKind = "markdown" | "json" | "yaml" | "toml" | "xml" | "csv" | "tsv";

/**
 * How a document is read. Seven formats, three views — routing on the view is
 * what keeps the app from growing a branch per format.
 */
export type DocView = "prose" | "tree" | "table";

/** Menu order and labels for the format switcher, in one place. */
export const DOC_KINDS: { kind: DocKind; label: string }[] = [
  { kind: "markdown", label: "마크다운" },
  { kind: "json", label: "JSON" },
  { kind: "yaml", label: "YAML" },
  { kind: "toml", label: "TOML" },
  { kind: "xml", label: "XML" },
  { kind: "csv", label: "CSV" },
  { kind: "tsv", label: "TSV" },
];

export function viewOf(kind: DocKind): DocView {
  switch (kind) {
    case "markdown":
      return "prose";
    case "csv":
    case "tsv":
      return "table";
    default:
      return "tree";
  }
}

export function kindLabel(kind: DocKind): string {
  return DOC_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
}

/**
 * A short mark per format, for the tab strip and the recent list. Shared so the
 * same file cannot appear with two different badges depending on where it is
 * listed.
 */
const BADGES: Record<DocKind, string> = {
  markdown: "M↓",
  json: "{ }",
  yaml: "Y",
  toml: "T",
  xml: "< >",
  csv: "CSV",
  tsv: "TSV",
};

export function kindBadge(kind: DocKind): string {
  return BADGES[kind] ?? "?";
}

export type DocSource =
  | { type: "file"; path: string }
  | { type: "url"; url: string }
  | { type: "text" };

/** How the encoding in effect was arrived at. Only `guessed` can be wrong. */
export type EncodingSource = "bom" | "utf8" | "guessed" | "chosen";

export interface EncodingInfo {
  /** Canonical name, and what the picker sends back. */
  name: string;
  label: string;
  source: EncodingSource;
  /** Set when something did not decode cleanly. */
  warning: string | null;
}

export interface DocMeta {
  id: number;
  title: string;
  kind: DocKind;
  view: DocView;
  source: DocSource;
  /** Size on disk, not after decoding. */
  byteLen: number;
  encoding: EncodingInfo;
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

/**
 * A node's kind. The first six are JSON's; the rest come from XML, which is
 * scanned into the same tree rather than converted, so a node says what its
 * own format called it.
 */
export type JsonKind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "bool"
  | "null"
  | "element"
  | "elementText"
  | "attribute"
  | "text"
  | "comment"
  | "cdata"
  | "directive";

export const XML_KINDS: readonly JsonKind[] = [
  "element",
  "elementText",
  "attribute",
  "text",
  "comment",
  "cdata",
  "directive",
];

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

export interface TableCell {
  /** Already escaped to a single line and capped, like a tree row's value. */
  text: string;
  truncated: boolean;
}

export interface TableRow {
  index: number;
  cells: TableCell[];
}

export interface TablePage {
  start: number;
  rows: TableRow[];
}

export interface TableStats {
  rowCount: number;
  columnCount: number;
  byteLen: number;
  indexBytes: number;
  /** The delimiter as a display name, e.g. "쉼표". */
  delimiter: string;
  hasHeader: boolean;
  truncated: boolean;
}

export interface TableShape {
  stats: TableStats;
  header: string[];
}

export interface TableHit {
  row: number;
  column: number;
}

export interface TableSearchResult {
  hits: TableHit[];
  capped: boolean;
}

export interface CellText {
  text: string;
  truncated: boolean;
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
export const setDocEncoding = (docId: number, encodingName: string) =>
  invoke<DocMeta>("set_doc_encoding", { docId, encodingName });
export const startupPaths = () => invoke<string[]>("startup_paths");

/**
 * The encodings the picker offers, as `[name, label]`. The list lives in Rust
 * so the names it sends back are always ones the decoder knows; it never
 * changes, so it is fetched once.
 */
let encodingChoicesCache: Promise<[string, string][]> | null = null;
export function encodingChoices(): Promise<[string, string][]> {
  encodingChoicesCache ??= invoke<[string, string][]>("encoding_choices");
  return encodingChoicesCache;
}

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

// --- CSV and TSV ----------------------------------------------------------

export const tableOpen = (docId: number) => invoke<void>("table_open", { docId });
export const tableRows = (docId: number, start: number, count: number) =>
  invoke<TablePage>("table_rows", { docId, start, count });
export const tableSetHasHeader = (docId: number, hasHeader: boolean) =>
  invoke<TableShape>("table_set_has_header", { docId, hasHeader });
export const tableCellText = (docId: number, row: number, column: number) =>
  invoke<CellText>("table_cell_text", { docId, row, column });
export const tableRowText = (docId: number, row: number) =>
  invoke<CellText>("table_row_text", { docId, row });
export const tableSearch = (docId: number, query: string, caseSensitive: boolean) =>
  invoke<TableSearchResult>("table_search", { docId, query, caseSensitive });

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

export interface TableReady {
  docId: number;
  stats: TableStats;
  header: string[];
  elapsedMs: number;
}

type EventMap = {
  "json:progress": IndexProgress;
  "json:ready": IndexReady;
  "json:error": DocErrorEvent;
  "json:search-batch": SearchBatch;
  "json:search-done": SearchDone;
  "json:search-error": DocErrorEvent;
  "table:progress": IndexProgress;
  "table:ready": TableReady;
  "table:error": DocErrorEvent;
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
