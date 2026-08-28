<script lang="ts">
  import FontPicker from "./FontPicker.svelte";
  import Icon from "./Icon.svelte";
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

  const THEMES: { value: ThemeMode; label: string; icon: "auto" | "sun" | "moon" }[] = [
    { value: "auto", label: "자동", icon: "auto" },
    { value: "light", label: "라이트", icon: "sun" },
    { value: "dark", label: "다크", icon: "moon" },
  ];

  // Latin and Hangul together, so a primary family with no Hangul coverage
  // visibly hands those glyphs to the fallback.
  const BODY_PREVIEW = "다람쥐 헌 쳇바퀴에 Sphinx of black quartz 0123";
  const CODE_PREVIEW = 'const path = "$.items[0].name"; // 0O1lI 한글';

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

<aside class="panel" aria-label="표시 설정">
  <header>
    <h2>표시 설정</h2>
    <button class="icon-btn" onclick={onClose} aria-label="설정 닫기">
      <Icon name="close" />
    </button>
  </header>

  <div class="body">
    <section>
      <h3>테마</h3>
      <div class="segmented wide">
        {#each THEMES as theme (theme.value)}
          <button aria-pressed={settings.theme === theme.value} onclick={() => setTheme(theme.value)}>
            <Icon name={theme.icon} size={13} />
            {theme.label}
          </button>
        {/each}
      </div>
      {#if settings.theme === "auto"}
        <p class="hint">
          시스템 설정을 따릅니다 — 현재 {settings.systemDark ? "다크" : "라이트"}.
        </p>
      {/if}
    </section>

    <section>
      <h3>인터페이스 배율 <span class="value">{Math.round(settings.uiScale * 100)}%</span></h3>
      <input
        type="range"
        min="0"
        max={UI_SCALE_STEPS.length - 1}
        step="1"
        value={UI_SCALE_STEPS.indexOf(nearestScaleStep(settings.uiScale))}
        oninput={(e) => set("uiScale", UI_SCALE_STEPS[Number(e.currentTarget.value)])}
        aria-label="인터페이스 배율"
      />
      <p class="hint">
        글자와 여백을 함께 확대합니다. Ctrl + / Ctrl - 로도 조절하고 Ctrl 0 으로 되돌립니다.
      </p>
    </section>

    <section>
      <h3>인터페이스 글자 크기 <span class="value">{settings.uiFontPx}px</span></h3>
      <input
        type="range"
        min="10"
        max="22"
        step="1"
        value={settings.uiFontPx}
        oninput={(e) => set("uiFontPx", Number(e.currentTarget.value))}
        aria-label="인터페이스 글자 크기"
      />
      <p class="hint">탭·툴바·설정 등 화면 요소의 글자만 바꿉니다. 여백은 그대로입니다.</p>
    </section>

    <section>
      <h3>본문 글자 크기 <span class="value">{settings.docFontPx}px</span></h3>
      <input
        type="range"
        min="11"
        max="26"
        step="1"
        value={settings.docFontPx}
        oninput={(e) => set("docFontPx", Number(e.currentTarget.value))}
        aria-label="본문 글자 크기"
      />
      <p class="hint">렌더링된 마크다운과 JSON 트리의 글자 크기입니다.</p>
    </section>

    <FontPicker
      label="본문 글꼴"
      bind:family={settings.fontBody}
      bind:fallback={settings.fontBodyFallback}
      tail="var(--font-ui)"
      preview={BODY_PREVIEW}
      onChange={() => settings.save()}
    />

    <FontPicker
      label="코드 글꼴"
      bind:family={settings.fontCode}
      bind:fallback={settings.fontCodeFallback}
      preferMonospace
      tail="monospace"
      preview={CODE_PREVIEW}
      onChange={() => settings.save()}
    />

    <button class="btn reset" onclick={() => settings.reset()}>기본값으로 되돌리기</button>
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
