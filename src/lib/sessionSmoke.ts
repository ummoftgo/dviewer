import {tick} from 'svelte';
import {getValue,setValue} from './persist';
import {captureSession,Session} from './state/session.svelte';
import {workspace,type DocTab} from './state/docs.svelte';
import {waitSearch} from './components/markdown/searchSmoke';

const require = (ok:unknown,why:string) => {if (!ok) throw new Error(why);};
const scroller = () => document.querySelector<HTMLElement>('[data-position-ready="true"] .scroller');

/** Exercise the real snapshot/store/start path without depending on the user's session. */
export async function checkSessionPosition(first: DocTab) {
  const previous = await getValue('session');
  const saved = new Session(); saved.ready = true;
  let current = first;
  const restore = async () => {
    await saved.save(captureSession([current],current.id));
    const oldId = current.id;
    await workspace.close(oldId);
    await new Session().start({files:[],urls:[]},true,false);
    const opened = workspace.active;
    require(opened && opened.id !== oldId,'Session did not reopen a fresh document');
    current = opened!;
    await waitSearch(() => current.pendingPosition === undefined,'Session position was not consumed',15000);
  };
  try {
    await waitSearch(() => !!scroller() && (scroller()!.scrollHeight - scroller()!.clientHeight) > 1000,'Session fixture layout missing',15000);
    const host = scroller()!;
    host.scrollTop = (host.scrollHeight - host.clientHeight) * 0.55;
    await waitSearch(() => first.position?.kind === 'prose' && !!first.position.heading && first.scrollTop > 100,'Session scroll was not captured');
    const expected = host.scrollTop;
    await restore();
    await waitSearch(() => !!scroller(),'Restored markdown layout missing',15000);
    const actual = scroller()!.scrollTop;
    require(actual > 100 && Math.abs(actual - expected) < 12,'Session restored before layout or lost its heading offset');
    require(document.querySelector('.position-status')?.textContent,'Session restoration status missing');
    current.mode = 'raw'; await tick();
    await waitSearch(() => !!document.querySelector('.raw-view .source'),'Session source view missing');
    const rawHost = document.querySelector<HTMLElement>('.raw-view')!.closest<HTMLElement>('.scroller')!;
    rawHost.scrollTop = 900;
    await waitSearch(() => current.rawPosition?.kind === 'raw' && current.rawPosition.line > 0,'Raw line was not captured');
    const line = current.rawPosition?.kind === 'raw' ? current.rawPosition.line : 0;
    await restore();
    await waitSearch(() => current.rawPosition?.kind === 'raw','Restored source line missing');
    require(current.mode === 'raw' && current.rawPosition?.kind === 'raw' && current.rawPosition.line === line,
      'Session source line or mode did not survive reopening');
    return {renderedTop:actual,sourceLine:line};
  } finally {
    saved.ready = false;
    await workspace.close(current.id);
    await setValue('session',previous ?? null);
  }
}
