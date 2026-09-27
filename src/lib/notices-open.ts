import { t } from "./i18n";
import { workspace } from "./state/docs.svelte";
import { toasts } from "./state/toast.svelte";

/** What scripts/notices.mjs writes into dist/, and so into the app's own assets. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";

/**
 * Open the third-party notices in a reading tab, or return to the one already
 * open. False when the build carries none — `vite dev` never runs the step.
 */
export async function openNotices(): Promise<boolean> {
  const open = workspace.tabs.find((tab) => tab.meta.title === NOTICES_FILE && tab.meta.source.type === "text");
  if (open) {
    workspace.activeId = open.id;
    return true;
  }
  try {
    const response = await fetch(`/${NOTICES_FILE}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await workspace.openText(await response.text(), NOTICES_FILE, "markdown");
    return true;
  } catch {
    toasts.show(t("about.noticesMissing"), "info");
    return false;
  }
}
