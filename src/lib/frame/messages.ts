import type { TocEntry } from '../ipc';

export const PDF_STAGES = ['start','webviewerloaded','worker-start','worker-imported','initializedPromise',
  'documentinit','pagesinit','pagesloaded','onePageRendered'] as const;
export type PdfStage = typeof PDF_STAGES[number];
export type InitStep = 'not-started' | 'pending' | 'resolved' | 'rejected';
export interface FrameStall {
  readyState: string; l10n: string; pdfViewer: boolean; preferences: boolean; initialized: boolean;
  options: number | null; locale: string | null; language: string | null; fonts: string | null;
  navigationStatus: number | null;
  steps: {initialize: InitStep; preferences: InitStep; l10n: InitStep; components: InitStep};
  resources: {name: string; responseStatus: number | null; duration: number | null; transferSize: number | null}[];
}
export type FrameMessage =
  | { type: 'agentStart' }
  | { type: 'stage'; name: PdfStage }
  | { type: 'stall'; snapshot: FrameStall }
  | { type: 'loaded'; scrollable: boolean }
  | { type: 'ready'; title: string; headings: TocEntry[]; pages?: number }
  | { type: 'page'; n: number }
  | { type: 'pageText'; page: number; hasText: boolean }
  | { type: 'error'; code: 'pdfEncrypted' | 'pdfFailed'; detail?: string }
  | { type: 'scroll'; ratio: number }
  | { type: 'blocked'; n: number }
  | { type: 'found'; n: number; index: number; request: number }
  | { type: 'link'; href: string; kind: 'external' | 'relative' }
  | { type: 'probe'; invoke: string }
  | { type: 'isolationBroken' }
  | { type: 'shortcut'; key: 'find' | 'raw' | 'escape' | 'focus' };
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function parseStall(value: unknown): FrameStall | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const nullableCount = (n: unknown) => n === null || count(n);
  const status = (n: unknown) => n === null || (count(n) && n <= 599);
  const word = (s: unknown) => s === null || (text(s,64) && !/[\u0000-\u001f\u007f]/.test(s));
  if (!text(v.readyState,16) || !['loading','interactive','complete'].includes(v.readyState)
    || !text(v.l10n,16) || !['undefined','object','function','boolean','number','string','symbol','bigint'].includes(v.l10n)
    || typeof v.pdfViewer !== 'boolean' || typeof v.preferences !== 'boolean' || typeof v.initialized !== 'boolean'
    || !nullableCount(v.options) || !word(v.locale) || !word(v.language) || !word(v.fonts) || !status(v.navigationStatus)
    || !v.steps || typeof v.steps !== 'object' || !Array.isArray(v.resources) || v.resources.length > 15) return null;
  const steps = v.steps as FrameStall['steps'];
  for (const key of ['initialize','preferences','l10n','components'] as const) {
    if (!['not-started','pending','resolved','rejected'].includes(steps[key])) return null;
  }
  const resources: FrameStall['resources'] = [];
  for (const entry of v.resources) {
    if (!entry || !text(entry.name,128) || !entry.name.startsWith('/') || /[\u0000-\u0020\u007f?:#\\]|[a-f\d]{64}/i.test(entry.name)
      || !status(entry.responseStatus) || !nullableCount(entry.duration) || !nullableCount(entry.transferSize)) return null;
    resources.push({name:entry.name,responseStatus:entry.responseStatus,duration:entry.duration,transferSize:entry.transferSize});
  }
  const snapshot = {readyState:v.readyState,l10n:v.l10n,pdfViewer:v.pdfViewer,preferences:v.preferences,initialized:v.initialized,
    options:v.options,locale:v.locale,language:v.language,fonts:v.fonts,navigationStatus:v.navigationStatus,
    steps:{initialize:steps.initialize,preferences:steps.preferences,l10n:steps.l10n,components:steps.components},resources} as FrameStall;
  return JSON.stringify(snapshot).length <= 4096 ? snapshot : null;
}

export function linkKind(href: string): 'external' | 'relative' | null {
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return 'external';
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href) || /[\u0000-\u001f\u007f]/.test(href)) return null;
  return 'relative';
}

export function parseFrameMessage(value: unknown): FrameMessage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'agentStart': return {type:'agentStart'};
    case 'stage': return PDF_STAGES.some(name => name === v.name) ? {type:'stage',name:v.name as PdfStage} : null;
    case 'stall': {
      const snapshot = parseStall(v.snapshot);
      return snapshot ? {type:'stall',snapshot} : null;
    }
    case 'loaded': return typeof v.scrollable === 'boolean' ? {type:'loaded',scrollable:v.scrollable} : null;
    case 'ready': {
      if (v.pages !== undefined && (!count(v.pages) || v.pages < 1)) return null;
      if (!text(v.title,4096) || !Array.isArray(v.headings) || v.headings.length > 10000) return null;
      const headings: TocEntry[] = [], ids = new Set<string>();
      for (const item of v.headings) {
        if (!item || typeof item !== 'object' || !text(item.id,2048) || !item.id || ids.has(item.id)
          || !text(item.text,4096) || !Number.isInteger(item.level) || item.level < 1 || item.level > 6) return null;
        ids.add(item.id); headings.push({id:item.id, level:item.level, text:item.text});
      }
      return {type:'ready',title:v.title,headings,...(v.pages === undefined ? {} : {pages:v.pages as number})};
    }
    case 'page': return count(v.n) && v.n >= 1 ? {type:'page',n:v.n} : null;
    case 'pageText': return count(v.page) && v.page >= 1 && typeof v.hasText === 'boolean' ? {type:'pageText',page:v.page,hasText:v.hasText} : null;
    case 'error': return (v.code === 'pdfEncrypted' || v.code === 'pdfFailed') && (v.detail === undefined || text(v.detail,4096))
      ? {type:'error',code:v.code,...(v.detail === undefined ? {} : {detail:v.detail as string})} : null;
    case 'scroll': return typeof v.ratio === 'number' && Number.isFinite(v.ratio) && v.ratio >= 0 && v.ratio <= 1 ? {type:'scroll',ratio:v.ratio} : null;
    case 'blocked': return count(v.n) ? {type:'blocked',n:v.n} : null;
    case 'found': return count(v.n) && v.n <= 100000 && count(v.index) && v.index <= v.n && count(v.request)
      ? {type:'found',n:v.n,index:v.index,request:v.request} : null;
    case 'link': return text(v.href,8192) && linkKind(v.href) === v.kind
      ? {type:'link',href:v.href,kind:v.kind as 'external' | 'relative'} : null;
    case 'probe': return text(v.invoke,4200) && (v.invoke === 'absent' || v.invoke === 'timeout' || v.invoke.startsWith('rejected:'))
      ? {type:'probe',invoke:v.invoke} : null;
    case 'shortcut': return v.key === 'find' || v.key === 'raw' || v.key === 'escape' || v.key === 'focus' ? {type:'shortcut',key:v.key} : null;
    case 'isolationBroken': return {type:'isolationBroken'};
    default: return null;
  }
}

export function frameMessage(event: Pick<MessageEvent, 'source' | 'data'>, frame: Window | null, load: string): FrameMessage | null {
  return frame !== null && event.source === frame && load !== '' && event.data?.load === load ? parseFrameMessage(event.data) : null;
}

export function frameLocation(base: string, query: string, probe: boolean): string {
  const url = new URL(base);
  for (const [key,value] of new URLSearchParams(query)) url.searchParams.set(key,value);
  if (probe) url.searchParams.set('probe','1');
  return url.href;
}
