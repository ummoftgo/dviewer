import { copyPng, copyText } from '../../clipboard';
import { t } from '../../i18n';
import { toasts } from '../../state/toast.svelte';

export function rasterSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Image has no visible dimensions');
  }
  const scale = Math.min(2, 4096 / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), reduced: scale < 2 };
}

/** Exported SVGs retain fragment references, never a network dependency. */
export function localSvgCss(css: string): string {
  return css.replace(/@import\s[^;]+;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, _quote: string, url: string) =>
      url.startsWith('#') || url.startsWith('data:') ? `url("${url}")` : 'none');
}

export function serializeDiagram(svg: SVGSVGElement): string {
  const box = svg.getBoundingClientRect();
  rasterSize(box.width, box.height); // Hidden diagrams cannot yield a useful image.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(box.width));
  clone.setAttribute('height', String(box.height));
  clone.style.removeProperty('max-width');
  const font = getComputedStyle(svg).fontFamily;
  clone.style.fontFamily = font;
  for (const node of clone.querySelectorAll('script,link,iframe,object,embed,video,audio,animate,animateMotion,animateTransform,set')) node.remove();
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'srcset' || attribute.name.startsWith('on') || attribute.name.startsWith('data-dviewer-')) {
        node.removeAttribute(attribute.name);
      } else if (['src', 'href', 'xlink:href'].includes(attribute.name)) {
        if (!attribute.value.startsWith('#') && !attribute.value.startsWith('data:')) node.removeAttribute(attribute.name);
      } else if (attribute.value.includes('url(') || attribute.value.includes('var(--font-ui)')) {
        node.setAttribute(attribute.name, localSvgCss(attribute.value.replaceAll('var(--font-ui)', font)));
      }
    }
    if (node.tagName.toLowerCase() === 'style') node.textContent = localSvgCss((node.textContent ?? '').replaceAll('var(--font-ui)', font));
  }
  return new XMLSerializer().serializeToString(clone);
}

export interface PngImage { blob: Blob; width: number; height: number; reduced: boolean }

export async function rasterizeSvg(source: string, width: number, height: number): Promise<PngImage> {
  const size = rasterSize(width, height);
  const image = new Image();
  // A blob URL with foreignObject taints the canvas in WebView2; data URLs do not.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(image, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
  return { ...size, blob };
}

export async function diagramPng(svg: SVGSVGElement): Promise<PngImage> {
  await document.fonts.ready;
  if (!svg.isConnected) throw new Error('Diagram changed during copy');
  const source = serializeDiagram(svg);
  const box = svg.getBoundingClientRect();
  return rasterizeSvg(source, box.width, box.height);
}

export async function copyImage(image: Promise<PngImage>): Promise<void> {
  try {
    // Start the clipboard write during the click; WebKit accepts a promised Blob.
    await copyPng(image.then(value => value.blob));
    const result = await image;
    toasts.show(t(result.reduced ? 'markdown.copy.pngReduced' : 'markdown.copy.pngDone', { width: result.width, height: result.height }));
  } catch { toasts.show(t('markdown.copy.imageFailed'), 'error'); }
}

export async function copyDiagram(svg: SVGSVGElement, format: 'svg' | 'png'): Promise<void> {
  if (format === 'png') return copyImage(diagramPng(svg));
  try {
    await document.fonts.ready;
    if (!svg.isConnected) throw new Error('Diagram changed during copy');
    await copyText(serializeDiagram(svg));
    toasts.show(t('markdown.copy.svgDone'));
  } catch { toasts.show(t('markdown.copy.imageFailed'), 'error'); }
}

export async function copyMath(root: HTMLElement, format: 'tex' | 'mathml' | 'png'): Promise<void> {
  if (format === 'png') return copyImage(import('./mathImage').then(module => module.mathPng(root)));
  try {
    const math = root.querySelector('math');
    const text = format === 'tex' ? root.dataset.dviewerMath
      : math ? new XMLSerializer().serializeToString(math) : undefined;
    if (text === undefined) throw new Error('Formula source is unavailable');
    await copyText(text);
    toasts.show(t(format === 'tex' ? 'markdown.copy.texDone' : 'markdown.copy.mathmlDone'));
  } catch { toasts.show(t('toast.copyFailed'), 'error'); }
}
