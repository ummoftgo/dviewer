import { open } from "@tauri-apps/plugin-dialog";
import { workspace } from "./state/docs.svelte";

const FILTERS = [
  { name: "문서", extensions: ["md", "markdown", "mdx", "txt", "json", "jsonl", "ndjson"] },
  { name: "모든 파일", extensions: ["*"] },
];

/** Show the system file picker and open everything the user selected. */
export async function pickFiles(): Promise<void> {
  const picked = await open({ multiple: true, filters: FILTERS });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) {
    await workspace.openPath(path);
  }
}
