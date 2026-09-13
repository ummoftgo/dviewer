import {tick} from 'svelte';
import {docLines, frameServed} from '../../ipc';
import {workspace, type DocTab} from '../../state/docs.svelte';
import {waitSearch} from '../markdown/searchSmoke';

const require = (ok: unknown, why: string) => {if(!ok)throw new Error(why);};

async function ready(tab: DocTab) {
  const load = `${tab.frameQuery}&probe=1`;
  await waitSearch(() => tab.frameReady && tab.frameReadyLoad === load && tab.frameProbe !== null, 'New HTML readiness or probe missing', 15000);
  require(tab.frameProbe === 'absent' || tab.frameProbe?.startsWith('rejected:'),'HTML isolation probe was executed or timed out');
  require(tab.frameAgentStarted, 'HTML agent start missing');
}

interface FixtureDetails {
  scriptRan?: boolean; moduleRan?: boolean; fontLoaded?: boolean;
  externalAttempted?: boolean; blocked?: number;
  cssApplied?: boolean; parentCssApplied?: boolean; imageLoaded?: boolean;
}

async function fixtureCheck(tab: DocTab): Promise<FixtureDetails> {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-layout iframe');
  require(frame?.contentWindow,'HTML iframe missing');
  const load = tab.frameReadyLoad;
  let details: FixtureDetails | undefined;
  const receive = (event: MessageEvent) => {
    if(event.source === frame!.contentWindow && event.data?.type === 'fixture-check' && event.data.load === load) details=event.data;
  };
  addEventListener('message',receive);
  try {
    frame!.contentWindow!.postMessage({type:'fixture-check'},'*');
    await waitSearch(() => !!details,'HTML fixture did not answer',10000);
    return details!;
  } finally { removeEventListener('message',receive); }
}

async function toggle(tab: DocTab, allow: boolean) {
  const before = tab.frameQuery;
  const button = document.querySelector<HTMLButtonElement>('[data-action="frame-external"]');
  require(button && !button.disabled, 'HTML external-resource toggle unavailable');
  button!.click();
  await waitSearch(() => tab.frameExternal === allow && tab.frameQuery !== before, 'HTML permission did not change');
  await ready(tab);
  const details = await fixtureCheck(tab);
  require(details.externalAttempted === true, 'New HTML did not attempt the external fetch');
  if (allow) require(details.blocked === 0 && tab.frameBlocked === 0, 'Allowed HTML still blocked an external resource');
  else {
    await waitSearch(() => tab.frameBlocked > 0, 'Strict HTML did not block the external resource');
    require((details.blocked ?? 0) > 0, 'Strict fixture did not observe the violation');
  }
  return tab.frameBlocked;
}

async function archiveSiblings(from: DocTab) {
  require(from.meta.baseDir, 'HTML fixture directory missing');
  const archive = await workspace.openPath(`${from.meta.baseDir}/archive.zip`);
  require(archive, 'HTML archive fixture did not open');
  let page: DocTab | null = null;
  try {
    await waitSearch(() => archive!.nameEncoding !== null, 'HTML archive listing missing');
    const entry = archive!.entries.find(entry => entry.name === 'docs/page.html');
    require(entry, 'Archive HTML entry missing');
    page = await workspace.openEntry(archive!, entry!);
    require(page, 'Archive HTML entry did not open');
    await ready(page!);
    const details = await fixtureCheck(page!);
    require(details.cssApplied === true && details.parentCssApplied === true && details.imageLoaded === true, 'Archive CSS, parent-directory CSS or image did not load');
    return {cssApplied:details.cssApplied, parentCssApplied:details.parentCssApplied, imageLoaded:details.imageLoaded};
  } finally {
    if (page) await workspace.close(page.id);
    if (archive) await workspace.close(archive.id);
    workspace.activate(from.id);
  }
}

export async function checkHtmlFrame(tab: DocTab) {
  await ready(tab);
  await waitSearch(() => tab.frameBlocked > 0, 'HTML blocked resource missing');
  require(tab.frameToc.length === 3,'HTML heading count changed');
  try {
    const details = await fixtureCheck(tab);
    require(details?.scriptRan && details.moduleRan && details.fontLoaded,'HTML inline script, module or local font did not load');
    const allowedBlocked = await toggle(tab, true);
    const blockedAgain = await toggle(tab, false);
    const frame = document.querySelector<HTMLIFrameElement>('.frame-layout iframe');
    const request=++tab.frameSearch.request;
    frame!.contentWindow!.postMessage({type:'find',q:'needle',dir:1,request},'*');
    await waitSearch(() => tab.frameSearch.n >= 1,'HTML find did not return a match');
    tab.mode='raw'; await tick();
    await waitSearch(() => !!document.querySelector('.text-raw-view .line-text'),'HTML source did not use the line-indexed view');
    const page=await docLines(tab.id,0,5);
    require(page.lines?.some(line=>line.includes('doctype')),'HTML source lines missing');
    require(!frame!.isConnected && !document.querySelector('.frame-layout iframe'),'HTML iframe survived source switch');
    const afterUnmount = await frameServed(tab.id);
    const started = performance.now();
    // An observation window for late requests, not a rendering readiness delay.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const afterIdle = await frameServed(tab.id);
    const idleMs = Math.round(performance.now() - started);
    require(afterUnmount.html === afterIdle.html && afterUnmount.agent === afterIdle.agent && afterUnmount.resource === afterIdle.resource,
      `HTML requests continued after unmount: ${JSON.stringify({afterUnmount, afterIdle, idleMs})}`);
    const metrics = {probe:tab.frameProbe,headings:tab.frameToc.length,matches:tab.frameSearch.n,scriptRan:!!details?.scriptRan,moduleRan:!!details?.moduleRan,fontLoaded:!!details?.fontLoaded,rawLines:page.total,allowedBlocked,blockedAgain,afterUnmount,afterIdle,idleMs};
    return {...metrics,archive:await archiveSiblings(tab)};
  } finally {
    // Keep the smoke document unmounted, including when an earlier check failed.
    tab.mode='raw';
    if (tab.frameExternal) await tab.setFrameExternal(false);
    await tick();
  }
}
