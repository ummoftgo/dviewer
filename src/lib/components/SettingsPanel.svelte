<script lang="ts">
  import FontPicker from "./FontPicker.svelte";
  import Icon from "./Icon.svelte";
  import { i18n, LOCALES, localeLabel, t, type LocaleSetting, type MessageKey } from "../i18n";
  import {
    nearestScaleStep,
    settings,
    UI_SCALE_STEPS,
    type ThemeMode,
  } from "../state/settings.svelte";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  const THEMES: { value: ThemeMode; label: MessageKey; icon: "auto" | "sun" | "moon" }[] = [
    { value: "auto", label: "settings.theme.auto", icon: "auto" },
    { value: "light", label: "settings.theme.light", icon: "sun" },
    { value: "dark", label: "settings.theme.dark", icon: "moon" },
  ];

  // Latin and Hangul together, so a primary family with no Hangul coverage
  // visibly hands those glyphs to the fallback.
  /** Latin, Hangul, kana and Han together — the four scripts the interface can
 *  be shown in, so the preview covers whatever the reader chose. */
  // i18n-ignore — deliberately several scripts at once, so the preview shows
  // whether the chosen family covers whatever language the reader picked.
  const BODY_PREVIEW = "Sphinx of black quartz 다람쥐 헌 쳇바퀴 日本語 简体 0123"; // i18n-ignore
  const CODE_PREVIEW = 'const path = "$.items[0].name"; // 0O1lI 한글 日本 简体'; // i18n-ignore

  // The picker is the only place fonts are needed, so the scan waits for it.
  $effect(() => {
    void settings.loadFonts();
  });

  function setTheme(value: ThemeMode) {
    settings.theme = value;
    settings.save();
  }

  function set(key: "uiScale" | "uiFontPx" | "docFontPx", value: number) {
    settings[key] = value;
    settings.save();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose}></div>

<aside class="panel" aria-label={t("toolbar.settings")}>
  <header>
    <h2>{t("toolbar.settings")}</h2>
    <button class="icon-btn" onclick={onClose} aria-label={t("settings.close")}>
      <Icon name="close" />
    </button>
  </header>

  <div class="body">
    <section>
      <h3>{t("settings.language")}</h3>
      <select
        class="field"
        value={settings.locale}
        onchange={(e) => {
          settings.locale = e.currentTarget.value as LocaleSetting;
          settings.save();
        }}
        aria-label={t("settings.language")}
      >
        <option value="system">{t("settings.language.system")}</option>
        {#each LOCALES as entry (entry.locale)}
          <option value={entry.locale}>{entry.label}</option>
        {/each}
      </select>
      {#if settings.locale === "system"}
        <p class="hint">
          {t("settings.language.hint", { language: localeLabel(i18n.system) })}
        </p>
      {/if}
    </section>

    <section>
      <h3>{t("settings.theme")}</h3>
      <div class="segmented wide">
        {#each THEMES as theme (theme.value)}
          <button aria-pressed={settings.theme === theme.value} onclick={() => setTheme(theme.value)}>
            <Icon name={theme.icon} size={13} />
            {t(theme.label)}
          </button>
        {/each}
      </div>
      {#if settings.theme === "auto"}
        <p class="hint">
          {t("settings.theme.hint", {
            mode: settings.systemDark ? t("settings.theme.dark") : t("settings.theme.light"),
          })}
        </p>
      {/if}
    </section>

    <section>
      <h3>{t("settings.scale")} <span class="value">{Math.round(settings.uiScale * 100)}%</span></h3>
      <input
        type="range"
        min="0"
        max={UI_SCALE_STEPS.length - 1}
        step="1"
        value={UI_SCALE_STEPS.indexOf(nearestScaleStep(settings.uiScale))}
        oninput={(e) => set("uiScale", UI_SCALE_STEPS[Number(e.currentTarget.value)])}
        aria-label={t("settings.scale")}
      />
      <p class="hint">
        {t("settings.scale.hint")}
      </p>
    </section>

    <section>
      <h3>{t("settings.uiFont")} <span class="value">{settings.uiFontPx}px</span></h3>
      <input
        type="range"
        min="10"
        max="22"
        step="1"
        value={settings.uiFontPx}
        oninput={(e) => set("uiFontPx", Number(e.currentTarget.value))}
        aria-label={t("settings.uiFont")}
      />
      <p class="hint">{t("settings.uiFont.hint")}</p>
    </section>

    <section>
      <h3>{t("settings.docFont")} <span class="value">{settings.docFontPx}px</span></h3>
      <input
        type="range"
        min="11"
        max="26"
        step="1"
        value={settings.docFontPx}
        oninput={(e) => set("docFontPx", Number(e.currentTarget.value))}
        aria-label={t("settings.docFont")}
      />
      <p class="hint">{t("settings.docFont.hint")}</p>
    </section>

    <FontPicker
      label={t("settings.fontBody")}
      bind:family={settings.fontBody}
      bind:fallback={settings.fontBodyFallback}
      tail="var(--font-ui)"
      preview={BODY_PREVIEW}
      onChange={() => settings.save()}
    />

    <FontPicker
      label={t("settings.fontCode")}
      bind:family={settings.fontCode}
      bind:fallback={settings.fontCodeFallback}
      preferMonospace
      tail="monospace"
      preview={CODE_PREVIEW}
      onChange={() => settings.save()}
    />

    <button class="btn reset" onclick={() => settings.reset()}>{t("settings.reset")}</button>
  </div>
</aside>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: rgb(0 0 0 / 0.25);
  }

  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    display: flex;
    flex-direction: column;
    width: min(21rem, 90vw);
    border-left: 1px solid var(--border);
    background: var(--bg);
    box-shadow: var(--shadow-lg);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.6rem 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  header h2 {
    margin: 0;
    font-size: 1.08em;
    font-weight: 650;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  section + section {
    margin-top: 1.5rem;
  }

  h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 0 0.5rem;
    font-size: 0.92em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .value {
    font-variant-numeric: tabular-nums;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-secondary);
  }

  .segmented.wide {
    display: flex;
    width: 100%;
  }

  .segmented.wide button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.3rem 0;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.92em;
    color: var(--text-muted);
  }

  .reset {
    width: 100%;
    justify-content: center;
    margin-top: 2rem;
  }
</style>
