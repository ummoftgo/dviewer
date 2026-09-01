/**
 * The one line that stops every shortcut breaking at once.
 *
 * `KeyboardEvent.key` carries the character that would be typed, so CapsLock
 * turns Ctrl+O into `"O"`. Every shortcut compared against a lowercase literal
 * then stops working simultaneously, with nothing on screen to say why.
 */
import { describe, expect, test } from "vitest";
import { shortcutKey } from "./keys";

/** Only `.key` is read, so this is the whole event as far as the function is
 *  concerned — and building a real one would need a DOM. */
const pressing = (key: string) => shortcutKey({ key } as KeyboardEvent);

describe("folding what the reader typed back to what they pressed", () => {
  test("CapsLock and Shift do not change which shortcut it is", () => {
    expect(pressing("O")).toBe("o");
    expect(pressing("o")).toBe("o");
    expect(pressing("F")).toBe("f");
  });

  /**
   * Named keys are already canonical, and lowercasing them would turn a
   * comparison against `"Tab"` into one that never matches — the same
   * silent, total failure in the other direction.
   */
  test("named keys are left exactly as they are", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "Enter", "Home", "PageUp", "F3"]) {
      expect(pressing(key)).toBe(key);
    }
  });

  test("a single non-Latin character is still a single character", () => {
    expect(pressing("ㅇ")).toBe("ㅇ");
    expect(pressing(" ")).toBe(" ");
  });
});
