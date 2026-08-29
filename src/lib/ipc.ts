/**
 * Typed wrappers over the Rust commands and events.
 *
 * Every shape here mirrors a `#[serde(rename_all = "camelCase")]` struct in
 * `src-tauri/src`. Keeping the mapping in one file means a backend rename
 * breaks the build in exactly one place.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { n, t, type MessageKey } from "./i18n";

export type DocKind = "markdown" | "json" | "yaml" | "toml" | "xml" | "csv" | "tsv" | "text";

/**
 * How a document is read. Seven formats, three views — routing on the view is
 * what keeps the app from growing a branch per format.
 */
export type DocView = "prose" | "tree" | "table";

/** Menu order for the format switcher. `label` is a message key, not text. */
export const DOC_KINDS: { kind: DocKind; label: MessageKey }[] = [
  { kind: "markdown", label: "format.markdown" },
  { kind: "json", label: "format.json" },
  { kind: "yaml", label: "format.yaml" },
  { kind: "toml", label: "format.toml" },
  { kind: "xml", label: "format.xml" },
  { kind: "csv", label: "format.csv" },
  { kind: "tsv", label: "format.tsv" },
  { kind: "text", label: "format.text" },
];

export function viewOf(kind: DocKind): DocView {
  switch (kind) {
    case "markdown":
      return "prose";
    case "csv":
    case "tsv":
    case "text":
      return "table";
    default:
      return "tree";
  }
}

