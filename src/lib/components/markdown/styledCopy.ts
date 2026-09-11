export const STYLED_HTML_LIMIT = 4 * 1024 * 1024;
export const COPY_STYLES = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'margin', 'padding', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-collapse', 'text-align', 'white-space', 'text-decoration-line', 'list-style-type', 'list-style-position'] as const;

export function inlineStyles(computed: Record<string, string>, defaults: Record<string, string>): string {
  const normalize = (property: string, value: string) => property.startsWith('border-')
    ? value.replace(/^0px (none|hidden) .+$/, '0px $1') : value;
  return COPY_STYLES.filter(property => computed[property]
    && normalize(property, computed[property]) !== normalize(property, defaults[property] ?? ''))
    .map(property => `${property}:${computed[property]};`).join('');
}

export function rootThemeStyles(theme: Pick<CSSStyleDeclaration, 'getPropertyValue'>): string {
  return inlineStyles({
    color: theme.getPropertyValue('--text').trim(),
    'background-color': theme.getPropertyValue('--bg').trim(),
    'font-family': theme.getPropertyValue('--font-body').trim(),
  }, {});
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export function limitStyledHtml(styled: string, original: string, limit = STYLED_HTML_LIMIT) {
  return bytes(styled) > limit ? { html: original, limited: true } : { html: styled, limited: false };
}

const elements = (root: HTMLElement) => [root, ...root.querySelectorAll<HTMLElement>('*')];
function preventLoads(root: HTMLElement) {
  for (const node of elements(root)) for (const attribute of ['src', 'srcset', 'poster', 'href', 'xlink:href', 'data', 'background']) {
    if (attribute === 'href' && node.tagName === 'A') continue;
    node.removeAttribute(attribute);
  }
}

/** Measure the styled clone; write only into the inert export tree. */
export async function styledHtml(html: string, limit = STYLED_HTML_LIMIT): Promise<{ html: string; limited: boolean }> {
  const template = document.createElement('template');
  template.innerHTML = '<article class="markdown-body"></article>';
  const output = template.content.firstElementChild as HTMLElement;
  output.innerHTML = html;
  const source = output.cloneNode(true) as HTMLElement;
  const baseline = output.cloneNode(true) as HTMLElement;
  preventLoads(source);
  preventLoads(baseline);
  const targets = elements(output), sources = elements(source), defaults = elements(baseline);
  for (const root of [output, baseline]) for (const node of elements(root)) {
    for (const attribute of [...node.attributes]) {
      if (['class', 'style'].includes(attribute.name) || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
    }
  }
  // UA styles remain (h1, strong, lists); inherited values come from exported parents.
  for (const node of defaults) node.style.all = 'revert';
  baseline.style.all = 'initial';
  let lowerBound = bytes(output.outerHTML);
  if (lowerBound > limit) return { html, limited: true };
  const host = document.createElement('div');
  host.dataset.dviewerUi = 'copy-measure';
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style;';
  host.append(source, baseline);
  document.body.append(host);
  try {
    await document.fonts.ready;
    const rootTheme = rootThemeStyles(getComputedStyle(document.documentElement));
    for (let index = 0; index < targets.length; index++) {
      const actual = getComputedStyle(sources[index]), normal = getComputedStyle(defaults[index]);
      const values = (style: CSSStyleDeclaration) => Object.fromEntries(COPY_STYLES.map(property => [property, style.getPropertyValue(property)]));
      // The export root owns its theme even when an engine reports default values.
      const inline = inlineStyles(values(actual), values(normal)) + (index === 0 ? rootTheme : '');
      if (!inline) continue;
      targets[index].style.cssText = inline;
      defaults[index].style.cssText += inline;
      // This is a lower bound: final serialization also counts escaped attribute bytes.
      lowerBound += bytes(targets[index].style.cssText);
      if (lowerBound > limit) return { html, limited: true };
    }
    return limitStyledHtml(output.outerHTML, html, limit);
  } finally { host.remove(); }
}
