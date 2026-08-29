/**
 * Translation, and the message catalogue.
 *
 * All message text lives here — including the text for failures that happened
 * in Rust. The backend sends a code and its parameters (see `ipc.ts`), never a
 * sentence, so switching language changes what is already on screen and there
 * is exactly one place to translate anything.
 *
 * `t()` reads `i18n.locale`, which is `$state`, so every call site re-runs when
 * the language changes. That is the whole reactivity story: components call
 * `t(...)` inline and Svelte does the rest.
 */
import { i18n, type Locale } from "./locale.svelte";
import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { ko, type MessageKey, type Messages } from "./messages/ko";
import { zhHans } from "./messages/zh-Hans";

export { i18n };
export type { Locale, LocaleSetting } from "./locale.svelte";

/** Menu order, and the name each language calls itself. */
export const LOCALES: { locale: Locale; label: string }[] = [
  { locale: "ko", label: "한국어" },
  { locale: "en", label: "English" },
  { locale: "ja", label: "日本語" },
  { locale: "zh-Hans", label: "简体中文" },
];

const MESSAGES: Record<Locale, Messages> = {
  ko,
  en,
  ja,
  "zh-Hans": zhHans,
};

/**
 * Pick a locale from what the system reports.
 *
 * Only the language subtag is consulted, so `ko-KR` and `ko` land in the same
 * place. Every Chinese variant maps to Simplified: Traditional is a separate
 * translation we do not have, and Simplified is closer than English.
 */
export function detectLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const language = tag.toLowerCase().split("-")[0];
    if (language === "ko") return "ko";
    if (language === "ja") return "ja";
    if (language === "zh") return "zh-Hans";
    if (language === "en") return "en";
  }
  return "en";
}

/** Start following the system language. Called once, at startup. */
export function detectSystemLocale() {
  i18n.system = detectLocale(navigator.languages ?? [navigator.language]);
}

export function localeLabel(locale: Locale): string {
  return LOCALES.find((entry) => entry.locale === locale)?.label ?? locale;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The message for `key`, with `{name}` placeholders filled in.
 *
 * A key with no message returns the key itself rather than an empty string: a
 * visible `tree.status.nodes` is a bug report, whereas a blank space is a
 * mystery. It cannot normally happen — the dictionaries are type-checked
 * against each other — but a code from a newer backend could reach here.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const message = MESSAGES[i18n.locale][key];
  if (message === undefined) {
    console.warn("[dviewer] no message for key:", key);
    return key;
  }
  if (!params) return message;
  return message.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** A number in the reader's locale — digit grouping differs between them. */
export function n(value: number): string {
  return value.toLocaleString(i18n.locale);
}

export type { MessageKey, Messages };
