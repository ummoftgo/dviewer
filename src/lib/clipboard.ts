/**
 * Clipboard writes with a fallback.
 *
 * `navigator.clipboard` needs a secure context and a focused document; inside a
 * webview those conditions are usually met but not guaranteed, and silently
 * losing a copy is worse than the old textarea trick.
 */
import { t } from "./i18n";

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path.
  }

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  scratch.select();
  try {
    if (!document.execCommand("copy")) throw new Error(t("toast.copyFailed"));
  } finally {
    scratch.remove();
  }
}

/** Editors consume text/plain, so it must carry the same HTML source. */
export function htmlClipboardPayload(html: string): Record<string, string> {
  return { 'text/html': html, 'text/plain': html };
}

/** Both MIME types must succeed together; a plain-only fallback would lie about HTML. */
export async function copyHtml(html: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'
      || (ClipboardItem.supports && !ClipboardItem.supports('text/html'))) throw new Error(t('toast.copyFailed'));
  await navigator.clipboard.write([new ClipboardItem(Object.fromEntries(
    Object.entries(htmlClipboardPayload(html)).map(([type, text]) => [type, new Blob([text], { type })]),
  ))]);
}

/** Keep the write in the user gesture while the renderer finishes its Blob. */
export async function copyPng(blob: Promise<Blob>): Promise<void> {
  // Observe a rendering failure even when MIME support fails before the write.
  void blob.catch(() => {});
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'
      || (ClipboardItem.supports && !ClipboardItem.supports('image/png'))) throw new Error(t('toast.copyFailed'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
