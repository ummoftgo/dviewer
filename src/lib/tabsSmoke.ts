import { tick } from 'svelte';

/**
 * No tab draws its name past its own close button.
 *
 * Run late in the smoke plan, when every earlier fixture is an open tab: the
 * strip is full, so every tab is at its narrowest, which is where a name's
 * unshrinking tail once painted over the close button. That the strip is full
 * is checked rather than assumed — a wide enough window would make this pass
 * without testing anything. Only boxes are compared, which every engine lays
 * out; the parts measured are the ones that clip their own content, so a
 * box's edge is where its drawing stops.
 */
export async function checkTabWidths(): Promise<{ tabs: number; narrowest: number }> {
  await tick();
  const strip = document.querySelector<HTMLElement>('.tabbar .strip');
  if (!strip) throw new Error('no tab strip');
  if (strip.scrollWidth <= strip.clientWidth + 1) throw new Error('tab strip is not full, so no tab is at its narrowest');
  const tabs = [...strip.querySelectorAll<HTMLElement>('.tab')];
  let narrowest = Infinity;
  for (const tab of tabs) {
    const box = tab.getBoundingClientRect();
    narrowest = Math.min(narrowest, box.width);
    const close = tab.querySelector<HTMLElement>('.close')?.getBoundingClientRect();
    if (!close) throw new Error('a tab has no close button');
    // The button sits at the tab's end, whatever the name's length: all that
    // is between them is the tab's own padding and border.
    const style = getComputedStyle(tab);
    const inset = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
    if (Math.abs(box.right - close.right - inset) > 1) {
      throw new Error(`tab "${tab.querySelector('.title')?.textContent?.trim()}" has its close button ${Math.round(box.right - close.right - inset)}px short of its end`);
    }
    for (const part of tab.querySelectorAll<HTMLElement>('.kind, .title, .head, .tail, .hint')) {
      const edge = part.getBoundingClientRect();
      if (edge.right > close.left + 0.5 || edge.left < box.left - 0.5) {
        throw new Error(`tab "${tab.querySelector('.title')?.textContent?.trim()}" draws ${part.className} past its bounds`);
      }
    }
  }
  return { tabs: tabs.length, narrowest: Math.round(narrowest) };
}

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

/**
 * The strip's `‹` and `›`: beside the strip rather than over its tabs, both
 * standing while it overflows, the one at an end disabled. Pressing one moves
 * the strip that way. Run with the strip full; where it was scrolled is put
 * back afterwards. Only attributes, boxes, scroll positions and clicks — the
 * states change once the strip's own scroll event has been measured, which is
 * what is waited for.
 */
export async function checkTabArrows(): Promise<{ moved: number }> {
  const strip = document.querySelector<HTMLElement>('.tabbar .strip');
  if (!strip) throw new Error('no tab strip');
  if (strip.scrollWidth <= strip.clientWidth + 1) throw new Error('tab strip is not full, so there is nothing to scroll');
  const arrow = (side: 'before' | 'after') => document.querySelector<HTMLButtonElement>(`[data-action="tab-scroll-${side}"]`);
  const before = arrow('before'), after = arrow('after');
  if (!before || !after) throw new Error('a full strip should show both arrows');
  const box = strip.getBoundingClientRect();
  if (before.getBoundingClientRect().right > box.left + 0.5 || after.getBoundingClientRect().left < box.right - 0.5) {
    throw new Error('the arrows are drawn over the tabs rather than beside the strip');
  }
  const saved = strip.scrollLeft;
  try {
    strip.scrollLeft = 0;
    await waitFor(() => before.disabled && !after.disabled, 'at the start, ‹ should be disabled and › live');
    after.click();
    await waitFor(() => strip.scrollLeft > 0 && !before.disabled, '› did not scroll the strip or wake ‹');
    const moved = strip.scrollLeft;
    strip.scrollLeft = strip.scrollWidth;
    await waitFor(() => after.disabled && !before.disabled, 'at the end, › should be disabled and ‹ live');
    before.click();
    await waitFor(() => strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1, '‹ did not scroll the strip back');
    return { moved: Math.round(moved) };
  } finally {
    strip.scrollLeft = saved;
  }
}
