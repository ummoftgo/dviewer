<script lang="ts">
  import { untrack } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { errorMessage, frameServed, frameUrl } from '../../ipc';
  import { t } from '../../i18n';
  import { workspace, type DocTab } from '../../state/docs.svelte';
  import { settings } from '../../state/settings.svelte';
  import { toasts } from '../../state/toast.svelte';
  import { frameLocation, frameMessage } from '../../frame/messages';
  import { parentCspViolation } from '../../frame/diagnostics';
  import Toc from '../markdown/Toc.svelte';
  import FrameSearchBar from './FrameSearchBar.svelte';
  interface Props { tab: DocTab; showToc: boolean; probe?: boolean; focusSearch?: (() => void) | null; onShortcut?: (key: 'escape' | 'focus') => void }
  let {tab, showToc, probe = false, focusSearch = $bindable(null), onShortcut}: Props = $props();
  let iframe = $state<HTMLIFrameElement>();
  let src = $state<string>();
  let expectedLoad = '';
  let activeId = $state('');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let broken = false;
  const post = (message: unknown) => iframe?.contentWindow?.postMessage(message, '*');
  $effect(() => {
    const target = tab, query = tab.frameQuery;
    expectedLoad = '';
    target.frameContentLoaded = false;
    const testing = probe;
    let live = true;
    target.frameReady = false; target.frameReadyLoad = ''; target.frameBlocked = 0; target.frameProbe = null;
    target.frameError = null; target.frameUrlPort = null; target.frameLoaded = false;
    target.frameServed = null; target.frameCsp = []; target.frameAgentStarted = false;
    target.frameStage = null;
    const cspViolation = (event: SecurityPolicyViolationEvent) => {
      const entry = parentCspViolation(event.effectiveDirective, event.blockedURI);
      if (!target.frameCsp.includes(entry) && target.frameCsp.length < 4) target.frameCsp.push(entry);
    };
    document.addEventListener('securitypolicyviolation', cspViolation);
    broken = false;
    void frameUrl(target.id).then(url => {
      if (!live) return;
      target.frameUrlPort = new URL(url).port;
      src = frameLocation(url,query,testing);
      expectedLoad = new URL(src).search;
      deadline = setTimeout(() => {
        if (!live || target.frameReady) return;
        target.frameError = t('frame.failed');
        void frameServed(target.id).then(value => { if (live) target.frameServed = value; })
          .catch(() => { /* An unavailable counter stays unknown, never zero. */ });
      }, 30000);
    }).catch(cause => { if (live) target.frameError = errorMessage(cause); });
    return () => {
      live = false; clearTimeout(deadline); target.frameReady = false;
      document.removeEventListener('securitypolicyviolation', cspViolation);
    };
  });
  $effect(() => {
    if (!tab.frameReady) return;
    post({type:'theme',dark:settings.theme === 'dark' || (settings.theme === 'auto' && settings.systemDark)});
  });
  $effect(() => {
    const id = tab.pendingAnchor;
    if (!id || !tab.frameContentLoaded) return;
    untrack(() => { post({type:'goto',id}); activeId = id; tab.pendingAnchor = null; });
  });
  function find(dir: 1 | -1) {
    if (!tab.frameReady) return;
    post({type:'find',q:tab.frameSearch.query,dir,request:++tab.frameSearch.request});
  }
  function receive(event: MessageEvent) {
    if (broken) return;
    const load = expectedLoad;
    const message = frameMessage(event, iframe?.contentWindow ?? null, load);
    if (!message) return;
    switch (message.type) {
      case 'agentStart': tab.frameAgentStarted = true; break;
      case 'stage': if (tab.kind === 'pdf') tab.frameStage = message.name; break;
      case 'ready':
        if (tab.kind === 'pdf' && !message.pages) break;
        clearTimeout(deadline); tab.frameToc = message.headings; tab.frameReadyLoad = load; tab.frameReady = true;
        if (tab.kind === 'pdf') {
          tab.framePages = message.pages!; tab.frameContentLoaded = true;
          const pos = tab.pendingPosition;
          const page = Math.max(1,Math.min(tab.framePages,pos?.kind === 'pdf' ? pos.page : tab.framePage));
          post({type:'goto',page});
        }
        if (tab.frameSearch.query) find(1);
        break;
      case 'page':
        if (tab.kind !== 'pdf' || !tab.frameReady || message.n > tab.framePages) break;
        if (tab.framePage !== message.n) tab.frameHasText = null;
        tab.framePage = message.n;
        if (tab.pendingPosition) {
          const pos = tab.pendingPosition;
          const expected = pos.kind === 'pdf' ? Math.min(pos.page,tab.framePages) : 1;
          if (message.n !== expected) break;
          tab.finishPosition(expected > 1);
        }
        tab.rememberPosition({kind:'pdf',page:message.n});
        break;
      case 'pageText':
        if (tab.kind === 'pdf' && message.page === tab.framePage) tab.frameHasText = message.hasText;
        break;
      case 'error':
        if (tab.kind === 'pdf') {
          clearTimeout(deadline); tab.frameReady = false;
          tab.frameError = errorMessage({code:message.code}) + (message.detail ? ` (detail ${message.detail})` : '');
        }
        break;
      case 'loaded': {
        if (tab.kind === 'pdf') break;
        tab.frameContentLoaded = true;
        const pos = tab.pendingPosition;
        const ratio = message.scrollable ? (pos?.kind === 'frame' ? pos.ratio : tab.frameScroll) : 0;
        tab.frameScroll = ratio;
        if (!tab.pendingAnchor) post({type:'goto',ratio});
        if (pos) tab.finishPosition(ratio > 0 && message.scrollable && !tab.pendingAnchor);
        tab.rememberPosition({kind:'frame',ratio});
        break;
      }
      case 'scroll':
        if (tab.kind === 'pdf') break;
        tab.frameScroll = message.ratio;
        if (tab.frameContentLoaded) tab.rememberPosition({kind:'frame',ratio:message.ratio});
        break;
      case 'blocked': tab.frameBlocked = message.n; break;
      case 'probe': if (probe) tab.frameProbe = message.invoke; break;
      case 'isolationBroken':
        broken = true; src = undefined; tab.frameReady = false; tab.frameError = t('frame.isolationBroken'); break;
      case 'found':
        if (message.request === tab.frameSearch.request) { tab.frameSearch.n = message.n; tab.frameSearch.index = message.index; }
        break;
      case 'shortcut':
        if (message.key === 'raw') { if (tab.kind !== 'pdf') tab.mode = 'raw'; }
        else if (message.key === 'find') focusSearch?.();
        else if (message.key === 'escape' && tab.frameSearch.open) tab.frameSearch.open = false;
        else onShortcut?.(message.key);
        break;
      case 'link':
        if (message.kind === 'relative') void workspace.openLink(tab,message.href);
        else void openUrl(message.href).catch(cause => toasts.show(errorMessage(cause),'error'));
    }
  }
  async function toggleExternal() {
    try { await tab.setFrameExternal(!tab.frameExternal); }
    catch (cause) { toasts.show(errorMessage(cause), 'error'); }
  }
