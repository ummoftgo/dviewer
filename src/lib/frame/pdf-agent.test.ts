import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,test,vi} from 'vitest';

function viewer() {
  const listeners = new Map<string,(event: unknown) => void>();
  const bus = new Map<string,() => void>();
  const messages: {type:string;n?:number}[] = [];
  const attempts: number[] = [];
  let initialize!: () => void, current = 1, scrolled = 1, location = 1, accepts = false, resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {resolveReady = resolve;});
  const parent = {postMessage(message: {type:string;n?:number}) {
    messages.push(message);
    if (message.type === 'ready') resolveReady();
  }};
  const app = {
    initializedPromise:Promise.resolve(),
    appConfig:{secondaryToolbar:{openFileButton:{hidden:false}}},
    passwordPrompt:{open:vi.fn()}, close:vi.fn(), pagesCount:3,
    pdfViewer:{onePageRendered:Promise.resolve(),update() {location=scrolled;}},
    pdfDocument:{numPages:3,getOutline:async () => [{title:'Second',dest:[1]}],getPage:async () => ({getTextContent:async () => ({items:[]})})},
    eventBus:{on(name:string,listener:() => void) {bus.set(name,listener);}},
    get page() {return current;},
    set page(value:number) {
      attempts.push(value);
      if (accepts) {current=value; bus.get('pagechanging')?.(); scrolled=value;}
    },
  };
  class Worker {addEventListener() {} terminate() {}}
  class WorkerUrl extends URL {static createObjectURL() {return 'blob:null/test';} static revokeObjectURL() {}}
  runInNewContext(readFileSync(new URL('./pdf-agent.js',import.meta.url),'utf8'),{
    parent,window:{PDFViewerApplication:app,PDFViewerApplicationOptions:{setAll() {}}},
    document:{title:'PDF',addEventListener(_name:string,listener:() => void) {initialize=listener;}},
    location:{search:'?g=0',href:'http://127.0.0.1:123/a/_/pdfjs/web/viewer.html'},
    Worker,URL:WorkerUrl,Blob,
    addEventListener(name:string,listener:(event:unknown) => void) {listeners.set(name,listener);},
  });
  return {
    attempts,messages,
    async initialize() {initialize(); await app.initializedPromise;},
    async ready() {bus.get('documentinit')!(); await ready;},
    loaded() {accepts=true; bus.get('pagesloaded')?.();},
    goto(target:number|string,source:unknown=parent) {listeners.get('message')!({source,data:{type:'goto',...(typeof target === 'string' ? {id:target} : {page:target})}});},
    reject() {accepts=false;},
    change(page:number) {current=page; bus.get('pagechanging')?.();},
    resize() {app.page=location; app.pdfViewer.update();},
    get page() {return current;},
    close() {listeners.get('pagehide')!({});},
  };
}

test('PDF goto waits for pagesloaded and only acknowledges the actual target',async () => {
  const pdf=viewer(); await pdf.initialize(); await pdf.ready(); pdf.messages.length=0;
  pdf.goto(3); pdf.goto(2); pdf.goto(1,{});
  expect(pdf.attempts).toEqual([]);
  expect(pdf.messages.filter(message => message.type === 'page')).toEqual([]);
  pdf.loaded();
  expect(pdf.attempts).toEqual([2]);
  expect(pdf.messages.filter(message => message.type === 'page').map(message => message.n)).toEqual([2]);
  pdf.messages.length=0; pdf.reject(); pdf.goto(3);
  pdf.change(1);
  expect(pdf.messages.filter(message => message.type === 'page')).toEqual([]);
  pdf.change(3);
  expect(pdf.messages.filter(message => message.type === 'page').map(message => message.n)).toEqual([3]);
  pdf.messages.length=0; pdf.goto(3);
  expect(pdf.messages.filter(message => message.type === 'page').map(message => message.n)).toEqual([3]);
});

test('PDF goto arriving before ready survives pagesloaded arriving first',async () => {
  for (const target of [2,'o0']) {
    const pdf=viewer(); await pdf.initialize(); pdf.goto(target); pdf.loaded();
    expect(pdf.attempts).toEqual([]);
    await pdf.ready();
    expect(pdf.attempts).toEqual([2]);
    expect(pdf.messages.filter(message => message.type === 'page').map(message => message.n)).toEqual([2]);
  }
});

test('closing the PDF cancels a queued goto before late pagesloaded',async () => {
  const pdf=viewer(); await pdf.initialize(); await pdf.ready(); pdf.messages.length=0;
  pdf.goto(2); pdf.close(); pdf.loaded();
  expect(pdf.attempts).toEqual([]);
  expect(pdf.messages.filter(message => message.type === 'page')).toEqual([]);
});

test('PDF goto survives resize before the next scroll update',async () => {
  for (const target of [2,'o0']) {
    const pdf=viewer(); await pdf.initialize(); pdf.loaded(); await pdf.ready();
    pdf.messages.length=0;
    pdf.goto(target);
    // PDF.js resizes from its last update() location, not currentPageNumber.
    pdf.resize();
    expect(pdf.page).toBe(2);
    expect(pdf.messages.filter(message => message.type === 'page').map(message => message.n)).toEqual([2,2]);
  }
});
