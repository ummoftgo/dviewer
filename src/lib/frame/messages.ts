import type { TocEntry } from '../ipc';
import {frameDiagnosticText} from './diagnostics';
import {isPdfRotation} from '../position';

export const PDF_STAGES = ['start','webviewerloaded','worker-start','worker-imported','initializedPromise',
  'documentinit','pagesinit','pagesloaded','onePageRendered'] as const;
export type PdfStage = typeof PDF_STAGES[number];
export type InitStep = 'not-started' | 'pending' | 'resolved' | 'rejected';
export interface FrameStallSnapshot {
  readyState: string; l10n: string; pdfViewer: boolean; preferences: boolean; initialized: boolean;
  options: number | null; locale: string | null; language: string | null; fonts: string | null;
  navigationStatus: number | null;
  steps: {initialize: InitStep; preferences: InitStep; l10n: InitStep; components: InitStep};
  resources: {name: string | null; responseStatus: number | null; duration: number | null; transferSize: number | null}[];
}
export type FrameStall = FrameStallSnapshot | {raw: string};
export const ORIENTATION_REASONS = ['timeout','sparse','ambiguous','upright','sideways','disagree','error'] as const;
/** One page's verdict from the image orientation probe, kept for diagnostics. */
export interface FrameOrientation {
  page: number; ms: number; ink: number | null; rowEnergy: number | null; colEnergy: number | null;
  decision: 0 | 270 | null; start: number | null; end: number | null; direction: 90 | 270 | null;
  reason: typeof ORIENTATION_REASONS[number];
}
export type FrameMessage =
  | { type: 'agentStart' }
  | { type: 'stage'; name: PdfStage }
  | { type: 'stall'; snapshot: FrameStall }
  | { type: 'loaded'; scrollable: boolean }
  | { type: 'ready'; title: string; headings: TocEntry[]; pages?: number }
  | { type: 'page'; n: number }
  | { type: 'rotated'; deg: number; auto: boolean; image?: boolean }
  | ({ type: 'orientation' } & FrameOrientation)
  | { type: 'pageText'; page: number; hasText: boolean }
  | { type: 'error'; code: 'pdfEncrypted' | 'pdfFailed'; detail?: string }
  | { type: 'scroll'; ratio: number }
  | { type: 'heading'; id: string }
  | { type: 'gone'; request: number; found: boolean }
  | { type: 'blocked'; n: number }
  | { type: 'found'; n: number; index: number; request: number }
  | { type: 'link'; href: string; kind: 'external' | 'relative' }
  | { type: 'probe'; invoke: string }
  | { type: 'isolationBroken' }
  | { type: 'shortcut'; key: 'find' | 'raw' | 'escape' | 'focus' | 'bookmark' | 'bookmarks' };
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function parseStall(value: unknown): FrameStallSnapshot | null {
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
  const steps = v.steps as FrameStallSnapshot['steps'];
  for (const key of ['initialize','preferences','l10n','components'] as const) {
    if (!['not-started','pending','resolved','rejected'].includes(steps[key])) return null;
  }
  const resources: FrameStallSnapshot['resources'] = [];
  for (const entry of v.resources) {
    if (!entry || typeof entry !== 'object') return null;
    const name = entry.name ?? null, responseStatus = entry.responseStatus ?? null;
    const duration = entry.duration ?? null, transferSize = entry.transferSize ?? null;
    if ((name !== null && (!text(name,128) || !name.startsWith('/') || /[\u0000-\u0020\u007f?:#\\]|[a-f\d]{64}/i.test(name)))
      || !status(responseStatus) || (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0))
      || !nullableCount(transferSize)) return null;
    resources.push({name,responseStatus,duration,transferSize});
  }
  const snapshot = {readyState:v.readyState,l10n:v.l10n,pdfViewer:v.pdfViewer,preferences:v.preferences,initialized:v.initialized,
    options:v.options,locale:v.locale,language:v.language,fonts:v.fonts,navigationStatus:v.navigationStatus,
    steps:{initialize:steps.initialize,preferences:steps.preferences,l10n:steps.l10n,components:steps.components},resources} as FrameStallSnapshot;
  return JSON.stringify(snapshot).length <= 8192 ? snapshot : null;
}

function rawStall(value: unknown): {raw: string} {
  // Bound traversal too: a diagnostic fallback must not serialize an arbitrary object graph.
  let visited = 0;
  const preview = (item: unknown): unknown => {
    if (++visited > 32) return '[truncated]';
    if (typeof item === 'string') return item.slice(0,8192);
    if (typeof item === 'bigint') return String(item);
    if (Array.isArray(item)) return item.slice(0,15).map(preview);
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const key in item) {
        if (visited >= 32) break;
        if (Object.hasOwn(item,key)) result[key.slice(0,128)] = preview((item as Record<string,unknown>)[key]);
      }
      return result;
    }
    return item;
  };
  try {
    const raw = value && typeof value === 'object' && 'raw' in value && typeof value.raw === 'string'
      ? value.raw.slice(0,8192) : JSON.stringify(preview(value)) ?? String(value);
    return {raw:frameDiagnosticText(raw,2000)};
  } catch { return {raw:'[unserializable stall]'}; }
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
      let snapshot: FrameStallSnapshot | null = null;
      try { snapshot = parseStall(v.snapshot); } catch { /* Keep a bounded raw diagnostic below. */ }
      return {type:'stall',snapshot:snapshot ?? rawStall(v.snapshot ?? v)};
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
    case 'rotated': return isPdfRotation(v.deg) && typeof v.auto === 'boolean' && (v.image === undefined || typeof v.image === 'boolean')
      ? {type:'rotated',deg:v.deg,auto:v.auto,...(v.image === undefined ? {} : {image:v.image as boolean})} : null;
    case 'orientation': {
      const measure = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
      if (!count(v.page) || v.page < 1 || v.ms === null || !measure(v.ms) || !measure(v.ink) || !measure(v.rowEnergy) || !measure(v.colEnergy)
        || ![0,270,null].includes(v.decision as number | null) || !measure(v.start) || !measure(v.end)
        || ![90,270,null].includes(v.direction as number | null) || !ORIENTATION_REASONS.some(reason => reason === v.reason)) return null;
      return {type:'orientation',page:v.page,ms:v.ms as number,ink:v.ink as number | null,rowEnergy:v.rowEnergy as number | null,
        colEnergy:v.colEnergy as number | null,decision:v.decision as 0 | 270 | null,start:v.start as number | null,end:v.end as number | null,
        direction:v.direction as 90 | 270 | null,reason:v.reason as FrameOrientation['reason']};
    }
    case 'pageText': return count(v.page) && v.page >= 1 && typeof v.hasText === 'boolean' ? {type:'pageText',page:v.page,hasText:v.hasText} : null;
    case 'error': return (v.code === 'pdfEncrypted' || v.code === 'pdfFailed') && (v.detail === undefined || text(v.detail,4096))
      ? {type:'error',code:v.code,...(v.detail === undefined ? {} : {detail:v.detail as string})} : null;
    case 'scroll': return typeof v.ratio === 'number' && Number.isFinite(v.ratio) && v.ratio >= 0 && v.ratio <= 1 ? {type:'scroll',ratio:v.ratio} : null;
    case 'heading': return text(v.id,2048) ? {type:'heading',id:v.id} : null;
    case 'gone': return count(v.request) && typeof v.found === 'boolean' ? {type:'gone',request:v.request,found:v.found} : null;
    case 'blocked': return count(v.n) ? {type:'blocked',n:v.n} : null;
    case 'found': return count(v.n) && v.n <= 100000 && count(v.index) && v.index <= v.n && count(v.request)
      ? {type:'found',n:v.n,index:v.index,request:v.request} : null;
    case 'link': return text(v.href,8192) && linkKind(v.href) === v.kind
      ? {type:'link',href:v.href,kind:v.kind as 'external' | 'relative'} : null;
    case 'probe': return text(v.invoke,4200) && (v.invoke === 'absent' || v.invoke === 'timeout' || v.invoke.startsWith('rejected:'))
      ? {type:'probe',invoke:v.invoke} : null;
    case 'shortcut': return v.key === 'find' || v.key === 'raw' || v.key === 'escape' || v.key === 'focus' || v.key === 'bookmark' || v.key === 'bookmarks' ? {type:'shortcut',key:v.key} : null;
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
