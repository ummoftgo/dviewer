/**
 * The locale in effect, as reactive state.
 *
 * Separate from `index.ts` only because runes need a `.svelte.ts` file. Reading
 * `i18n.locale` from anywhere — including a plain module like `t()` — still
 * tracks it, so the split costs nothing.
 */
export type Locale = "ko" | "en" | "ja" | "zh-Hans";
/** What the setting holds: a locale, or "follow the system". */
export type LocaleSetting = Locale | "system";

class I18n {
  /** The setting, which may defer to the system. */
  setting = $state<LocaleSetting>("system");
  /** What the system says, re-read when the OS language changes. */
  system = $state<Locale>("en");

  get locale(): Locale {
    return this.setting === "system" ? this.system : this.setting;
  }
}

export const i18n = new I18n();
