import { spanAt, type Match, type TextSpan } from './search';

export interface TextIndex { root: HTMLElement; text: string; nodes: (TextSpan & { node: Text })[] }
const excluded = '[data-dviewer-ui],script,style,template,[hidden],.katex-mathml';
const boundaries = 'p,h1,h2,h3,h4,h5,h6,td,th,li,pre,summary,blockquote,div';

/** Closed details are searchable; the duplicated accessibility math tree is not. */
export function indexText(root: HTMLElement): TextIndex {
  const chunks: string[] = [], nodes: TextIndex['nodes'] = [];
  let length = 0, block: Element | null = null;
  const append = (text: string) => { chunks.push(text); length += text.length; };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
      const style = getComputedStyle(node);
      return node.matches(excluded) || style.display === 'none' || style.visibility === 'hidden'
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node; (node = walker.nextNode());) {
    if (node instanceof Element) { if (node.tagName === 'BR') append('\n'); continue; }
    if (!(node instanceof Text) || !node.data) continue;
    const next = node.parentElement?.closest(boundaries) ?? root;
    if (block && block !== next) append('\n');
    block = next;
    const start = length;
    append(node.data);
    nodes.push({ node, start, end: length });
  }
  return { root, text: chunks.join(''), nodes };
}

/** Separate ranges never paint the excluded controls between two text nodes. */
export function matchRanges(index: TextIndex, [start, end]: Match): Range[] {
  const ranges: Range[] = [];
  for (let i = spanAt(index.nodes, start); i < index.nodes.length && index.nodes[i].start < end; i++) {
    const span = index.nodes[i];
    const range = document.createRange();
    range.setStart(span.node, Math.max(start, span.start) - span.start);
    range.setEnd(span.node, Math.min(end, span.end) - span.start);
    ranges.push(range);
  }
  if (!ranges.length) {
    // A structural newline has no text node, but still needs a navigation anchor.
    const next = index.nodes[spanAt(index.nodes, start)], previous = index.nodes.at(-1);
    const range = document.createRange();
    if (next) range.setStart(next.node, 0);
    else if (previous) range.setStart(previous.node, previous.node.length);
    else range.setStart(index.root, 0);
    range.collapse(true);
    ranges.push(range);
  }
  return ranges;
}

export async function revealMatch(ranges: Range[], scroller: HTMLElement, current: () => boolean): Promise<void> {
  const range = ranges[0];
  if (!range || !current()) return;
  const closed = new Set<HTMLDetailsElement>();
  for (const part of ranges) {
    let element = part.startContainer.parentElement;
    while (element && element !== scroller) {
      if (element instanceof HTMLDetailsElement && !element.open) closed.add(element);
      element = element.parentElement;
    }
  }
  await Promise.all([...closed].map(details => new Promise<void>(resolve => {
    details.addEventListener('toggle', () => resolve(), { once: true });
    details.open = true;
  })));
  if (closed.size) {
    // Details toggles schedule table layout in a later frame. Wait for geometry,
    // not a fixed number of frames, before choosing the scroll destination.
    let previous = '', until = performance.now() + 500;
    while (current()) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const box = range.getBoundingClientRect();
      const geometry = `${box.top}:${box.height}:${scroller.scrollHeight}`;
      if (geometry === previous || performance.now() >= until) break;
      previous = geometry;
    }
  }
  if (!current()) return;
  const box = range.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  scroller.scrollTop += box.top - viewport.top - scroller.clientHeight / 2 + box.height / 2;
  // Rendered code has an inner horizontal viewport. Source uses the main one.
  const inner = range.startContainer.parentElement?.closest<HTMLElement>('pre,.table-viewport');
  if (inner && inner.scrollWidth > inner.clientWidth) {
    const bounds = inner.getBoundingClientRect();
    inner.scrollLeft += box.left - bounds.left - inner.clientWidth / 2 + box.width / 2;
  } else {
    const gutter = scroller.querySelector<HTMLElement>('.gutter')?.getBoundingClientRect().width ?? 0;
    scroller.scrollLeft += box.left - viewport.left - gutter - (scroller.clientWidth - gutter) / 2 + box.width / 2;
  }
}
