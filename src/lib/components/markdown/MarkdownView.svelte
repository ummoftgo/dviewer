<script lang="ts">
  import { untrack } from "svelte";
  import { i18n, t } from "../../i18n";
  import { errorMessage, renderMarkdown } from "../../ipc";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";
  import ContextMenu from '../ContextMenu.svelte';
  import type { MenuItem } from '../menu';
  import CopyDialog from './CopyDialog.svelte';
  import { enhanceBlocks, markBlocks, type BlockInfo } from './blockControls';
  import { rawBlock } from './blocks';
  import { copyMarkdown } from './copy';
  import { copyText } from '../../clipboard';
  import { toasts } from '../../state/toast.svelte';
  import Toc from "./Toc.svelte";
  import { enhanceTables, interceptLinks, renderMath, renderMermaid, rewriteImages, type EnhancedTables } from "./enhance";

  interface Props {
    tab: DocTab;
    showToc: boolean;
  }

  let { tab, showToc }: Props = $props();

  let scroller = $state<HTMLElement>();
  let article = $state<HTMLElement>();
  let blocks: BlockInfo[] = [];
  let controls = $state<ReturnType<typeof enhanceBlocks>>();
  let copyAt = $state<{ x: number; y: number; index: number; raw: boolean } | null>(null);
  let headingCopy = $state<{ index: number; format: 'raw' | 'html'; revision: number } | null>(null);
  let enhancing = $state(false);
  let tables = $state<EnhancedTables>();

  // The HTML is sanitised in Rust before it reaches us — see markdown.rs.
  $effect(() => {
    const target = tab;
    const revision = target.markdownRevision;
    if (target.html !== null || target.error) return;
    target.busy = true;
    renderMarkdown(target.id)
      .then((rendered) => {
        if (target.markdownRevision !== revision) return;
        target.codeLanguages = rendered.codeLanguages;
        target.html = rendered.html;
        target.toc = rendered.toc;
      })
      .catch((err) => {
        if (target.markdownRevision === revision) target.error = errorMessage(err);
      })
      .finally(() => {
        if (target.markdownRevision === revision) target.busy = false;
      });
  });

  $effect(() => {
    // Re-running on theme change is what keeps mermaid diagrams in step.
    const target = tab;
    const html = target.html;
    const dark = settings.resolvedTheme === "dark";
    const host = article;
    if (!host || html === null) return;

    host.innerHTML = html;
    blocks = markBlocks(host);
    rewriteImages(host, tab.meta);

    let cancelled = false;
    enhancing = true;
    Promise.all([renderMermaid(host, dark), renderMath(host)])
      .catch((err) => console.warn("[dviewer] post-processing failed:", err))
      .finally(() => {
        if (cancelled) return;
        tables = enhanceTables(host, target.tables, target.markdownTableMode);
        controls = enhanceBlocks(host, openCopy);
        enhancing = false;
        // Restore the reading position only once the layout has settled.
        if (scroller) scroller.scrollTop = tab.scrollTop;
      });

    return () => {
      cancelled = true;
      controls?.destroy();
      controls = undefined;
      copyAt = null;
      headingCopy = null;
      tables?.destroy();
      tables = undefined;
    };
  });

  $effect(() => {
    // Geometry and translated controls change without replacing the document.
    void [settings.docFontPx, settings.uiFontPx, settings.uiScale, settings.fontBody,
      settings.fontBodyFallback, settings.fontCode, settings.fontCodeFallback, i18n.locale];
    const current = tables;
    untrack(() => { current?.refresh(); controls?.refresh(); });
  });

  $effect(() => {
    const host = article;
    if (!host) return;
    return interceptLinks(host, scrollToAnchor);
  });

  async function openCopy(index: number, button: HTMLButtonElement) {
    const target = tab;
    const revision = target.markdownRevision;
    try {
      const raw = await target.loadRaw();
      if (target !== tab || revision !== target.markdownRevision || !button.isConnected) return;
      const box = button.getBoundingClientRect();
      copyAt = { x: box.left, y: box.bottom, index, raw: rawBlock(raw, blocks, index) !== null };
    } catch { toasts.show(t('toast.copyFailed'), 'error'); }
  }
  function chooseCopy(index: number, format: 'raw' | 'html') {
    if (blocks[index]?.level) headingCopy = { index, format, revision: tab.markdownRevision };
    else void copyMarkdown(tab, format, index);
  }
  function copyItems(): MenuItem[] {
    if (!copyAt) return [];
    const { index, raw } = copyAt;
    const items: MenuItem[] = [
      { label: t('markdown.copy.raw'), icon: 'copy', disabled: !raw,
        hint: raw ? undefined : t('markdown.copy.noSource'), action: () => chooseCopy(index, 'raw') },
      { label: t('markdown.copy.html'), icon: 'copy', action: () => chooseCopy(index, 'html') },
    ];
    const code = blocks[index]?.code;
    if (code !== null && code !== undefined) items.push({ label: t('markdown.copy.code'), icon: 'copy', action: () => {
      void copyText(code).then(() => {
        let count = 0;
        for (const _ of code) count++;
        toasts.show(t('markdown.copy.codeDone', { n: count }));
      }).catch(() => toasts.show(t('toast.copyFailed'), 'error'));
    } });
    return items;
  }

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
    <div class="page" style:max-width={settings.markdownPageWidth === 0 ? "none" : `${settings.markdownPageWidth}rem`}>
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

{#if copyAt}
  <ContextMenu x={copyAt.x} y={copyAt.y} items={copyItems()}
    onClose={() => { copyAt = null; controls?.button.focus(); }} />
{/if}
{#if headingCopy}
  <CopyDialog heading onChoose={(choice) => {
    const request = headingCopy;
    headingCopy = null;
    if (request && request.revision === tab.markdownRevision) void copyMarkdown(tab, request.format, request.index, choice === 'section');
    controls?.button.focus();
  }} onClose={() => { headingCopy = null; controls?.button.focus(); }} />
{/if}

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
