<script lang="ts">
  import { t } from "../../i18n";
  import { errorMessage, renderMarkdown } from "../../ipc";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";
  import Toc from "./Toc.svelte";
  import { interceptLinks, renderMath, renderMermaid, rewriteImages } from "./enhance";

  interface Props {
    tab: DocTab;
    showToc: boolean;
  }

  let { tab, showToc }: Props = $props();

  let scroller = $state<HTMLElement>();
  let article = $state<HTMLElement>();
  let enhancing = $state(false);

  // The HTML is sanitised in Rust before it reaches us — see markdown.rs.
  $effect(() => {
    const target = tab;
    if (target.html !== null || target.error) return;
    target.busy = true;
    renderMarkdown(target.id)
      .then((rendered) => {
        target.html = rendered.html;
        target.toc = rendered.toc;
      })
      .catch((err) => {
        target.error = errorMessage(err);
      })
      .finally(() => {
        target.busy = false;
      });
  });

  $effect(() => {
    // Re-running on theme change is what keeps mermaid diagrams in step.
    const html = tab.html;
    const dark = settings.resolvedTheme === "dark";
    const host = article;
    if (!host || html === null) return;

    host.innerHTML = html;
    rewriteImages(host, tab.meta);

    let cancelled = false;
    enhancing = true;
    Promise.all([renderMermaid(host, dark), renderMath(host)])
      .catch((err) => console.warn("[dviewer] post-processing failed:", err))
      .finally(() => {
        if (cancelled) return;
        enhancing = false;
        // Restore the reading position only once the layout has settled.
        if (scroller) scroller.scrollTop = tab.scrollTop;
      });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const host = article;
    if (!host) return;
    return interceptLinks(host, scrollToAnchor);
  });

  function scrollToAnchor(id: string) {
    const target = article?.querySelector(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

<div class="layout" class:with-toc={showToc && tab.toc.length > 1}>
  <div
    class="scroller"
    bind:this={scroller}
    onscroll={(e) => (tab.scrollTop = e.currentTarget.scrollTop)}
  >
    <div class="page">
      {#if tab.error}
        <p class="status error" role="alert">{tab.error}</p>
      {:else if tab.html === null}
        <p class="status">{t("markdown.rendering")}</p>
      {/if}
      <article class="markdown-body" bind:this={article}></article>
      {#if enhancing}
        <p class="status subtle">{t("markdown.enhancing")}</p>
      {/if}
    </div>
  </div>

  {#if showToc && tab.toc.length > 1}
    <Toc entries={tab.toc} onSelect={scrollToAnchor} />
  {/if}
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }

  .layout.with-toc {
    grid-template-columns: minmax(0, 1fr) 15rem;
  }

  .scroller {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .page {
    max-width: 52rem;
    margin: 0 auto;
    padding: 2rem 2.5rem 6rem;
  }

  .status {
    color: var(--text-muted);
    font-size: 1em;
  }

  .status.error {
    color: var(--danger);
    font-size: inherit;
  }

  .status.subtle {
    margin-top: 1.5rem;
  }
</style>
