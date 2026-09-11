import { copyDiagram } from './imageCopy';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };

export async function checkDiagramCopy(): Promise<void> {
  const svg = document.querySelector<SVGSVGElement>('article.markdown-body .mermaid-block svg');
  require(svg, 'rendered Mermaid SVG is missing');
  const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'write');
  const textDescriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
  let text = '';
  let items: ClipboardItems = [];
  try {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (value: string) => { text = value; } });
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (value: ClipboardItems) => {
      items = value;
      await value[0].getType('image/png');
    } });
    // The production path waits for fonts and Image.decode, then the promised Blob.
    await copyDiagram(svg!, 'svg');
    require(text.startsWith('<svg'), 'SVG copy did not supply SVG source');
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    require(!parsed.querySelector('parsererror'), 'copied SVG is invalid XML');
    const box = svg!.getBoundingClientRect();
    require(Number(parsed.documentElement.getAttribute('width')) === box.width && Number(parsed.documentElement.getAttribute('height')) === box.height, 'SVG copy lost its displayed dimensions');
    require(!text.includes('var(--font-ui)'), 'SVG copy retained an app font variable');
    await copyDiagram(svg!, 'png');
    require(items.length === 1 && items[0].types.includes('image/png'), 'PNG copy did not supply its MIME type');
    const blob = await items[0].getType('image/png');
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    require(blob.size > 8 && signature.join(',') === '137,80,78,71,13,10,26,10', 'copied image is not a PNG');
  } finally {
    if (descriptor) Object.defineProperty(navigator.clipboard, 'write', descriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'write');
    if (textDescriptor) Object.defineProperty(navigator.clipboard, 'writeText', textDescriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'writeText');
  }
}
