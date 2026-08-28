<script lang="ts">
  import Icon from "./Icon.svelte";
  import { DOC_KINDS, type DocKind } from "../ipc";
  import { workspace, type DocTab } from "../state/docs.svelte";
  import { settings } from "../state/settings.svelte";

  interface Props {
    tab: DocTab;
    showToc: boolean;
    onToggleToc: () => void;
    onOpenSettings: () => void;
  }

  let { tab, showToc, onToggleToc, onOpenSettings }: Props = $props();

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

  .scale {
    padding: 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
</style>
