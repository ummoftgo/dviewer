import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,test,vi} from 'vitest';
import {parseFrameMessage,type FrameStall} from './messages';

type TextPage = {rotate:number; items:unknown[]; styles?:Record<string,{vertical:boolean}>;
  pixels?:'vertical'|'horizontal'|'blank'; render?:'fail'|'pending'; elapsed?:number};
const textItems = (a:number,b:number,n=20) => Array.from({length:n},() => ({str:'word',transform:[a,b,-b,a,0,0],fontName:'F1'}));
function viewer(outlineError?: Error, pendingInitialization = false, pages:TextPage[] = [{rotate:0,items:[]}]) {
  const listeners = new Map<string,(event: unknown) => void>();
  const bus = new Map<string,(event?:{pagesRotation:number}) => void>();
  const messages: {type:string;n?:number;deg?:number;auto?:boolean;image?:boolean;name?:string;code?:string;detail?:string;load?:string;snapshot?:FrameStall}[] = [];
  const workerListeners = new Map<string,(event:unknown) => void>();
  let workerBlob!: Blob, resolveError!: () => void;
  const errored = new Promise<void>(resolve => {resolveError=resolve;});
  const attempts: number[] = [];
  const rotationAttempts:number[] = [], order:string[] = [], textPages:number[] = [];
  let rotation = 0, textFailure = false;
  let drawn:TextPage, elapsed=0;
  const renders:{page:number;width:number;height:number;rotation:number;cancel:ReturnType<typeof vi.fn>;finish:() => void}[] = [];
  const canvas = {width:0,height:0,getContext:() => ({getImageData() {
    const data = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
    for (let y=0;y<canvas.height;y++) for (let x=0;x<canvas.width;x++) {
      if ((drawn.pixels === 'vertical' && x % 16 < 6) || (drawn.pixels === 'horizontal' && y % 16 < 6)) {
        const at=(y * canvas.width+x)*4; data[at]=data[at+1]=data[at+2]=0;
      }
    }
    return {data};
  }})};
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
    pdfViewer:{onePageRendered:Promise.resolve(),update() {order.push('update'); location=scrolled;},
      get pagesRotation() {return rotation;},
      set pagesRotation(value:number) {
        rotationAttempts.push(value); order.push(`rotate:${value}`);
        if (rotation === value) return;
        rotation=value; bus.get('rotationchanging')?.({pagesRotation:value});
        // Rotating can synchronously notify observers before goto repairs the page.
        current=1; bus.get('pagechanging')?.();
      }},
    pdfDocument:{numPages:3,getOutline:async () => {if (outlineError) throw outlineError; return [{title:'Second',dest:[1]}];},
      getPage:async (n:number) => ({rotate:pages[(n-1) % pages.length].rotate,getTextContent:async () => {
        textPages.push(n); if (textFailure) throw new Error('text failed'); return pages[(n-1) % pages.length];
      },getViewport:({scale,rotation}:{scale:number;rotation:number}) => ({width:320*scale,height:640*scale,rotation}),
      render({viewport}:{viewport:{rotation:number}}) {
        drawn=pages[(n-1) % pages.length]; elapsed+=drawn.elapsed ?? 0;
        let finish!:() => void, reject!:(cause:Error) => void;
        const promise=new Promise<void>((resolve,fail) => {finish=resolve; reject=fail;});
        const cancel=vi.fn(() => reject(new Error('render cancelled')));
        renders.push({page:n,width:canvas.width,height:canvas.height,rotation:viewport.rotation,cancel,finish});
        if (drawn.render === 'fail') reject(new Error('render failed'));
        else if (drawn.render !== 'pending') finish();
        return {promise,cancel};
      }})},
    eventBus:{on(name:string,listener:(event?:{pagesRotation:number}) => void) {bus.set(name,listener);}},
    get page() {return current;},
    set page(value:number) {
      attempts.push(value);
      order.push(`page:${value}`);
      if (accepts) {current=value; bus.get('pagechanging')?.(); scrolled=value;}
    },
  };
  class Worker {addEventListener(name:string,listener:(event:unknown) => void) {workerListeners.set(name,listener);} terminate() {}}
  class WorkerUrl extends URL {static createObjectURL(blob:Blob) {workerBlob=blob; return 'blob:null/test';} static revokeObjectURL() {}}
  const orientationFromProfiles = runInNewContext(readFileSync(new URL('./pdf-agent.js',import.meta.url),'utf8') + '\norientationFromProfiles;',{
    parent,window:{PDFViewerApplication:app,PDFViewerApplicationOptions:{setAll() {},getAll() {return {one:1};}}},
    document:{title:'PDF',readyState:'complete',fonts:{status:'loaded'},createElement:() => canvas,addEventListener(_name:string,listener:() => void) {initialize=listener;}},
    navigator:{language:'en-GB',locale:'C'},
    performance:{now:() => Date.now()+elapsed,getEntriesByType(type:string) {return type === 'navigation' ? [{responseStatus:200}] : resourceEntries;}},
    location:{search:'?g=0',href:'http://127.0.0.1:123/a/_/pdfjs/web/viewer.html'},
    Worker,URL:WorkerUrl,Blob,setTimeout,clearTimeout,
    addEventListener(name:string,listener:(event:unknown) => void) {listeners.set(name,listener);},
  });
  return {
    attempts,messages,errored,resourceEntries,rotationAttempts,order,textPages,renders,canvas,
    orientationFromProfiles:orientationFromProfiles as (rows:number[],cols:number[]) => number|null,
    failText() {textFailure=true;},
    numPages(n:number) {app.pdfDocument.numPages=n; app.pagesCount=n;},
    bootstrap() {return workerBlob.text();},
    async initialize() {initialize(); await app.initializedPromise;},
    start() {initialize();},
    async finishInitialization() {app.initialized=true; resolveInitialization(); await initialization;},
    failInitialization() {app._initializeViewerComponents=async () => {throw new Error('components failed');};},
    runInitialization() {return app.initialize();},
    async ready() {bus.get('documentinit')!(); await ready;},
    loaded() {accepts=true; bus.get('pagesloaded')?.();},
    goto(target:number|string,source:unknown=parent,rotation?:unknown) {listeners.get('message')!({source,data:{type:'goto',rotation,...(typeof target === 'string' ? {id:target} : {page:target})}});},
    rotate(deg:unknown,source:unknown=parent) {listeners.get('message')!({source,data:{type:'rotate',deg}});},
    manual(deg:number) {app.pdfViewer.pagesRotation=deg;},
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

test('ink profile energy distinguishes stripes, rejects sparse and uniform pages, and normalizes rectangular canvases',() => {
  const {orientationFromProfiles:direction}=viewer();
  expect(direction([8,8,8,8,0,0,0,0],Array(8).fill(4))).toBe(0);
  expect(direction(Array(8).fill(4),[8,8,8,8,0,0,0,0])).toBe(270);
  expect(direction(Array(32).fill(4),[32,32,32,32,0,0,0,0])).toBe(270);
  expect(direction([8,8,8,8,...Array(28).fill(0)],Array(8).fill(4))).toBe(0);
  expect(direction([4,4,4,4,0,0,0,0],[4,4,4,4,0,0,0,0])).toBeNull();
  expect(direction([3,1,3,1],[4,0,2,2])).toBe(270);
  expect(direction(Array(8).fill(4),Array(8).fill(4))).toBeNull();
  expect(direction(Array(8).fill(0),Array(8).fill(0))).toBeNull();
  expect(direction([1,...Array(99).fill(0)],[1,...Array(99).fill(0)])).toBeNull();
  expect(direction(Array(100).fill(1),[100,...Array(99).fill(0)])).toBe(270);
  expect(direction([0,...Array(99).fill(1)],[99,...Array(99).fill(0)])).toBeNull();
  expect(direction([],[])).toBeNull();
});

test('image orientation needs agreement, respects page Rotate and bounds rendering to the first two small canvases',async () => {
  const vertical:TextPage={rotate:0,items:[],pixels:'vertical'};
  const horizontal:TextPage={rotate:0,items:[],pixels:'horizontal'};
  for (const [pages,expected] of [
    [[vertical,vertical,horizontal],270], [[horizontal,horizontal],0], [[vertical,horizontal],0],
    [[vertical,{...vertical,pixels:'blank'}],0], [[{...vertical,rotate:90}],0],
    [[{...horizontal,rotate:90}],270], [[vertical],270],
  ] as [TextPage[],number][]) {
    const pdf=viewer(undefined,false,pages); pdf.numPages(pages.length);
    await pdf.initialize(); await pdf.ready(); pdf.goto(1); pdf.loaded();
    expect(pdf.messages.find(m=>m.type==='rotated')).toEqual({type:'rotated',deg:expected,auto:expected!==0,
      ...(expected ? {image:true} : {}),load:'?g=0'});
    expect(pdf.renders.length).toBeLessThanOrEqual(2);
    for (const render of pdf.renders) expect(render).toMatchObject({width:128,height:256,rotation:0});
    if (pages.length===3) expect(pdf.renders.map(r=>r.page)).toEqual([1,2]);
    expect(pdf.canvas.width).toBe(0); expect(pdf.canvas.height).toBe(0); pdf.close();
  }
});

test('sufficient or unreadable text never falls back to pixels; saved zero and manual turns win',async () => {
  for (const page of [
    {rotate:0,items:textItems(1,0),pixels:'vertical'},
    {rotate:0,items:[...textItems(0,1,15),...textItems(1,0,5)],pixels:'vertical'},
    {rotate:0,items:textItems(0,1),styles:{F1:{vertical:true}},pixels:'vertical'},
  ] as TextPage[]) {
    const pdf=viewer(undefined,false,[page]); pdf.numPages(1); await pdf.initialize(); await pdf.ready(); pdf.goto(1); pdf.loaded();
    expect(pdf.renders).toEqual([]); expect(pdf.rotationAttempts).toEqual([0]); pdf.close();
  }
  for (const choice of ['saved','manual','failed'] as const) {
    const pdf=viewer(undefined,false,[{rotate:0,items:[],pixels:'vertical'}]); await pdf.initialize();
    if (choice==='saved') pdf.goto(2,undefined,0);
    else if (choice==='manual') pdf.manual(90);
    else pdf.failText();
    await pdf.ready(); pdf.goto(2); pdf.loaded();
    expect(pdf.renders).toEqual([]);
    expect(pdf.rotationAttempts).toEqual([choice==='manual' ? 90 : 0]); pdf.close();
  }
});

test('reversing an image correction retains its pill provenance until undo, while restored angles are not auto',async () => {
  const pdf=viewer(undefined,false,[{rotate:0,items:[],pixels:'vertical'}]);
  await pdf.initialize(); await pdf.ready(); pdf.goto(2); pdf.loaded();
  pdf.rotate(90); expect(pdf.page).toBe(2); pdf.rotate(0); expect(pdf.page).toBe(2);
  expect(pdf.messages.filter(m=>m.type==='rotated')).toEqual([
    {type:'rotated',deg:270,auto:true,image:true,load:'?g=0'},
    {type:'rotated',deg:90,auto:false,image:true,load:'?g=0'},
    {type:'rotated',deg:0,auto:false,load:'?g=0'},
  ]); pdf.close();
  for (const rotation of [0,90,270]) {
    const restored=viewer(undefined,false,[{rotate:0,items:[],pixels:'vertical'}]);
    await restored.initialize(); await restored.ready(); restored.goto(2,undefined,rotation); restored.loaded();
    expect(restored.messages.find(m=>m.type==='rotated')).toEqual({type:'rotated',deg:rotation,auto:false,load:'?g=0'}); restored.close();
  }
});

test('failed or synchronously slow image probes do not rotate or continue sampling',async () => {
  for (const page of [
    {rotate:0,items:[],pixels:'vertical',render:'fail'},
    {rotate:0,items:[],pixels:'vertical',elapsed:201},
  ] as TextPage[]) {
    const pdf=viewer(undefined,false,[page]); await pdf.initialize(); await pdf.ready(); pdf.goto(2); pdf.loaded();
    expect(pdf.renders).toHaveLength(1);
    expect(pdf.messages.some(m=>m.type==='error')).toBe(false);
    expect(pdf.messages.find(m=>m.type==='rotated')).toMatchObject({deg:0,auto:false});
    expect(pdf.canvas.width).toBe(0); pdf.close();
  }
});

test('image probe deadline and closing cancel the active render and discard partial evidence',async () => {
  vi.useFakeTimers();
  try {
    for (const stop of ['deadline','close'] as const) {
      const pdf=viewer(undefined,false,[{rotate:0,items:[],pixels:'vertical',render:'pending'}]);
      await pdf.initialize(); const ready=pdf.ready(); await vi.advanceTimersByTimeAsync(0);
      expect(pdf.renders).toHaveLength(1);
      if (stop==='close') {pdf.close(); await vi.advanceTimersByTimeAsync(0);}
      else {await vi.advanceTimersByTimeAsync(200); await ready; pdf.goto(2); pdf.loaded();}
      expect(pdf.renders[0].cancel).toHaveBeenCalledTimes(1);
      expect(pdf.renders).toHaveLength(1); expect(pdf.canvas.width).toBe(0);
      expect(pdf.messages.some(m=>m.type==='rotated' && m.auto)).toBe(false);
      if (stop==='close') expect(pdf.messages.some(m=>m.type==='ready')).toBe(false);
      else expect(pdf.messages.find(m=>m.type==='rotated')).toMatchObject({deg:0,auto:false});
      pdf.close(); expect(vi.getTimerCount()).toBe(0);
    }
  } finally {vi.useRealTimers();}
});

test('PDF orientation uses text matrices minus page Rotate and ignores sparse, vertical or invalid text',async () => {
  const samples = [
    {items:textItems(1,0),rotate:0,expected:0},
    {items:textItems(0,1),rotate:0,expected:90},
    {items:textItems(-1,0),rotate:0,expected:180},
    {items:textItems(0,-1),rotate:0,expected:270},
    {items:textItems(0,1),rotate:90,expected:0},
    {items:textItems(1,0),rotate:90,expected:270},
    {items:textItems(0,1,19),rotate:0,expected:0},
    {items:[...textItems(0,1,16),...textItems(1,0,4)],rotate:0,expected:90},
    {items:[...textItems(0,1,15),...textItems(1,0,5)],rotate:0,expected:0},
    {items:textItems(0,1),rotate:0,styles:{F1:{vertical:true}},expected:0},
    {items:[...textItems(0,1,19),{str:'  ',transform:[0,1,0,0,0,0]},{str:'bad',transform:[NaN,1]},
      {str:'zero',transform:[0,0]},{type:'markedContent'}],rotate:0,expected:0},
  ];
  for (const sample of samples) {
    const pdf=viewer(undefined,false,[sample]); pdf.numPages(1);
    await pdf.initialize(); pdf.loaded(); await pdf.ready();
    expect(pdf.rotationAttempts).toEqual([]);
    pdf.goto(1);
    expect(pdf.messages.filter(m => m.type === 'rotated')).toEqual([{type:'rotated',deg:sample.expected,auto:sample.expected !== 0,load:'?g=0'}]);
    pdf.close();
  }
});

test('PDF sampling stops at three pages, counts items across pages and survives extraction failure',async () => {
  const pdf=viewer(undefined,false,[{rotate:0,items:textItems(0,1,8)},{rotate:0,items:textItems(0,1,8)},
    {rotate:0,items:textItems(1,0,4)},{rotate:0,items:textItems(-1,0,100)}]); pdf.numPages(4);
  await pdf.initialize(); await pdf.ready();
  expect(pdf.textPages).toEqual([1,2,3]);
  pdf.goto(2); pdf.loaded();
  expect(pdf.messages.find(m => m.type === 'rotated')).toMatchObject({deg:90,auto:true}); pdf.close();
  const broken=viewer(); broken.failText(); await broken.initialize(); await broken.ready(); broken.goto(1); broken.loaded();
  expect(broken.messages.some(m => m.type === 'error')).toBe(false);
  expect(broken.messages.find(m => m.type === 'rotated')).toMatchObject({deg:0,auto:false}); broken.close();
});

test('PDF restored rotation including zero wins and is applied before goto and location update',async () => {
  for (const loadedFirst of [true,false]) for (const rotation of [undefined,0,270]) {
    const pdf=viewer(undefined,false,[{rotate:0,items:textItems(0,1)}]); await pdf.initialize();
    if (loadedFirst) pdf.loaded();
    await pdf.ready(); pdf.goto(2,undefined,rotation);
    if (!loadedFirst) {expect(pdf.rotationAttempts).toEqual([]); pdf.loaded();}
    expect(pdf.order).toEqual([`rotate:${rotation ?? 90}`,'page:2','update']);
    expect(pdf.messages.filter(m => ['rotated','page'].includes(m.type))).toEqual([
      {type:'rotated',deg:rotation ?? 90,auto:rotation === undefined,load:'?g=0'}, {type:'page',n:2,load:'?g=0'},
    ]);
    pdf.resize(); expect(pdf.page).toBe(2); pdf.close();
  }
});

test('PDF undo and manual rotation cancel auto status; same angle still acknowledges and later goto preserves it',async () => {
  const pdf=viewer(undefined,false,[{rotate:0,items:textItems(0,1)}]);
  await pdf.initialize(); await pdf.ready(); pdf.goto(2); pdf.loaded(); pdf.messages.length=0;
  pdf.rotate(0); expect(pdf.page).toBe(2);
  pdf.rotate(0); pdf.goto(2); pdf.manual(180);
  expect(pdf.messages.filter(m => m.type === 'rotated')).toEqual([
    {type:'rotated',deg:0,auto:false,load:'?g=0'}, {type:'rotated',deg:0,auto:false,load:'?g=0'},
    {type:'rotated',deg:180,auto:false,load:'?g=0'},
  ]);
  expect(pdf.rotationAttempts).toEqual([90,0,0,180]);
  pdf.close(); const count=pdf.messages.length; pdf.rotate(90); pdf.loaded();
  expect(pdf.messages).toHaveLength(count);
});

test('PDF rejects invalid or foreign rotations and does not overwrite a manual turn while loading',async () => {
  const pdf=viewer(undefined,false,[{rotate:0,items:textItems(0,1)}]);
  await pdf.initialize(); pdf.manual(180); await pdf.ready(); pdf.loaded();
  for (const deg of [-90,360,1,NaN,'90',null]) {pdf.rotate(deg); pdf.goto(2,undefined,deg);}
  pdf.rotate(90,{}); pdf.goto(2,{},0);
  expect(pdf.attempts).toEqual([]); expect(pdf.rotationAttempts).toEqual([180]);
  pdf.goto(2); expect(pdf.rotationAttempts).toEqual([180]); expect(pdf.page).toBe(2); pdf.close();
});

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
