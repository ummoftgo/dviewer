<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { DOC_KINDS, encodingChoices, type DocKind } from "../ipc";
  import { workspace, type DocTab } from "../state/docs.svelte";
  import { settings } from "../state/settings.svelte";

  interface Props {
    tab: DocTab;
    showToc: boolean;
    onToggleToc: () => void;
    onOpenSettings: () => void;
  }

  let { tab, showToc, onToggleToc, onOpenSettings }: Props = $props();

  let encodings = $state<[string, string][]>([]);
  onMount(() => {
    void encodingChoices().then((list) => (encodings = list));
  });

  /**
   * Only a guess can be wrong, so only a guess is worth drawing attention to.
   * A BOM, valid UTF-8, or the reader's own choice are all settled facts.
   */
  const encodingUncertain = $derived(tab.meta.encoding.source === "guessed");

  const encodingHint = $derived.by(() => {
    const encoding = tab.meta.encoding;
    if (encoding.warning) return encoding.warning;
    switch (encoding.source) {
      case "bom":
        return `${encoding.label} — BOM으로 확인했습니다.`;
      case "utf8":
        return "UTF-8로 읽었습니다.";
      case "chosen":
        return `${encoding.label} — 직접 고른 인코딩입니다.`;
      default:
        return `${encoding.label} 로 추측했습니다. 글자가 깨져 보이면 바꿔 보세요.`;
    }
  });

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
</script>

<div class="toolbar">
  <div class="doc">
    <span class="title" title={tab.subtitle}>{tab.meta.title}</span>
    <span class="meta">{formatBytes(tab.meta.byteLen)}</span>
  </div>

  <div class="controls">
    {#if tab.view === "prose"}
      <div class="segmented" role="group" aria-label="보기 방식">
        <button aria-pressed={tab.mode === "rendered"} onclick={() => (tab.mode = "rendered")}>
          렌더링
        </button>
        <button aria-pressed={tab.mode === "raw"} onclick={() => (tab.mode = "raw")}>원문</button>
      </div>

      {#if tab.mode === "rendered" && tab.toc.length > 1}
        <button
          class="icon-btn"
          class:on={showToc}
          onclick={onToggleToc}
          aria-pressed={showToc}
          title="목차"
          aria-label="목차 보기"
        >
          <Icon name="list" />
        </button>
      {/if}
    {/if}

    <!-- Seven formats is past what a row of buttons can carry, and the point
         of the control is to correct a wrong guess, not to be used often. -->
    <label class="format" title="이 문서를 다른 형식으로 읽습니다">
      형식
      <select
        value={tab.kind}
        onchange={(e) => workspace.setKind(tab.id, e.currentTarget.value as DocKind)}
      >
        {#each DOC_KINDS as entry (entry.kind)}
          <option value={entry.kind}>{entry.label}</option>
        {/each}
      </select>
    </label>

    <!-- Beside the format picker because the two answer the same question in
         sequence: what is this file, and how do I read its bytes. -->
    <label class="format encoding" class:uncertain={encodingUncertain} title={encodingHint}>
      {#if tab.meta.encoding.warning}
        <span class="warn" aria-hidden="true"><Icon name="warning" size={12} /></span>
      {/if}
      인코딩
      <select
        value={tab.meta.encoding.name}
        onchange={(e) => workspace.setEncoding(tab.id, e.currentTarget.value)}
      >
        {#each encodings as [name, label] (name)}
          <option value={name}>{label}</option>
        {/each}
        {#if !encodings.some(([name]) => name === tab.meta.encoding.name)}
          <!-- Detection can land on something outside the short menu; showing
               it keeps the control from lying about what is in effect. -->
          <option value={tab.meta.encoding.name}>{tab.meta.encoding.label}</option>
        {/if}
      </select>
    </label>

    <span class="scale" title="인터페이스 배율 (Ctrl + / Ctrl -)">
      {Math.round(settings.uiScale * 100)}%
    </span>

    <button class="icon-btn" onclick={onOpenSettings} title="표시 설정" aria-label="표시 설정">
      <Icon name="settings" />
    </button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 2.25rem;
    padding: 0.25rem 0.5rem 0.25rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .doc {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .meta {
    flex: none;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: none;
  }

  .icon-btn.on {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .format {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .format select {
    padding: 0.1rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  .encoding.uncertain select {
    border-color: var(--warning);
  }

  .encoding .warn {
    display: flex;
    color: var(--warning);
  }

  .scale {
    padding: 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
</style>
