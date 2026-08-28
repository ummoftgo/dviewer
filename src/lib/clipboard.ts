/**
 * Clipboard writes with a fallback.
 *
 * `navigator.clipboard` needs a secure context and a focused document; inside a
 * webview those conditions are usually met but not guaranteed, and silently
 * losing a copy is worse than the old textarea trick.
 */
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
    if (!document.execCommand("copy")) throw new Error("복사할 수 없습니다.");
  } finally {
    scratch.remove();
  }
}
