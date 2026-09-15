import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

test('PDF keeps its own readiness and page tracking while allowing the bookmarks panel shortcut', () => {
  const listeners = new Map<string, (event: unknown) => void>(), postMessage = vi.fn();
  runInNewContext(readFileSync(new URL('./agent.js', import.meta.url), 'utf8'), {
    parent:{postMessage}, location:{search:'?file=pdf&g=0'},
    document:{currentScript:{hasAttribute:(name:string) => name === 'data-pdf'}},
    addEventListener(type:string, listener:(event:unknown) => void) { listeners.set(type,listener); },
  });
  expect([...listeners.keys()]).toEqual(['securitypolicyviolation','keydown']);
  postMessage.mockClear();
  const press = (key:string,extra={}) => {
    const preventDefault = vi.fn();
    listeners.get('keydown')!({key,preventDefault,ctrlKey:true,...extra});
    return preventDefault;
  };
  expect(press('B',{shiftKey:true})).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenLastCalledWith({type:'shortcut',key:'bookmarks',load:'?file=pdf&g=0'},'*');
  expect(press('d')).not.toHaveBeenCalled();
  expect(press('e')).not.toHaveBeenCalled();
  press('f');
  expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual(['shortcut','shortcut']);
  expect(postMessage.mock.calls.map(([message]) => message.key)).toEqual(['bookmarks','find']);
});

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
  press('d', {ctrlKey:true}); press('B', {ctrlKey:true,shiftKey:true});
  expect(postMessage.mock.calls.filter(call => call[0].type === 'shortcut').slice(-2).map(call => call[0].key)).toEqual(['bookmark','bookmarks']);
  const count = postMessage.mock.calls.length;
  press('d', {ctrlKey:true,repeat:true}); press('b',{ctrlKey:true}); press('d',{ctrlKey:true,defaultPrevented:true});
  expect(postMessage).toHaveBeenCalledTimes(count);
});

test('the real agent reports the current heading and acknowledges top, found and missing destinations', () => {
  const listeners = new Map<string, (event?: unknown) => void>(), postMessage = vi.fn();
  const parent = {postMessage}, scrollTo = vi.fn();
  const nodes = [0,400].map((top,index) => ({id:`h${index}`,tagName:'H2',textContent:`Heading ${index}`,
    getBoundingClientRect:() => ({top:top - 420}),scrollIntoView:vi.fn()}));
  runInNewContext(readFileSync(new URL('./agent.js', import.meta.url),'utf8'), {
    parent, location:{search:'?g=0'}, scrollY:420, scrollTo,
    ResizeObserver:class {observe() {}},
    document:{readyState:'loading',body:{},title:'Document',currentScript:null,
      querySelectorAll:() => nodes, getElementById:(id:string) => nodes.find(node => node.id === id),
      addEventListener(type:string,listener:() => void) {listeners.set(type,listener);}},
    addEventListener(type:string,listener:(event:unknown) => void) {listeners.set(type,listener);},
  });
  listeners.get('DOMContentLoaded')!();
  const go = (id:string,request:number) => listeners.get('message')!({source:parent,data:{type:'goto',id,request}});
  go('h1',1);
  expect(nodes[1].scrollIntoView).toHaveBeenCalledWith({behavior:'instant'});
  expect(postMessage.mock.calls.slice(-2).map(([message]) => message)).toEqual([
    {type:'heading',id:'h1',load:'?g=0'},{type:'gone',request:1,found:true,load:'?g=0'}]);
  go('missing',2);
  expect(postMessage).toHaveBeenLastCalledWith({type:'gone',request:2,found:false,load:'?g=0'},'*');
  go('',3); expect(scrollTo).toHaveBeenCalledWith({top:0,behavior:'instant'});
  expect(postMessage).toHaveBeenLastCalledWith({type:'gone',request:3,found:true,load:'?g=0'},'*');
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
