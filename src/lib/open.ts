import { open } from "@tauri-apps/plugin-dialog";
import { workspace } from "./state/docs.svelte";
import { t } from "./i18n";

/**
 * Grouped by view rather than by format: the reader picking a file is choosing
 * what they want to look at, not which parser will run.
 *
 * Built per call rather than once, because the names are translated and the
 * language can change while the app is open.
 */
function filters() {
  return [
    {
      name: t("files.documents"),
    extensions: [
      "md", "markdown", "mdx", "txt",
      "json", "jsonc", "jsonl", "ndjson", "geojson", "har", "ipynb",
      "yaml", "yml", "toml",
      "xml", "xhtml", "svg", "rss", "atom", "xsd", "xsl", "xslt", "plist", "kml", "gpx", "opml",
      "csv", "tsv", "tab",
    ],
  },
  { name: t("files.markdown"), extensions: ["md", "markdown", "mdown", "mkd", "mdx", "txt"] },
  { name: t("files.tree"), extensions: ["json", "jsonc", "jsonl", "ndjson", "geojson", "har", "ipynb", "yaml", "yml", "toml", "xml", "xhtml", "svg", "rss", "atom", "xsd", "xsl", "xslt", "plist", "kml", "gpx", "opml"] },
  { name: t("files.table"), extensions: ["csv", "tsv", "tab"] },
  { name: t("files.all"), extensions: ["*"] },
  ];
}

/** Show the system file picker and open everything the user selected. */
export async function pickFiles(): Promise<void> {
  const picked = await open({ multiple: true, filters: filters() });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) {
    await workspace.openPath(path);
  }
}
