<script lang="ts">
  import Icon from "./Icon.svelte";
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
    {#if tab.kind === "markdown"}
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

    <div class="segmented" role="group" aria-label="문서 형식">
      <button
        aria-pressed={tab.kind === "markdown"}
        onclick={() => workspace.setKind(tab.id, "markdown")}
        title="마크다운으로 읽기">M↓</button
      >
      <button
        aria-pressed={tab.kind === "json"}
        onclick={() => workspace.setKind(tab.id, "json")}
        title="JSON으로 읽기">{"{ }"}</button
      >
    </div>

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

  .scale {
    padding: 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
</style>
