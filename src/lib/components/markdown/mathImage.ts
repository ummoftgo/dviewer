import katexCss from 'katex/dist/katex.min.css?raw';
import { rasterizeSvg, type PngImage } from './imageCopy';

// This module is loaded only for PNG copy; all bytes come from bundled assets.
const fonts = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', {
  query: '?inline', import: 'default', eager: true, exhaustive: true,
});
const css = katexCss.replace(/src:[^;}]+/g, declaration => {
  const file = declaration.match(/url\((fonts\/[^)]+\.woff2)\)/)?.[1];
  const url = file && fonts[`/node_modules/katex/dist/${file}`];
  if (!url?.startsWith('data:')) throw new Error('Bundled KaTeX font is missing');
  return `src:url("${url}") format("woff2")`;
});

export async function mathPng(root: HTMLElement): Promise<PngImage> {
  await document.fonts.ready;
  const math = root.querySelector<HTMLElement>('.katex-display');
  if (!root.isConnected || !math) throw new Error('Formula changed during copy');
  const box = math.getBoundingClientRect();
  const width = Math.max(box.width, math.scrollWidth);
  const computed = getComputedStyle(math);
  const clone = math.cloneNode(true) as HTMLElement;
  clone.querySelector('.katex-mathml')?.remove();
  clone.style.margin = '0';
  clone.style.padding = computed.padding;
  clone.style.overflow = 'visible';
  clone.style.width = `${width}px`;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.fontSize = computed.fontSize;
  wrapper.style.fontFamily = computed.fontFamily;
  wrapper.style.lineHeight = computed.lineHeight;
  wrapper.style.color = computed.color;
  const style = document.createElement('style');
  style.textContent = css;
  wrapper.append(style, clone);
  const html = new XMLSerializer().serializeToString(wrapper);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${box.height}" viewBox="0 0 ${width} ${box.height}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
  return rasterizeSvg(source, width, box.height);
}
