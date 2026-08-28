<script lang="ts">
  import { fontStack, settings } from "../state/settings.svelte";

  interface Props {
    label: string;
    /** Primary family; empty means the stylesheet default. */
    family: string;
    /** Family consulted for glyphs the primary one lacks. */
    fallback: string;
    /** Group monospaced families first — for the code font. */
    preferMonospace?: boolean;
    /** Last resort behind both picks. */
    tail: string;
    preview: string;
    onChange: () => void;
  }

  let {
    label,
    family = $bindable(),
    fallback = $bindable(),
    preferMonospace = false,
    tail,
    preview,
    onChange,
  }: Props = $props();

  const monospaced = $derived(settings.fonts.filter((f) => f.monospace));
  const proportional = $derived(settings.fonts.filter((f) => !f.monospace));
  const stack = $derived(fontStack(family, fallback, tail));

  function set(target: "family" | "fallback", value: string) {
    if (target === "family") family = value;
    else fallback = value;
    onChange();
  }
</script>

<section>
  <h3>{label}</h3>

  {#if settings.fontsError}
    <p class="hint error">{settings.fontsError}</p>
  {/if}

  <label class="row">
    <span>기본</span>
    <select
      class="field"
      value={family}
      disabled={settings.fontsLoading}
      onchange={(e) => set("family", e.currentTarget.value)}
    >
      <option value="">{settings.fontsLoading ? "글꼴을 읽는 중…" : "지정 안 함"}</option>
      {#if preferMonospace}
        <optgroup label="고정폭">
          {#each monospaced as font (font.name)}<option value={font.name}>{font.name}</option>{/each}
        </optgroup>
        <optgroup label="그 외">
          {#each proportional as font (font.name)}<option value={font.name}>{font.name}</option
            >{/each}
        </optgroup>
      {:else}
        {#each settings.fonts as font (font.name)}<option value={font.name}>{font.name}</option
          >{/each}
      {/if}
    </select>
  </label>

  <label class="row">
    <span>보조</span>
    <select
      class="field"
      value={fallback}
      disabled={settings.fontsLoading}
      onchange={(e) => set("fallback", e.currentTarget.value)}
    >
      <option value="">지정 안 함</option>
      {#each settings.fonts as font (font.name)}<option value={font.name}>{font.name}</option
        >{/each}
    </select>
  </label>

  <p class="preview" style="font-family: {stack}">{preview}</p>
  <p class="hint">
    기본 글꼴에 없는 글자는 보조 글꼴이 대신 그립니다. 미리보기에 한글과 영문이 모두 의도한 모양으로
    나오는지 확인하세요.
  </p>
</section>

<style>
  .row {
    display: grid;
    grid-template-columns: 2.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
  }

  .row + .row {
    margin-top: 0.35rem;
  }

  .row span {
    color: var(--text-muted);
    font-size: 0.92em;
  }

  select {
    /* A long family list must not stretch the panel. */
    min-width: 0;
  }

  .preview {
    margin: 0.6rem 0 0;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius);
    background: var(--bg-inset);
    color: var(--text);
    font-size: 1em;
    line-height: 1.5;
    word-break: break-word;
  }

  .hint {
    margin: 0.4rem 0 0;
    font-size: 0.92em;
    color: var(--text-muted);
  }

  .hint.error {
    color: var(--danger);
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
</style>