</script>
<svelte:window onmessage={receive} />
<div class="frame-layout" data-ready={tab.frameReady ? 'true' : undefined} data-load={tab.frameReadyLoad} data-probe={tab.frameProbe ?? undefined}>
  <FrameSearchBar {tab} ready={tab.frameReady} onFind={find} bind:focusSearch />
  <div class="content" data-focus-toc class:with-toc={showToc && tab.frameToc.length > (tab.kind === 'pdf' ? 0 : 1)}>
    {#if tab.frameError}<p class="error" role="alert">{tab.frameError}</p>
    {:else if src}{#key src}<iframe bind:this={iframe} {src} sandbox="allow-scripts" title={tab.meta.title}
      onload={() => { tab.frameLoaded = true; }}></iframe>{/key}{/if}
    {#if showToc && tab.frameToc.length > (tab.kind === 'pdf' ? 0 : 1)}<aside data-focus-chrome><Toc entries={tab.frameToc} {activeId} onSelect={id => {activeId=id;post({type:'goto',id});}} /></aside>{/if}
  </div>
  {#if tab.frameBlocked || tab.frameExternal || (tab.kind === 'pdf' && tab.frameReady)}
    <div class="status" role="status">
      {#if tab.kind === 'pdf' && tab.frameReady}<span>{t('frame.pages',{n:tab.framePage,total:tab.framePages})}</span>{/if}
      {#if tab.kind === 'pdf' && tab.frameHasText === false}<span>{t('frame.noText')}</span>{/if}
      {#if tab.frameExternal}<span>{t('frame.allowed')}</span>{/if}
      {#if tab.frameBlocked}<span>{t('frame.blocked',{n:tab.frameBlocked})}</span>{/if}
      {#if tab.frameBlocked || tab.frameExternal}<button type="button" data-action="frame-external" disabled={tab.frameToggling || (!tab.frameReady && !tab.frameExternal)}
        onclick={toggleExternal}>{t(tab.frameExternal ? 'frame.block' : 'frame.allow')}</button>
      {/if}
    </div>
  {/if}
</div>
<style>
  .frame-layout { display:flex; flex-direction:column; height:100%; min-height:0; }
  .content { flex:1; display:grid; min-height:0; grid-template-columns:minmax(0,1fr); }
  .content.with-toc { grid-template-columns:minmax(0,1fr) 15rem; }
  iframe { width:100%; height:100%; border:0; background:white; }
  aside { overflow:auto; min-width:0; }
  .status { display:flex; align-items:center; flex-wrap:wrap; gap:0.5rem; padding:0.3rem 0.7rem; font-size:0.85em; color:var(--text-muted); border-top:1px solid var(--border); }
  .error { color:var(--danger); padding:1rem; }
  @media(max-width:800px) { .content.with-toc { grid-template-columns:minmax(0,1fr) 11rem; } }
</style>
