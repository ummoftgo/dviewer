import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

test('the real frame agent forwards focus/Escape but leaves consumed keys and Ctrl+Tab alone', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const postMessage = vi.fn();
  const load = '?g=0&x=1';
  runInNewContext(readFileSync(new URL('./agent.js', import.meta.url), 'utf8'), {
    parent: { postMessage },
    location: { search: load },
    document: { readyState: 'loading', addEventListener() {}, currentScript: null },
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); },
  });
  postMessage.mockClear(); // Count key forwarding separately from agent startup diagnostics.
  const press = (key: string, extra = {}) => {
    const preventDefault = vi.fn();
    listeners.get('keydown')!({ key, preventDefault, ...extra });
    return preventDefault;
  };
  expect(press('F11')).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'shortcut', key: 'focus', load }, '*');
  press('Escape');
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'shortcut', key: 'escape', load }, '*');
  press('F11', { repeat: true });
  press('Escape', { defaultPrevented: true });
  press('Tab', { ctrlKey: true });
  expect(postMessage).toHaveBeenCalledTimes(2);
  press('f', { ctrlKey: true }); press('e', { ctrlKey: true });
  expect(postMessage.mock.calls.slice(-2).map(call => call[0].key)).toEqual(['find', 'raw']);
});

test('loaded is sent only after window load and font readiness', async () => {
  const listeners = new Map<string, () => void>();
  const postMessage = vi.fn();
  const load = '?g=0&x=1';
  let finish!: () => void;
  const ready = new Promise<void>(resolve => {finish = resolve;});
  runInNewContext(readFileSync(new URL('./agent.js', import.meta.url),'utf8'), {
    location:{search:load},
    parent:{postMessage}, innerHeight:100, document:{readyState:'loading',fonts:{ready},documentElement:{scrollHeight:1000},addEventListener(){},currentScript:null},
    addEventListener(type:string, listener:() => void) {listeners.set(type,listener);},
  });
  expect(postMessage.mock.calls.some(([message]) => message.type === 'loaded')).toBe(false);
  listeners.get('load')!(); await Promise.resolve();
  expect(postMessage.mock.calls.some(([message]) => message.type === 'loaded')).toBe(false);
  finish(); await ready; await Promise.resolve();
  expect(postMessage).toHaveBeenLastCalledWith({type:'loaded',scrollable:true,load},'*');
});
