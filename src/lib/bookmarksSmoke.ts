import { tick } from 'svelte';
import { readBookmarks, type BookmarkTarget } from './bookmarks';
import { bookmarkFingerprint, treeRows, treePositionPath } from './ipc';
import { getValue, setValue } from './persist';
import { bookmarks, bookmarkTarget } from './state/bookmarks.svelte';
import { workspace, type DocTab } from './state/docs.svelte';
import { waitSearch } from './components/markdown/searchSmoke';

const require = (ok: unknown, why: string) => { if (!ok) throw new Error(why); };
const button = (action: string) => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
const scroller = () => document.querySelector<HTMLElement>('main [data-position-ready="true"] .scroller');

export async function checkBookmarks(first: DocTab) {
  await bookmarks.flush();
  const previous = await getValue('bookmarks');
  const previousEntries = readBookmarks(bookmarks.entries), previousResults = {...bookmarks.results};
  const previousTabs = new Set(workspace.tabs.map(tab => tab.id));
  const wasOpen = button('bookmarks-toggle')?.getAttribute('aria-pressed') === 'true';
  let current = first, other: DocTab | undefined;
  let alignment: {gap:number; margin:number} | null = null;
  try {
    require(bookmarks.ready, 'Bookmark store did not load');
    bookmarks.clear(); await bookmarks.flush();
    await waitSearch(() => !!scroller() && first.toc.length >= 2 && !button('bookmark-add')?.disabled,
      'Bookmark fixture or add button is not ready',15000);
    const second = first.toc[1];
    const host = scroller()!, heading = document.getElementById(second.id)!;
    const middle = heading.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientTop + host.scrollTop + 100;
    host.scrollTop = middle;
    host.dispatchEvent(new Event('scroll'));
    require(Math.abs(host.scrollTop - middle) < 2, 'Bookmark fixture did not scroll into its second section');
    // Click before the heading tracker's animation frame, just as a scroll followed by Add can do.
    button('bookmark-add')!.click();
    await waitSearch(() => !!document.querySelector<HTMLInputElement>('[data-action="bookmark-label"]'), 'Bookmark label editor missing');
    const input = document.querySelector<HTMLInputElement>('[data-action="bookmark-label"]')!;
    require(input.value === second.text, 'Bookmark default label is not the current heading');
    input.form!.requestSubmit();
    await waitSearch(() => bookmarks.entries.length === 1 && !!button('bookmark-open'), 'Bookmark row missing after save');
    const item = bookmarks.entries[0];
    require(item.anchor.id === second.id && item.label === second.text, 'Bookmark saved the wrong heading');
    await bookmarks.flush();
    require(readBookmarks(await getValue('bookmarks'))[0]?.id === item.id, 'Bookmark did not reach the store');
    const third = first.toc[2], keyboardHost = scroller()!, keyboardHeading = document.getElementById(third.id)!;
    keyboardHost.scrollTop += keyboardHeading.getBoundingClientRect().top - keyboardHost.getBoundingClientRect().top - keyboardHost.clientTop + 100;
    keyboardHost.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true}));
    await waitSearch(() => document.querySelector<HTMLInputElement>('[data-action="bookmark-label"]')?.value === third.text,
      'Ctrl+D did not capture the current section with the panel already open');
    document.querySelector<HTMLInputElement>('[data-action="bookmark-label"]')!.form!.requestSubmit();
    await waitSearch(() => bookmarks.entries.length === 2, 'Ctrl+D bookmark did not save');
    require(bookmarks.entries[1].anchor.id === third.id, 'Ctrl+D saved the wrong heading');
    bookmarks.remove(bookmarks.entries[1].id);
    await tick();
    button('bookmarks-all')!.click(); await tick();
    other = workspace.newTab(); await tick();
    await waitSearch(() => !!document.querySelector('main .start-pane') || !scroller(), 'Other tab did not render');
    // A saved tab pixel offset must not make broken bookmark navigation look correct.
    first.scrollTop = 0;
    button('bookmark-open')!.click();
    await waitSearch(() => workspace.activeId === first.id && first.pendingAnchor === null
      && bookmarks.results[item.id] === true && !!scroller() && first.scrollTop > 100,
      'Bookmark navigation did not finish at its heading',15000);
    const aligned = () => {
      const host = scroller(), heading = document.getElementById(second.id);
      if (!host || !heading) return false;
      alignment = {gap:heading.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientTop,
        margin:parseFloat(getComputedStyle(heading).scrollMarginTop) || 0};
      return Math.abs(alignment.gap - alignment.margin) < 3;
    };
    await waitSearch(aligned, 'Bookmark scroll offset does not match the second heading');
    const returnedTop = scroller()!.scrollTop;
    // The same row also reopens a closed source, with no cached document to scroll.
    await workspace.close(first.id); await tick();
    button('bookmark-open')!.click();
    await waitSearch(() => !!workspace.active && workspace.active.id !== first.id && workspace.active.kind === 'markdown'
      && workspace.active.pendingAnchor === null && !!scroller() && workspace.active.scrollTop > 100,
      'Bookmark did not reopen a closed document at its heading',15000);
    current = workspace.active!;
    await waitSearch(aligned, 'Reopened bookmark is not aligned with its heading');
    button('bookmark-delete')!.click();
    await waitSearch(() => bookmarks.entries.length === 0 && !button('bookmark-open'), 'Bookmark deletion left a row');
    await bookmarks.flush();
    require(readBookmarks(await getValue('bookmarks')).length === 0, 'Bookmark deletion did not reach the store');
    return {heading:second.id,keyboardHeading:third.id,returnedTop,reopened:current.id !== first.id,alignment};
  } catch (cause) {
    throw new Error(`${String(cause)}; alignment=${JSON.stringify(alignment)}`);
  } finally {
    await bookmarks.flush();
    bookmarks.entries = previousEntries; bookmarks.results = previousResults;
    await setValue('bookmarks',previous ?? null);
    if (other && !previousTabs.has(other.id)) await workspace.close(other.id);
    if (current.id !== first.id) await workspace.close(current.id);
    if (workspace.tabs.includes(first)) workspace.activate(first.id);
    await tick();
    const open = !!document.querySelector('.bookmarks-panel');
    if (open !== wasOpen) document.dispatchEvent(new KeyboardEvent('keydown',{key:'B',ctrlKey:true,shiftKey:true,bubbles:true}));
  }
}


