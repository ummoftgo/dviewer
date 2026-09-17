import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,test,vi} from 'vitest';
import {parseFrameMessage,type FrameStall} from './messages';

function viewer(outlineError?: Error, pendingInitialization = false) {
  const listeners = new Map<string,(event: unknown) => void>();
  const bus = new Map<string,() => void>();
  const messages: {type:string;n?:number;name?:string;code?:string;detail?:string;load?:string;snapshot?:FrameStall}[] = [];
  const workerListeners = new Map<string,(event:unknown) => void>();
  let workerBlob!: Blob, resolveError!: () => void;
  const errored = new Promise<void>(resolve => {resolveError=resolve;});
  const attempts: number[] = [];
  let initialize!: () => void, current = 1, scrolled = 1, location = 1, accepts = false, resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {resolveReady = resolve;});
  let resolveInitialization!: () => void;
  const initialization = new Promise<void>(resolve => {resolveInitialization=resolve;});
  const resourceEntries=Array.from({length:20},(_,i) => ({
    name:`http://127.0.0.1:123/a/_/pdfjs/web/${i}.ftl?file=secret#fragment`,responseStatus:i===19 ? 404 : undefined,duration:i+0.4,transferSize:100,
  }));
  const parent = {postMessage(message: {type:string;n?:number}) {
    messages.push(message);
    if (message.type === 'ready') resolveReady();
    if (message.type === 'error') resolveError();
  }};
  const app = {
    initializedPromise:pendingInitialization ? initialization : Promise.resolve(), initialized:!pendingInitialization,
    async initialize() {await this.preferences.initializedPromise; await this.externalServices.createL10n(); await this._initializeViewerComponents();},
    preferences:{initializedPromise:Promise.resolve()},
    externalServices:{createL10n:async () => ({})}, _initializeViewerComponents:async () => {},
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
    parent,window:{PDFViewerApplication:app,PDFViewerApplicationOptions:{setAll() {},getAll() {return {one:1};}}},
    document:{title:'PDF',readyState:'complete',fonts:{status:'loaded'},addEventListener(_name:string,listener:() => void) {initialize=listener;}},
    navigator:{language:'en-GB',locale:'C'},
    performance:{getEntriesByType(type:string) {return type === 'navigation' ? [{responseStatus:200}] : resourceEntries;}},
    location:{search:'?g=0',href:'http://127.0.0.1:123/a/_/pdfjs/web/viewer.html'},
    Worker,URL:WorkerUrl,Blob,setTimeout,clearTimeout,
    addEventListener(name:string,listener:(event:unknown) => void) {listeners.set(name,listener);},
  });
  return {
    attempts,messages,errored,resourceEntries,
    bootstrap() {return workerBlob.text();},
    async initialize() {initialize(); await app.initializedPromise;},
    start() {initialize();},
    async finishInitialization() {app.initialized=true; resolveInitialization(); await initialization;},
    failInitialization() {app._initializeViewerComponents=async () => {throw new Error('components failed');};},
    runInitialization() {return app.initialize();},
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

test('PDF startup sends one bounded stall snapshot eight seconds after worker import',async () => {
  vi.useFakeTimers();
  try {
    const pdf=viewer(undefined,true); pdf.start();
    pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-imported'}});
    await vi.advanceTimersByTimeAsync(7999);
    expect(pdf.messages.some(message => message.type === 'stall')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const stalls=pdf.messages.filter(message => message.type === 'stall');
    expect(stalls).toHaveLength(1);
    const snapshot=stalls[0].snapshot!;
    if ('raw' in snapshot) throw new Error('structured stall missing');
    expect(snapshot).toMatchObject({readyState:'complete',l10n:'undefined',pdfViewer:true,preferences:true,initialized:false,
      options:1,locale:'C',language:'en-GB',fonts:'loaded',navigationStatus:200});
    expect(snapshot.resources).toHaveLength(15);
    expect(snapshot.resources[0]).toEqual({name:'/_/pdfjs/web/5.ftl',responseStatus:null,duration:5,transferSize:100});
    expect(snapshot.resources[14]).toEqual({name:'/_/pdfjs/web/19.ftl',responseStatus:404,duration:19,transferSize:100});
    expect(JSON.stringify(snapshot)).not.toMatch(/127\.0|secret|fragment/);
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(8192);
    expect(parseFrameMessage(stalls[0])).toEqual({type:'stall',snapshot});
    pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-imported'}});
    await vi.advanceTimersByTimeAsync(8000);
    expect(pdf.messages.filter(message => message.type === 'stall')).toHaveLength(1);
    pdf.close();
  } finally {vi.useRealTimers();}
});

test('unreadable timing getters do not discard the other stall fields',async () => {
  vi.useFakeTimers();
  try {
    const pdf=viewer(undefined,true); pdf.start();
    for (const key of ['responseStatus','transferSize']) {
      Object.defineProperty(pdf.resourceEntries[19],key,{get() {throw new Error('unavailable timing');}});
    }
    pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-imported'}});
    await vi.advanceTimersByTimeAsync(8000);
    const snapshot=pdf.messages.find(message => message.type === 'stall')?.snapshot;
    if (!snapshot || 'raw' in snapshot) throw new Error('structured stall missing');
    expect(snapshot.language).toBe('en-GB');
    expect(snapshot.resources[14]).toEqual({name:'/_/pdfjs/web/19.ftl',responseStatus:null,duration:19,transferSize:null});
    expect(pdf.messages.some(message => message.type === 'error')).toBe(false);
    pdf.close();
  } finally {vi.useRealTimers();}
});

test('initialization, closing and errors cancel the PDF stall timer',async () => {
  vi.useFakeTimers();
  try {
    for (const finish of ['initialized','closed','failed']) {
      const pdf=viewer(undefined,true); pdf.start();
      pdf.workerEvent('message',{data:{type:'pdfWorkerStage',name:'worker-imported'}});
      if (finish === 'initialized') await pdf.finishInitialization();
      else if (finish === 'closed') pdf.close();
      else pdf.event('error',{message:'failed'});
      await vi.advanceTimersByTimeAsync(8000);
      expect(pdf.messages.some(message => message.type === 'stall'),finish).toBe(false);
      pdf.close();
    }
  } finally {vi.useRealTimers();}
});

test('a rejected initialize is reported even when initializedPromise never rejects',async () => {
  const pdf=viewer(undefined,true); pdf.failInitialization(); pdf.start();
  await expect(pdf.runInitialization()).rejects.toThrow('components failed');
  await pdf.errored;
  expect(pdf.messages.filter(message => message.type === 'error')).toEqual([
    {type:'error',code:'pdfFailed',detail:'components: components failed',load:'?g=0'},
  ]);
  expect(pdf.messages.some(message => message.name === 'initializedPromise')).toBe(false);
  pdf.close();
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
