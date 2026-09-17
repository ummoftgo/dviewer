<script lang="ts">
  import { tick, untrack } from "svelte";
  import { prosePosition, proseTop } from '../../position';
  import { proseAnchor, resolveAnchor } from '../../bookmarks';
  import { bookmarks } from '../../state/bookmarks.svelte';
  import { i18n, t } from "../../i18n";
  import { errorMessage, renderMarkdown, highlightLanguages, type HighlightLanguage } from "../../ipc";
  import { workspace, type DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";
  import { enhanceCode, type CodeControl } from './codeControls';
  import { favoriteLanguages } from './code';
  import LanguageDialog from './LanguageDialog.svelte';
  import ContextMenu from '../ContextMenu.svelte';
  import type { MenuItem } from '../menu';
  import CopyDialog from './CopyDialog.svelte';
  import { enhanceBlocks, markBlocks, type BlockInfo } from './blockControls';
  import { rawBlock } from './blocks';
  import { copyMarkdown } from './copy';
  import { copyDiagram, copyMath } from './imageCopy';
  import { copyText } from '../../clipboard';
  import { toasts } from '../../state/toast.svelte';
  import Toc from "./Toc.svelte";
  import { headingPositions, trackHeading } from './toc';
  import MarkdownSearchBar from './MarkdownSearchBar.svelte';
  import { enhanceTables, interceptLinks, renderMath, renderMermaid, rewriteImages, type EnhancedTables } from "./enhance";

  interface Props {
    tab: DocTab;
    showToc: boolean;
    focusSearch?: (() => void) | null;
  }

  let { tab, showToc, focusSearch = $bindable(null) }: Props = $props();

  let scroller = $state<HTMLElement>();
  let article = $state<HTMLElement>();
  let blocks: BlockInfo[] = [];
  let codeControls = $state<ReturnType<typeof enhanceCode>>();
  let languages = $state<HighlightLanguage[]>([]);
  let codeAt = $state<{ x: number; y: number; control: CodeControl } | null>(null);
  let languageTarget = $state<CodeControl | null>(null);
  let controls = $state<ReturnType<typeof enhanceBlocks>>();
  let copyAt = $state<{ x: number; y: number; index: number; raw: boolean } | null>(null);
  let headingCopy = $state<{ index: number; format: 'raw' | 'html'; revision: number } | null>(null);
  let enhancing = $state(false);
  let tables = $state<EnhancedTables>();
  let activeId = $state('');

  $effect(() => {
    void [settings.docFontPx, settings.uiFontPx, settings.uiScale, settings.fontBody, settings.fontBodyFallback];
    const target = tab, host = article, viewport = scroller;
    if (!host || !viewport || target.html === null || enhancing) return;
    target.readBookmarkAnchor = () => {
      const headings = headingPositions(host,viewport,target.toc.map(entry => entry.id));
      const inset = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return proseAnchor(target.toc,headings,viewport.scrollTop + inset,Math.max(0,viewport.scrollHeight - viewport.clientHeight));
    };
    const stop = trackHeading(host, viewport, tab.toc.map(entry => entry.id), id => { activeId = id; target.bookmarkHeading = id; },
      (headings,top,max) => tab.rememberPosition(prosePosition(headings,top,max)));
    return () => { stop(); target.bookmarkHeading = null; target.readBookmarkAnchor = null; };
  });

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
      .finally(async () => {
        if (cancelled) return;
        tables = enhanceTables(host, target.tables, target.markdownTableMode);
        controls = enhanceBlocks(host, openCopy);
        codeControls = enhanceCode(host, target, openLanguage);
        const explicitAnchor = untrack(() => target.pendingAnchor);
        enhancing = false;
        if (untrack(() => target.pendingPosition)) await tick();
        if (cancelled) return;
        // Restore the reading position only once the layout has settled.
        if (scroller) {
          const pos = untrack(() => tab.pendingPosition);
          const headings = headingPositions(host,scroller,target.toc.map(entry => entry.id));
          const max = Math.max(0,scroller.scrollHeight - scroller.clientHeight);
          if (explicitAnchor === null) scroller.scrollTop = pos?.kind === 'prose' ? proseTop(pos,headings,max) : tab.scrollTop;
          tab.scrollTop = scroller.scrollTop;
          if (pos) tab.finishPosition(explicitAnchor === null && scroller.scrollTop > 0);
          tab.rememberPosition(prosePosition(headings,scroller.scrollTop,max));
        }
      });

    return () => {
      cancelled = true;
      codeControls?.destroy();
      codeControls = undefined;
      codeAt = null;
      languageTarget = null;
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
    untrack(() => { current?.refresh(); controls?.refresh(); codeControls?.refresh(); });
  });

  $effect(() => {
    const host = article;
    if (!host) return;
    return interceptLinks(host, scrollToAnchor, href => { void workspace.openLink(tab, href); });
  });

  $effect(() => {
    const anchor = tab.pendingAnchor;
    const jump = tab.pendingBookmark;
    if (anchor === null || !article || tab.html === null || enhancing) return;
    untrack(() => {
      const resolved = jump ? resolveAnchor(jump.anchor, tab.toc) : {id:anchor};
      const found = resolved !== null && scrollToAnchor(resolved.id, 'instant');
      if (jump) bookmarks.complete(tab, jump, found);
      else tab.pendingAnchor = null;
    });
  });

  async function openLanguage(control: CodeControl) {
    try {
      languages = await highlightLanguages();
      if (!control.button.isConnected) return;
      const box = control.button.getBoundingClientRect();
      codeAt = { x: box.right, y: box.bottom, control };
    } catch { toasts.show(t('markdown.code.failed'), 'error'); }
  }
  function languageItems(): MenuItem[] {
    if (!codeAt) return [];
    const control = codeAt.control;
    return [...favoriteLanguages(languages).map((language) => ({
      label: language.name, checked: control.language.name === language.name,
      action: () => { void control.select(language.name); },
    })), { label: t('markdown.code.all'), action: () => { languageTarget = control; } }];
  }

  async function openCopy(index: number, button: HTMLButtonElement) {
    const target = tab;
    const revision = target.markdownRevision;
    try {
      const raw = await target.loadRaw();
      if (target !== tab || revision !== target.markdownRevision || !button.isConnected) return;
      const box = button.getBoundingClientRect();
      const available = rawBlock(raw, blocks, index) !== null;
      if (!available) toasts.show(t('markdown.copy.noSource'), 'info');
      copyAt = { x: box.left, y: box.bottom, index, raw: available };
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
        action: () => chooseCopy(index, 'raw') },
      { label: t('markdown.copy.html'), icon: 'copy', action: () => chooseCopy(index, 'html') },
    ];
    const block = article?.querySelector<HTMLElement>(`[data-dviewer-block="${index}"]`);
    const svg = block?.matches('.mermaid-block') ? block.querySelector<SVGSVGElement>('svg') : null;
    if (svg) items.unshift(
      { label: t('markdown.copy.png'), icon: 'copy', action: () => { void copyDiagram(svg, 'png'); } },
      { label: t('markdown.copy.svg'), icon: 'copy', action: () => { void copyDiagram(svg, 'svg'); } },
    );
    const math = block?.matches('[data-dviewer-math]') ? block : block?.querySelector<HTMLElement>('[data-dviewer-math]');
    if (math) {
      const mathItems: MenuItem[] = [];
      if (math.querySelector('.katex-display')) mathItems.push({ label: t('markdown.copy.png'), icon: 'copy', action: () => { void copyMath(math, 'png'); } });
      mathItems.push({ label: t('markdown.copy.tex'), icon: 'copy', action: () => { void copyMath(math, 'tex'); } });
      if (math.querySelector('math')) mathItems.push({ label: t('markdown.copy.mathml'), icon: 'copy', action: () => { void copyMath(math, 'mathml'); } });
      items.unshift(...mathItems);
    }
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

  function scrollToAnchor(id: string, behavior: ScrollBehavior = "smooth") {
    if (id === '') {
      scroller?.scrollTo({top:0,behavior});
      return !!scroller;
    }
    const target = article?.querySelector(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ behavior, block: "start" });
    return !!target;
  }
</script>

<div class="layout" data-position-ready={tab.html !== null && !enhancing ? 'true' : undefined} data-focus-toc class:with-toc={showToc && tab.toc.length > 1} class:with-search={tab.markdownSearch.open}>
  <MarkdownSearchBar {tab} root={article} {scroller} ready={tab.html !== null && !enhancing} bind:focusSearch />
  <div
    class="scroller"
    tabindex="-1"
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
    <Toc entries={tab.toc} {activeId} onSelect={scrollToAnchor} />
  {/if}
</div>

{#if codeAt}
  <ContextMenu x={codeAt.x} y={codeAt.y} items={languageItems()}
    onClose={() => { codeAt?.control.button.focus(); codeAt = null; }} />
{/if}
{#if languageTarget}
  <LanguageDialog {languages} current={languageTarget.language.name} onChoose={(name) => {
    const target = languageTarget;
    languageTarget = null;
    if (target) { void target.select(name); target.button.focus(); }
  }} onClose={() => { languageTarget?.button.focus(); languageTarget = null; }} />
{/if}
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
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }

  .layout.with-toc {
    grid-template-columns: minmax(0, 1fr) 15rem;
  }

  .layout.with-search { grid-template-rows: auto minmax(0, 1fr); }

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
