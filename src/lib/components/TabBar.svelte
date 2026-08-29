<script lang="ts">
  import Icon from "./Icon.svelte";
  import { kindBadge } from "../ipc";
  import { t } from "../i18n";
  import { workspace } from "../state/docs.svelte";

  interface Props {
    onNew: () => void;
  }

  let { onNew }: Props = $props();

  function onWheel(event: WheelEvent) {
    // A horizontal strip should scroll with a plain vertical wheel.
    const strip = event.currentTarget as HTMLElement;
    if (event.deltaX === 0 && strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  function onAuxClick(event: MouseEvent, id: number) {
    if (event.button === 1) {
      event.preventDefault();
      void workspace.close(id);
    }
  }
</script>

<div class="tabbar">
  <div class="strip" role="tablist" onwheel={onWheel}>
    {#each workspace.tabs as tab (tab.key)}
      <div
        class="tab"
        class:active={tab.id === workspace.activeId}
        role="tab"
        tabindex={tab.id === workspace.activeId ? 0 : -1}
        aria-selected={tab.id === workspace.activeId}
        title={tab.subtitle}
        onclick={() => workspace.activate(tab.id)}
        onauxclick={(e) => onAuxClick(e, tab.id)}
        onkeydown={(e) => e.key === "Enter" && workspace.activate(tab.id)}
      >
        {#if tab.status === "opening"}
          <span class="kind opening" title={t("tab.opening")}>…</span>
        {:else}
          <span class="kind" data-kind={tab.kind}>{kindBadge(tab.kind)}</span>
        {/if}
        <span class="title">{tab.status === "blank" ? t("tab.blank") : tab.meta.title}</span>
        <button
          class="close"
          aria-label={t("tab.close", { title: tab.meta.title })}
          onclick={(e) => {
            e.stopPropagation();
            void workspace.close(tab.id);
          }}
        >
          <Icon name="close" size={11} />
        </button>
      </div>
    {/each}
  </div>

  <button class="icon-btn new" onclick={onNew} title={t("tab.new")} aria-label={t("tab.newLabel")}>
    <Icon name="plus" />
  </button>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    min-height: 2.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  .strip {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .strip::-webkit-scrollbar {
    height: 0;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 14rem;
    min-width: 0;
    padding: 0 0.4rem 0 0.6rem;
    border-right: 1px solid var(--border);
    color: var(--text-secondary);
    cursor: default;
    user-select: none;
  }

  .tab:hover {
    background: var(--bg-hover);
  }

  .tab.active {
    background: var(--bg);
    color: var(--text);
    /* An inset line rather than a border so the tab does not shift by a pixel. */
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .kind {
    flex: none;
    font-family: var(--font-code);
    font-size: 0.77em;
    line-height: 1;
    padding: 0.2rem 0.25rem;
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-muted);
  }

  .kind.opening {
    color: var(--accent);
  }

  /* Coloured by view rather than by format: what the badge is telling you is
     which of the three readers you are about to land in. */
  .tab.active .kind[data-kind="markdown"] {
    color: var(--accent);
  }

  .tab.active .kind[data-kind="json"],
  .tab.active .kind[data-kind="yaml"],
  .tab.active .kind[data-kind="toml"] {
    color: var(--json-key);
  }

  .tab.active .kind[data-kind="xml"] {
    color: var(--xml-tag);
  }

  .tab.active .kind[data-kind="csv"],
  .tab.active .kind[data-kind="tsv"] {
    color: var(--success);
  }

  /* A grid like the other two, but not read out of the file's own text. */
  .tab.active .kind[data-kind="sqlite"] {
    color: var(--json-bool);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    opacity: 0;
  }

  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }

  .close:hover {
    background: var(--bg-active);
    color: var(--text);
  }

  .new {
    align-self: center;
    margin: 0 0.3rem;
  }
</style>
