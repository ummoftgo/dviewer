/**
 * Reading a keyboard event the way a shortcut means it.
 *
 * `KeyboardEvent.key` carries the character that would be typed, so CapsLock
 * turns Ctrl+O into `"O"` and every shortcut compared against a lowercase
 * literal stops working — all of them at once, with no clue why. Shift does the
 * same for the combinations that use it.
 *
 * Only single characters are folded. Named keys (`"Tab"`, `"Escape"`,
 * `"ArrowDown"`) are already canonical, and lowercasing them would turn a
 * comparison against `"Tab"` into one that never matches.
 */
export function shortcutKey(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}
