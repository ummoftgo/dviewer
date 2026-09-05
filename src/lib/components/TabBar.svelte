<script lang="ts">
  import ContextMenu from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import type { MenuItem } from "./menu";
  import { kindBadge } from "../ipc";
  import { t } from "../i18n";
  import { disambiguate, splitTitle } from "../tabs";
  import { workspace } from "../state/docs.svelte";

  interface Props {
    onNew: () => void;
  }

  let { onNew }: Props = $props();

  let strip = $state<HTMLElement>();
  /** Whether there are tabs the strip cannot show, and on which side. */
  let overflowing = $state(false);
  let hiddenBefore = $state(false);
  let hiddenAfter = $state(false);
  /** Where the tab list is open, or null when it is not. */
  let listAt = $state<{ x: number; y: number } | null>(null);

  function labelOf(tab: (typeof workspace.tabs)[number]): string {
    return tab.status === "blank" ? t("tab.blank") : tab.meta.title;
  }

  // What each tab needs beyond its own name to be told from its namesakes.
  // Empty for every tab whose name is already unique, which is most of them.
  const hints = $derived(
    disambiguate(
      workspace.tabs.map((tab) => ({
        id: tab.id,
        title: labelOf(tab),
        source: tab.meta.source,
      })),
    ),
  );

  function measure() {
    if (!strip) return;
    const slack = strip.scrollWidth - strip.clientWidth;
    // A pixel of tolerance: fractional layout leaves a sliver of slack on a
    // strip that is not actually overflowing, and a fade over nothing is a
    // promise of tabs that are not there.
    overflowing = slack > 1;
    hiddenBefore = strip.scrollLeft > 1;
    hiddenAfter = slack - strip.scrollLeft > 1;
  }

  /**
   * Every open tab, in strip order, for the menu.
   *
   * Keyed by the tab's own key rather than by its label: two pasted documents
   * carry the same name and no path to tell them apart, and a menu keyed by
   * label would take those two for one.
   */
  function tabList(): MenuItem[] {
    return workspace.tabs.map((tab) => {
      const hint = hints.get(tab.id);
      return {
        key: String(tab.key),
        label: hint ? `${labelOf(tab)} · ${hint}` : labelOf(tab),
        hint: tab.status === "opening" ? t("tab.opening") : kindBadge(tab.kind),
        checked: tab.id === workspace.activeId,
        action: () => workspace.activate(tab.id),
      };
    });
  }

  // The strip's own box changes with the window; what is inside it changes
  // with the tabs. Neither observes the other, so both are watched.
  $effect(() => {
    if (!strip) return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  });

  $effect(() => {
    for (const tab of workspace.tabs) {
      void tab.status;
      void tab.meta.title;
    }
    measure();
  });

  // Follow the active tab, however it became active — a click, Ctrl+Tab, a new
  // document, or the tab that inherits the place of one just closed. Asked of
  // the DOM rather than bound per tab: there is only ever one of these, and
  // an effect runs after the class has landed on it.
  $effect(() => {
    void workspace.activeId;
    strip
      ?.querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });

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
  <div class="wrap" class:before={hiddenBefore} class:after={hiddenAfter}>
    <div class="strip" bind:this={strip} role="tablist" onwheel={onWheel} onscroll={measure}>
      {#each workspace.tabs as tab (tab.key)}
        {@const label = labelOf(tab)}
        {@const name = splitTitle(label)}
        {@const hint = hints.get(tab.id)}
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
          <!-- Two spans so the browser cuts the middle: the head is allowed to
               shrink and ellipsise, the tail never is. -->
          <span class="title">
            <span class="head">{name.head}</span>
            {#if name.tail}<span class="tail">{name.tail}</span>{/if}
          </span>
          {#if hint}
            <span class="hint">{hint}</span>
          {/if}
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
  </div>

  <!-- Only when scrolling is the alternative. On a strip that fits, every tab
       is already on screen and a list of them would say nothing twice. -->
  {#if overflowing}
    <button
      class="icon-btn list"
      title={t("tab.list")}
      aria-label={t("tab.listLabel")}
      aria-haspopup="menu"
      onclick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        listAt = { x: box.left, y: box.bottom };
      }}
    >
      <Icon name="chevron-down" size={12} />
    </button>
  {/if}

  <button class="icon-btn new" onclick={onNew} title={t("tab.new")} aria-label={t("tab.newLabel")}>
    <Icon name="plus" />
  </button>
</div>

{#if listAt}
  <ContextMenu x={listAt.x} y={listAt.y} items={tabList()} onClose={() => (listAt = null)} />
{/if}

<style>
  .tabbar {
    --tab-fade: 1.5rem;
    display: flex;
    align-items: stretch;
    min-height: 2.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  /* Holds the fades, which must not scroll with what they are fading. */
  .wrap {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
  }

  /* A hint that the strip goes on past the edge, on whichever side it does.
     Drawn over the tabs rather than beside them, so it costs no width — the
     one thing a full strip has none of. */
  .wrap::before,
  .wrap::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--tab-fade);
    z-index: 1;
    opacity: 0;
    transition: opacity 0.12s ease;
    pointer-events: none;
  }

  .wrap::before {
    left: 0;
    background: linear-gradient(to right, var(--bg-subtle), transparent);
  }

  .wrap::after {
    right: 0;
    background: linear-gradient(to left, var(--bg-subtle), transparent);
  }

  .wrap.before::before,
  .wrap.after::after {
    opacity: 1;
  }

  .strip {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    /* So `scrollIntoView` stops a fade's width short of the edge instead of
       parking the tab it just revealed underneath one. */
    scroll-padding-inline: var(--tab-fade);
  }

  .strip::-webkit-scrollbar {
    height: 0;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 14rem;
    /* Below this a tab is a badge and a close button, which names nothing.
       Holding the floor is what makes the strip overflow — and overflowing is
       what makes it scroll, which it never did while tabs kept shrinking. */
    min-width: 7.5rem;
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
  .tab.active .kind[data-kind="jsonc"],
  .tab.active .kind[data-kind="jsonl"],
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
    display: flex;
    min-width: 0;
    white-space: nowrap;
  }

  /* The only part that gives way, and the `…` lands where it is cut. */
  .head {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tail {
    flex: none;
  }

  /* The folder (or host, or archive) that tells this tab from its namesake.
     Shrinks five times as readily as the name does: if only one of the two
     can fit, the name is the one worth keeping. */
  .hint {
    flex: 0 5 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .hint::before {
    content: "·";
    margin-right: 0.3rem;
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

  .list,
  .new {
    align-self: center;
    flex: none;
  }

  .list {
    margin-left: 0.3rem;
  }

  .new {
    margin: 0 0.3rem;
  }
</style>
