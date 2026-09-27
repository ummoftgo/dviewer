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
    for (const part of tab.querySelectorAll<HTMLElement>('.kind, .title, .head, .tail, .hint')) {
      const edge = part.getBoundingClientRect();
      if (edge.right > close.left + 0.5 || edge.left < box.left - 0.5) {
        throw new Error(`tab "${tab.querySelector('.title')?.textContent?.trim()}" draws ${part.className} past its bounds`);
      }
    }
  }
  return { tabs: tabs.length, narrowest: Math.round(narrowest) };
}
