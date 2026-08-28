import { errorMessage, systemFonts, type FontFamily } from "../ipc";
import { getValue, setValue } from "../persist";

export type ThemeMode = "auto" | "light" | "dark";

export const UI_SCALE_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const DEFAULTS = {
  theme: "auto" as ThemeMode,
  uiScale: 1,
  uiFontPx: 13,
  docFontPx: 15,
  fontBody: "",
  fontBodyFallback: "",
  fontCode: "",
  fontCodeFallback: "",
  inspectorWidth: 320,
  inspectorKeyRatio: 0.4,
};

type Persisted = typeof DEFAULTS;

const STORE_KEY = "settings";

/** Global display settings: theme, sizing, fonts. */
class Settings {
  theme = $state<ThemeMode>(DEFAULTS.theme);
  /** Zooms the whole interface, spacing included. */
  uiScale = $state(DEFAULTS.uiScale);
  /** Text size of the interface chrome only, independent of the scale. */
  uiFontPx = $state(DEFAULTS.uiFontPx);
  /** Text size of document content: rendered markdown and JSON rows. */
  docFontPx = $state(DEFAULTS.docFontPx);

  /** Empty string means "use the stylesheet default". */
  fontBody = $state(DEFAULTS.fontBody);
  fontCode = $state(DEFAULTS.fontCode);
  /**
   * Picked up for glyphs the primary family has no coverage for — a Latin-only
   * display face still needs something to render Korean with.
   */
  fontBodyFallback = $state(DEFAULTS.fontBodyFallback);
  fontCodeFallback = $state(DEFAULTS.fontCodeFallback);

  /** Width of the JSON key/value panel, in pixels. */
  inspectorWidth = $state(DEFAULTS.inspectorWidth);
  /** Share of that panel given to the key column, 0–1. */
  inspectorKeyRatio = $state(DEFAULTS.inspectorKeyRatio);

  /** OS colour preference, kept live by watchSystemTheme(). */
  systemDark = $state(false);

  /** Installed families, loaded once on demand. */
  fonts = $state<FontFamily[]>([]);
  fontsLoading = $state(false);
  fontsError = $state<string | null>(null);

  get resolvedTheme(): "light" | "dark" {
    if (this.theme === "auto") return this.systemDark ? "dark" : "light";
    return this.theme;
  }

  async load() {
    const saved = await getValue<Partial<Persisted>>(STORE_KEY);
    if (!saved) return;

    if (saved.theme === "auto" || saved.theme === "light" || saved.theme === "dark") {
      this.theme = saved.theme;
    }
    if (typeof saved.uiScale === "number") this.uiScale = clampScale(saved.uiScale);
    if (typeof saved.uiFontPx === "number") this.uiFontPx = clamp(saved.uiFontPx, 10, 22);
    if (typeof saved.docFontPx === "number") this.docFontPx = clamp(saved.docFontPx, 10, 32);
    if (typeof saved.inspectorWidth === "number") {
      this.inspectorWidth = clamp(saved.inspectorWidth, 200, 900);
    }
    if (typeof saved.inspectorKeyRatio === "number") {
      this.inspectorKeyRatio = clamp(saved.inspectorKeyRatio, 0.15, 0.75);
    }
    for (const key of ["fontBody", "fontBodyFallback", "fontCode", "fontCodeFallback"] as const) {
      if (typeof saved[key] === "string") this[key] = saved[key];
    }
  }

  save() {
    void setValue(STORE_KEY, {
      theme: this.theme,
      uiScale: this.uiScale,
      uiFontPx: this.uiFontPx,
      docFontPx: this.docFontPx,
      fontBody: this.fontBody,
      fontBodyFallback: this.fontBodyFallback,
      fontCode: this.fontCode,
      fontCodeFallback: this.fontCodeFallback,
      inspectorWidth: this.inspectorWidth,
      inspectorKeyRatio: this.inspectorKeyRatio,
    } satisfies Persisted);
  }

  reset() {
    Object.assign(this, DEFAULTS);
    this.save();
  }

  /** Step the interface scale one notch; direction is +1 or -1. */
  stepScale(direction: 1 | -1) {
    const current = nearestScaleStep(this.uiScale);
    const next = UI_SCALE_STEPS[UI_SCALE_STEPS.indexOf(current) + direction];
    if (next !== undefined) {
      this.uiScale = next;
      this.save();
    }
  }

  /** Scanning the system font directories is slow, so it waits for a reader. */
  async loadFonts() {
    if (this.fonts.length > 0 || this.fontsLoading) return;
    this.fontsLoading = true;
    this.fontsError = null;
    try {
      this.fonts = await systemFonts();
    } catch (err) {
      this.fontsError = errorMessage(err);
    } finally {
      this.fontsLoading = false;
    }
  }
}

/** Snap an arbitrary scale onto the nearest notch, for the slider and Ctrl+/-. */
export function nearestScaleStep(value: number): number {
  return UI_SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function clampScale(n: number) {
  return clamp(n, UI_SCALE_STEPS[0], UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]);
}

export const settings = new Settings();

/** Push the current settings onto the document. Called from an effect in App. */
export function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.resolvedTheme;
  root.style.setProperty("--ui-scale", String(settings.uiScale));
  root.style.setProperty("--ui-font-px", `${settings.uiFontPx}px`);
  root.style.setProperty("--doc-font-px", `${settings.docFontPx}px`);
  setFont(root, "--font-body", settings.fontBody, settings.fontBodyFallback, "var(--font-ui)");
  setFont(root, "--font-code", settings.fontCode, settings.fontCodeFallback, "monospace");
}

/**
 * Build a font stack: the chosen family first, then the user's fallback, then
 * the stylesheet default. A browser walks the stack per *glyph*, so a family
 * with no Hangul coverage simply hands those characters to the next entry.
 */
export function fontStack(primary: string, fallback: string, tail: string): string {
  const families = [primary, fallback]
    .map((name) => name.trim())
    .filter(Boolean)
    .map(quoteFamily);
  return [...families, tail].join(", ");
}

function setFont(
  root: HTMLElement,
  prop: string,
  primary: string,
  fallback: string,
  tail: string,
) {
  if (!primary.trim() && !fallback.trim()) {
    root.style.removeProperty(prop);
    return;
  }
  root.style.setProperty(prop, fontStack(primary, fallback, tail));
}

function quoteFamily(name: string) {
  return /^[\w-]+$/.test(name) ? name : `"${name.replace(/"/g, "")}"`;
}

/** Subscribe to the OS colour scheme; returns a cleanup function. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  settings.systemDark = mq.matches;
  const onChange = (e: MediaQueryListEvent) => (settings.systemDark = e.matches);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
