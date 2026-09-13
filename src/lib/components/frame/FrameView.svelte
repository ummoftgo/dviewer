<script lang="ts">
  import { untrack } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { errorMessage, frameServed, frameUrl } from '../../ipc';
  import { t } from '../../i18n';
  import { workspace, type DocTab } from '../../state/docs.svelte';
  import { settings } from '../../state/settings.svelte';
  import { toasts } from '../../state/toast.svelte';
  import { frameMessage } from '../../frame/messages';
  import { parentCspViolation } from '../../frame/diagnostics';
  import Toc from '../markdown/Toc.svelte';
  import FrameSearchBar from './FrameSearchBar.svelte';
  interface Props { tab: DocTab; showToc: boolean; probe?: boolean; focusSearch?: (() => void) | null; onShortcut?: (key: 'escape' | 'focus') => void }
  let {tab, showToc, probe = false, focusSearch = $bindable(null), onShortcut}: Props = $props();
  let iframe = $state<HTMLIFrameElement>();
  let src = $state<string>();
  let activeId = $state('');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let broken = false;
  const post = (message: unknown) => iframe?.contentWindow?.postMessage(message, '*');
  $effect(() => {
    const target = tab, generation = tab.meta.generation;
    const testing = probe;
    let live = true;
    target.frameReady = false; target.frameBlocked = 0; target.frameProbe = null;
    target.frameError = null; target.frameUrlPort = null; target.frameLoaded = false;
    target.frameServed = null; target.frameCsp = []; target.frameAgentStarted = false;
    const cspViolation = (event: SecurityPolicyViolationEvent) => {
      const entry = parentCspViolation(event.effectiveDirective, event.blockedURI);
      if (!target.frameCsp.includes(entry) && target.frameCsp.length < 4) target.frameCsp.push(entry);
    };
    document.addEventListener('securitypolicyviolation', cspViolation);
    broken = false;
    void frameUrl(target.id).then(url => {
      if (!live) return;
      target.frameUrlPort = new URL(url).port;
      src = `${url}?g=${generation}${testing ? '&probe=1' : ''}`;
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
    if (!id || !tab.frameReady) return;
    untrack(() => { post({type:'goto',id}); activeId = id; tab.pendingAnchor = null; });
  });
  function find(dir: 1 | -1) {
    if (!tab.frameReady) return;
    post({type:'find',q:tab.frameSearch.query,dir,request:++tab.frameSearch.request});
  }
  function receive(event: MessageEvent) {
    if (broken) return;
    const message = frameMessage(event, iframe?.contentWindow ?? null);
    if (!message) return;
    switch (message.type) {
      case 'agentStart': tab.frameAgentStarted = true; break;
      case 'ready':
        clearTimeout(deadline); tab.frameToc = message.headings; tab.frameReady = true;
        if (!tab.pendingAnchor) post({type:'goto',ratio:tab.frameScroll});
        if (tab.frameSearch.query) find(1);
        break;
      case 'scroll': tab.frameScroll = message.ratio; break;
      case 'blocked': tab.frameBlocked = message.n; break;
      case 'probe': if (probe) tab.frameProbe = message.invoke; break;
      case 'isolationBroken':
        broken = true; src = undefined; tab.frameReady = false; tab.frameError = t('frame.isolationBroken'); break;
      case 'found':
        if (message.request === tab.frameSearch.request) { tab.frameSearch.n = message.n; tab.frameSearch.index = message.index; }
        break;
      case 'shortcut':
        if (message.key === 'raw') tab.mode = 'raw';
        else if (message.key === 'find') focusSearch?.();
        else if (message.key === 'escape' && tab.frameSearch.open) tab.frameSearch.open = false;
        else onShortcut?.(message.key);
        break;
      case 'link':
        if (message.kind === 'relative') void workspace.openLink(tab,message.href);
        else void openUrl(message.href).catch(cause => toasts.show(errorMessage(cause),'error'));
    }
  }
</script>
<svelte:window onmessage={receive} />
<div class="frame-layout" data-ready={tab.frameReady ? 'true' : undefined} data-probe={tab.frameProbe ?? undefined}>
  <FrameSearchBar {tab} ready={tab.frameReady} onFind={find} bind:focusSearch />
  <div class="content" data-focus-toc class:with-toc={showToc && tab.frameToc.length > 1}>
    {#if tab.frameError}<p class="error" role="alert">{tab.frameError}</p>
    {:else if src}<iframe bind:this={iframe} {src} sandbox="allow-scripts" title={tab.meta.title}
      onload={() => { tab.frameLoaded = true; }}></iframe>{/if}
    {#if showToc && tab.frameToc.length > 1}<aside data-focus-chrome><Toc entries={tab.frameToc} {activeId} onSelect={id => {activeId=id;post({type:'goto',id});}} /></aside>{/if}
  </div>
  {#if tab.frameBlocked}<div class="status" role="status">{t('frame.blocked',{n:tab.frameBlocked})}</div>{/if}
</div>
<style>
  .frame-layout { display:flex; flex-direction:column; height:100%; min-height:0; }
  .content { flex:1; display:grid; min-height:0; grid-template-columns:minmax(0,1fr); }
  .content.with-toc { grid-template-columns:minmax(0,1fr) 15rem; }
  iframe { width:100%; height:100%; border:0; background:white; }
  aside { overflow:auto; min-width:0; }
  .status { padding:0.3rem 0.7rem; font-size:0.85em; color:var(--text-muted); border-top:1px solid var(--border); }
  .error { color:var(--danger); padding:1rem; }
  @media(max-width:800px) { .content.with-toc { grid-template-columns:minmax(0,1fr) 11rem; } }
</style>
