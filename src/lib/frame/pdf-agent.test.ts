import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,test,vi} from 'vitest';
import {parseFrameMessage} from './messages';

function viewer(outlineError?: Error) {
  const listeners = new Map<string,(event: unknown) => void>();
  const bus = new Map<string,() => void>();
  const messages: {type:string;n?:number;name?:string;code?:string;detail?:string;load?:string}[] = [];
  const workerListeners = new Map<string,(event:unknown) => void>();
  let workerBlob!: Blob, resolveError!: () => void;
  const errored = new Promise<void>(resolve => {resolveError=resolve;});
  const attempts: number[] = [];
  let initialize!: () => void, current = 1, scrolled = 1, location = 1, accepts = false, resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {resolveReady = resolve;});
  const parent = {postMessage(message: {type:string;n?:number}) {
    messages.push(message);
    if (message.type === 'ready') resolveReady();
    if (message.type === 'error') resolveError();
  }};
  const app = {
    initializedPromise:Promise.resolve(),
    appConfig:{secondaryToolbar:{openFileButton:{hidden:false}}},
    passwordPrompt:{open:vi.fn()}, close:vi.fn(), pagesCount:3,
    pdfViewer:{onePageRendered:Promise.resolve(),update() {location=scrolled;}},
    pdfDocument:{numPages:3,getOutline:async () => {if (outlineError) throw outlineError; return [{title:'Second',dest:[1]}];},getPage:async () => ({getTextContent:async () => ({items:[]})})},
    eventBus:{on(name:string,listener:() => void) {bus.set(name,listener);}},
    get page() {return current;},
    set page(value:number) {
      attempts.push(value);
      if (accepts) {current=value; bus.get('pagechanging')?.(); scrolled=value;}
    },
  };
  class Worker {addEventListener(name:string,listener:(event:unknown) => void) {workerListeners.set(name,listener);} terminate() {}}
  class WorkerUrl extends URL {static createObjectURL(blob:Blob) {workerBlob=blob; return 'blob:null/test';} static revokeObjectURL() {}}
  runInNewContext(readFileSync(new URL('./pdf-agent.js',import.meta.url),'utf8'),{
    parent,window:{PDFViewerApplication:app,PDFViewerApplicationOptions:{setAll() {}}},
    document:{title:'PDF',addEventListener(_name:string,listener:() => void) {initialize=listener;}},
    location:{search:'?g=0',href:'http://127.0.0.1:123/a/_/pdfjs/web/viewer.html'},
    Worker,URL:WorkerUrl,Blob,
    addEventListener(name:string,listener:(event:unknown) => void) {listeners.set(name,listener);},
  });
  return {
    attempts,messages,errored,
    bootstrap() {return workerBlob.text();},
    async initialize() {initialize(); await app.initializedPromise;},
    async ready() {bus.get('documentinit')!(); await ready;},
    loaded() {accepts=true; bus.get('pagesloaded')?.();},
    goto(target:number|string,source:unknown=parent) {listeners.get('message')!({source,data:{type:'goto',...(typeof target === 'string' ? {id:target} : {page:target})}});},
    reject() {accepts=false;},
    change(page:number) {current=page; bus.get('pagechanging')?.();},
    resize() {app.page=location; app.pdfViewer.update();},
    get page() {return current;},
    event(name:string,event:unknown) {listeners.get(name)!(event);},
    workerEvent(name:string,event:unknown) {workerListeners.get(name)!(event);},
    async documentInit() {bus.get('documentinit')!(); await Promise.resolve();},
    pagesInit() {bus.get('pagesinit')!();},
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

test('PDF startup stages survive parsing even before ready',async () => {
  const pdf=viewer(); await pdf.initialize(); pdf.pagesInit(); pdf.loaded(); await pdf.ready();
  pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-start'}});
  pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-imported'}});
  const stages=pdf.messages.filter(message => message.type === 'stage');
  expect(stages.map(message => message.name)).toEqual(['start','webviewerloaded','initializedPromise','pagesinit','pagesloaded',
    'documentinit','onePageRendered','worker-start','worker-imported']);
  for (const message of stages) expect(parseFrameMessage(message)).toEqual({type:'stage',name:message.name});
});

test('PDF failures preserve bounded detail from the viewer, worker and global handlers',async () => {
  const detail='Module import failed: ' + 'x'.repeat(4096);
  for (const source of ['outline','worker','worker-import','window','rejection']) {
    const pdf=viewer(source === 'outline' ? new Error(detail) : undefined); await pdf.initialize();
    if (source === 'outline') {await pdf.documentInit(); await pdf.errored;}
    else if (source === 'worker') pdf.workerEvent('error',{message:detail});
    else if (source === 'worker-import') pdf.workerEvent('message',{data:{type:'pdfWorkerError',detail}});
    else if (source === 'window') pdf.event('error',{message:detail});
    else pdf.event('unhandledrejection',{reason:new Error(detail)});
    expect(pdf.messages.filter(message => message.type === 'error'),source).toEqual([{type:'error',code:'pdfFailed',detail:detail.slice(0,4096),load:'?g=0'}]);
    const count=pdf.messages.length;
    pdf.loaded(); pdf.goto(2); pdf.event('error',{message:'later error'});
    expect(pdf.messages).toHaveLength(count);
  }
});

test('the real worker bootstrap forwards import rejections instead of leaving the viewer waiting',async () => {
  const pdf=viewer(); await pdf.initialize();
  // This VM has no module loader; exercise the bootstrap's actual rejection handler.
  runInNewContext(await pdf.bootstrap(),{
    postMessage:(data:unknown) => pdf.workerEvent('message',{data}), addEventListener() {},
  });
  await pdf.errored;
  expect(pdf.messages.some(message => message.type === 'stage' && message.name === 'worker-start')).toBe(true);
  const failure=pdf.messages.find(message => message.type === 'error')!;
  expect(failure.code).toBe('pdfFailed');
  expect(failure.detail).toBe('A dynamic import callback was not specified.');
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
