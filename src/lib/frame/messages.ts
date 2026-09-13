import type { TocEntry } from '../ipc';

export type FrameMessage =
  | { type: 'agentStart' }
  | { type: 'ready'; title: string; headings: TocEntry[] }
  | { type: 'scroll'; ratio: number }
  | { type: 'blocked'; n: number }
  | { type: 'found'; n: number; index: number; request: number }
  | { type: 'link'; href: string; kind: 'external' | 'relative' }
  | { type: 'probe'; invoke: string }
  | { type: 'isolationBroken' }
  | { type: 'shortcut'; key: 'find' | 'raw' | 'escape' | 'focus' };
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

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
    case 'ready': {
      if (!text(v.title,4096) || !Array.isArray(v.headings) || v.headings.length > 10000) return null;
      const headings: TocEntry[] = [], ids = new Set<string>();
      for (const item of v.headings) {
        if (!item || typeof item !== 'object' || !text(item.id,2048) || !item.id || ids.has(item.id)
          || !text(item.text,4096) || !Number.isInteger(item.level) || item.level < 1 || item.level > 6) return null;
        ids.add(item.id); headings.push({id:item.id, level:item.level, text:item.text});
      }
      return {type:'ready',title:v.title,headings};
    }
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

export function frameMessage(event: Pick<MessageEvent, 'source' | 'data'>, frame: Window | null): FrameMessage | null {
  return frame !== null && event.source === frame ? parseFrameMessage(event.data) : null;
}