/** Native typed-location navigation, reopen, mismatch and reassignment without loading full values. */
export async function checkLocationBookmarks(first: DocTab) {
  await bookmarks.flush();
  const previous = await getValue('bookmarks');
  const entries = readBookmarks(bookmarks.entries), results = {...bookmarks.results};
  let current = first;
  try {
    require(bookmarks.ready,'Location bookmark store not ready');
    const source = first.meta.source;
    require(source.type === 'file' || source.type === 'url','Location bookmark requires a durable source');
    if (source.type !== 'file' && source.type !== 'url') throw new Error('Unsupported source');
    let target: BookmarkTarget['target'];
    if (first.view === 'tree') {
      const rows = await treeRows(first.id,0,3);
      const path = await treePositionPath(first.id,rows[Math.min(1,rows.length - 1)].id);
      require(path,'Tree source path is unavailable');
      target = {kind:'tree',path:path!};
    } else if (first.kind === 'pdf') {
      await waitSearch(() => first.frameContentLoaded && first.framePages > 0,'PDF bookmark frame is not ready',15000);
      target = {kind:'pdf',page:Math.min(2,first.framePages)};
    } else {
      const count = first.tableStats?.rowCount ?? first.gridStats?.rowCount ?? 0;
      require(count > 0,'Grid bookmark has no rows');
      const row = Math.min(2,count - 1), modes = first.tableStats ? {plain:first.tableStats.plain,expanded:first.tableStats.expanded} : {};
      target = first.kind === 'text' ? {kind:'log',line:row,...modes}
        : {kind:'grid',row,...(first.collection ? {collection:first.collection} : {}),
          ...(first.tableStats ? {hasHeader:first.tableStats.hasHeader} : {}),...modes};
    }
    const item = bookmarks.add(source,{id:'',text:''},'native location bookmark',target,await bookmarkFingerprint(first.id));
    require(item,'Typed bookmark did not save');
    const arrived = () => bookmarks.results[item!.id] === true && current.pendingBookmark === null
      && (target!.kind === 'pdf' ? current.framePage === target!.page
        : target!.kind === 'tree' ? current.position?.kind === 'tree' && current.position.path === target!.path
        : current.selectedCell?.sourceRow === (target!.kind === 'grid' ? target!.row : target!.line));
    for (let attempt = 0; attempt < 2; attempt++) {
      delete bookmarks.results[item!.id];
      await bookmarks.open(item!);
      await waitSearch(arrived,'Typed bookmark did not complete repeat navigation',15000);
    }
    await bookmarks.flush();
    require(readBookmarks(await getValue('bookmarks')).some(saved => saved.id === item!.id && !!saved.target),'Typed bookmark was not persisted');
    await workspace.close(first.id); await tick();
    delete bookmarks.results[item!.id];
    await bookmarks.open(item!); current = workspace.active!;
    require(current.id !== first.id,'Typed bookmark did not reopen the closed document');
    await waitSearch(arrived,'Typed bookmark did not navigate after reopen',15000);
    await bookmarks.open({...item!,fingerprint:item!.fingerprint + ':changed'});
    require(bookmarks.results[item!.id] === false && current.pendingBookmark === null,'Changed source fingerprint did not mark mismatch');
    await waitSearch(() => !!bookmarkTarget(current),'Reopened view does not supply a current location',15000);
    require(await bookmarks.reassignCurrent(item!.id,current),'Typed bookmark reassignment failed');
    require(bookmarks.results[item!.id] === true && bookmarks.entries.find(saved => saved.id === item!.id)?.created === item!.created,
      'Reassignment did not preserve bookmark identity');
    return {kind:target.kind,repeated:2,reopened:true,mismatch:true,reassigned:true};
  } finally {
    await bookmarks.flush(); bookmarks.entries = entries; bookmarks.results = results;
    await setValue('bookmarks',previous ?? null);
    if (current.id !== first.id) await workspace.close(current.id);
  }
}
