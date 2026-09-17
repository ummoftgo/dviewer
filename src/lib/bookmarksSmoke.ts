import { tick } from 'svelte';
import { readBookmarks } from './bookmarks';
import { getValue, setValue } from './persist';
import { bookmarks } from './state/bookmarks.svelte';
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