export function kindLabel(kind: DocKind): string {
  const entry = DOC_KINDS.find((candidate) => candidate.kind === kind);
  return entry ? t(entry.label) : kind;
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
  text: "TXT",
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

/** Shaped like `BackendError`: a code and its parameters, translated here. */
export interface DecodeWarning {
  code: string;
  params?: Record<string, unknown>;
}

export interface EncodingInfo {
  /** Canonical name, and what the picker sends back. */
  name: string;
  label: string;
  source: EncodingSource;
  /** Set when something did not decode cleanly. */
  warning: DecodeWarning | null;
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
export type NodeKind =
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

export const XML_KINDS: readonly NodeKind[] = [
  "element",
  "elementText",
  "attribute",
  "text",
  "comment",
  "cdata",
  "directive",
];

export interface TreeRow {
  id: number;
  depth: number;
  key: string | null;
  index: number | null;
  kind: NodeKind;
  value: string | null;
  truncated: boolean;
  childCount: number;
  container: boolean;
  collapsed: boolean;
}

export interface TreeStats {
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
  targetKind: NodeKind;
  total: number;
  start: number;
  rows: TreeRow[];
}

export interface RevealResult {
  row: number | null;
  stats: TreeStats;
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
  /** Which search this is; echoed on every event it produces. */
  seq: number;
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
  /** A code the `delimiter.*` messages translate, e.g. "comma" or "lines". */
  delimiter: string;
  /** False for text, where there is no first row to promote to names. */
  headerPossible: boolean;
  /**
   * The columns a recognised log splits into, or null when it is not one.
   *
   * The structural fields are labels the interface translates; a logfmt key is
   * the file's own word. One list of strings could not tell those apart, so
   * the layout comes through as it is.
   */
  logLayout: LogField[] | null;
  /** True while a recognised log is being shown as one column instead. */
  plain: boolean;
  /** Whether the log has trailing `key=value` pairs worth their own columns. */
  expandable: boolean;
  /** True while those columns are being shown. */
  expanded: boolean;
  hasHeader: boolean;
  truncated: boolean;
}

export interface TableShape {
  stats: TableStats;
  header: string[];
}

/**
 * One column of a recognised log. Unit variants arrive as strings, the two
 * that carry a value as an object — serde's default for an enum.
 */
export type LogField =
  | "timestamp"
  | "level"
  | "message"
  | { bracketed: number }
  | { key: string };

/** What a log column is called, translated where it is a label and not data. */
export function logFieldName(field: LogField, index: number): string {
  if (field === "timestamp") return t("log.timestamp");
  if (field === "level") return t("log.level");
  if (field === "message") return t("log.message");
  if ("key" in field) return field.key;
  return index === 0 ? t("log.field") : t("log.field.n", { n: n(index + 1) });
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
/** What a window was asked to open, from the command line or a second launch. */
export interface LaunchRequest {
  files: string[];
  urls: string[];
}

export const setDocEncoding = (docId: number, encodingName: string) =>
  invoke<DocMeta>("set_doc_encoding", { docId, encodingName });
export const startupRequest = () => invoke<LaunchRequest>("startup_request");

/** What a detached key/value window is looking at. */
export interface PanelInfo {
  title: string;
  path: string;
}

export const openPanel = (docId: number, nodeId: number) =>
  invoke<void>("open_panel", { docId, nodeId });
export const panelInfo = (docId: number, nodeId: number) =>
  invoke<PanelInfo>("panel_info", { docId, nodeId });

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

export const treeOpen = (docId: number) => invoke<void>("tree_open", { docId });
export const treeRows = (docId: number, start: number, count: number) =>
  invoke<TreeRow[]>("tree_rows", { docId, start, count });
export const treeToggle = (docId: number, nodeId: number) =>
  invoke<TreeStats>("tree_toggle", { docId, nodeId });
export const treeExpandAll = (docId: number) => invoke<TreeStats>("tree_expand_all", { docId });
export const treeCollapseAll = (docId: number) => invoke<TreeStats>("tree_collapse_all", { docId });
export const treeSetExpandDepth = (docId: number, depth: number) =>
  invoke<TreeStats>("tree_set_expand_depth", { docId, depth });
export const treeChildren = (docId: number, nodeId: number, start: number, count: number) =>
  invoke<ChildrenPage | null>("tree_children", { docId, nodeId, start, count });
export const treeRowOf = (docId: number, nodeId: number) =>
  invoke<number | null>("tree_row_of", { docId, nodeId });
export const treeReveal = (docId: number, nodeId: number) =>
  invoke<RevealResult>("tree_reveal", { docId, nodeId });
export const treePath = (docId: number, nodeId: number) =>
  invoke<string>("tree_path", { docId, nodeId });
export const treeNodeText = (docId: number, nodeId: number) =>
  invoke<NodeText>("tree_node_text", { docId, nodeId });
export const treeSearch = (docId: number, options: SearchOptions) =>
  invoke<void>("tree_search", { docId, options });
export const treeSearchCancel = (docId: number) => invoke<void>("tree_search_cancel", { docId });
export const treeFilterMatches = (docId: number) =>
  invoke<TreeStats>("tree_filter_matches", { docId });
export const treeClearFilter = (docId: number) => invoke<TreeStats>("tree_clear_filter", { docId });
export const treeClearSearch = (docId: number) => invoke<TreeStats>("tree_clear_search", { docId });
export const treeHitRow = (docId: number, ordinal: number) =>
  invoke<RevealResult>("tree_hit_row", { docId, ordinal });

// --- CSV and TSV ----------------------------------------------------------

export const tableOpen = (docId: number) => invoke<void>("table_open", { docId });
export const tableRows = (docId: number, start: number, count: number) =>
  invoke<TablePage>("table_rows", { docId, start, count });
export const tableSetExpand = (docId: number, expand: boolean) =>
  invoke<TableShape>("table_set_expand", { docId, expand });
export const tableSetPlain = (docId: number, plain: boolean) =>
  invoke<TableShape>("table_set_plain", { docId, plain });
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
  stats: TreeStats;
  elapsedMs: number;
}

export interface DocErrorEvent {
  docId: number;
  message: string;
}

export interface SearchBatch {
  docId: number;
  seq: number;
  hits: SearchHit[];
  total: number;
}

export interface SearchDone {
  docId: number;
  seq: number;
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
  "tree:progress": IndexProgress;
  "tree:ready": IndexReady;
  "tree:error": DocErrorEvent;
  "tree:search-batch": SearchBatch;
  "tree:search-done": SearchDone;
  "tree:search-error": DocErrorEvent;
  "table:progress": IndexProgress;
  "table:ready": TableReady;
  "table:error": DocErrorEvent;
  /** A second `dviewer` handed its arguments to this window. */
  "open-request": LaunchRequest;
};

export function on<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventMap[K]>(name, (event) => handler(event.payload));
}

/**
 * A failure from Rust: a code and the values that fill its message in. The
 * sentence is built here, in the reader's language — see `src/lib/i18n/`.
 */
export interface BackendError {
  code: string;
  params?: Record<string, unknown>;
}

function isBackendError(err: unknown): err is BackendError {
  return typeof err === "object" && err !== null && typeof (err as BackendError).code === "string";
}

/**
 * Two parameters are themselves codes — `subject` says what the failure is
 * about, `reason` says what the JSON scanner tripped on — so they are
 * translated before being interpolated into the sentence around them.
 */
function readable(params: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name === "subject") out[name] = t(`subject.${value}` as MessageKey);
    else if (name === "reason") out[name] = t(`syntax.${value}` as MessageKey);
    else out[name] = value as string | number;
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (isBackendError(err)) return t(`error.${err.code}` as MessageKey, readable(err.params));
  // A plain Error is ours — a bridge failure, or something thrown in a view.
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return t("error.unknown", { detail: String(err) });
}

/** The same treatment for a decode warning, which is shaped like an error. */
export function warningMessage(warning: DecodeWarning): string {
  return t(`warning.${warning.code}` as MessageKey, readable(warning.params));
}
