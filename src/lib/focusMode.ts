/** A view that consumed Escape keeps ownership of that press. */
export function nextFocusMode(current: boolean, key: string, handled = false): boolean {
  if (handled) return current;
  if (key === 'F11') return !current;
  if (key === 'Escape') return false;
  return current;
}
