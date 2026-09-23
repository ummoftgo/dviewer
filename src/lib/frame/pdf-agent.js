// Trusted viewer bridge; the PDF and this iframe still have no app capabilities.
function inkProfile(rows, cols) {
  const ink = rows.length && cols.length ? rows.reduce((sum,n) => sum + n,0) / (rows.length * cols.length) : 0;
  if (ink < 0.01) return {ink,rowEnergy:null,colEnergy:null,decision:null,reason:'sparse'};
  const energy = (profile,span) => profile.reduce((sum,n) => sum + (n / span - ink) ** 2,0) / profile.length;
  const rowEnergy = energy(rows,cols.length), colEnergy = energy(cols,rows.length);
  if (rowEnergy + colEnergy < 1e-6) return {ink,rowEnergy,colEnergy,decision:null,reason:'sparse'};
  // Ink profiles only say the lines run down the page; directionFromEdges picks which way.
  const decision = colEnergy >= rowEnergy * 2 ? 270 : rowEnergy >= colEnergy * 2 ? 0 : null;
  return {ink,rowEnergy,colEnergy,decision,reason:decision === 270 ? 'sideways' : decision === 0 ? 'upright' : 'ambiguous'};
}
const orientationFromProfiles = (rows, cols) => inkProfile(rows,cols).decision;
// Left-aligned lines share their start and scatter their ends, so the steadier edge is where lines begin.
// first/last are each inked column's first and last ink row at the 512px probe; spreads are MADs in pixels.
function directionFromEdges(first, last) {
  const median = values => {
    const sorted = [...values].sort((a,b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const spread = values => { const centre = median(values); return median(values.map(value => Math.abs(value - centre))); };
  if (!first.length) return {start:null,end:null,direction:null};
  const start = spread(first), end = spread(last), high = Math.max(start,end), low = Math.min(start,end);
  // ponytail: a 4px floor at 512px and a 2x margin; justified text or a centred cover gives no vote, and 270 stays the default.
  if (high < 4 || high < 2 * Math.max(low,0.5)) return {start,end,direction:null};
  // Lines that begin at the top were turned clockwise: 270 undoes it; beginning at the bottom, 90.
  return {start,end,direction:start < end ? 270 : 90};
}
// A six-page outline-glyph document took 140ms here; 200 left too little for a slower PC.
const IMAGE_PROBE_MS = 500;
(() => {
  const load = location.search;
  const send = value => parent.postMessage({...value, load}, '*');
  let app, ready = false, failed = false, worker, workerUrl;
  let pagesLoaded = false, pendingGoto = null, applyingPage = false;
  let positionReceived = false, rotationApplied = false, pendingRotation = null, automaticRotation = 0;
  let automaticImage = false, imageCorrection = false, cancelImageProbe;
  let initialized = false, stallTimer, stalled = false;
  const steps = {initialize:'not-started',preferences:'pending',l10n:'not-started',components:'not-started'};
  let request = 0, query = '', textGeneration = 0;
  const destinations = new Map();
  const stage = name => { if (!failed) send({type:'stage',name}); };
  const error = (code, cause) => {
    if (failed) return;
    failed = true; ready = false; pendingGoto = null;
    cancelImageProbe?.();
    clearTimeout(stallTimer);
    send({type:'error',code,detail:String(cause?.message ?? cause ?? '').slice(0,4096)});
  };
  addEventListener('error',event => error('pdfFailed',event.message || event.error));
  addEventListener('unhandledrejection',event => error('pdfFailed',event.reason));
  stage('start');
  function observe(owner, method, step) {
    const original = owner[method];
    owner[method] = async function (...args) {
      steps[step] = 'pending';
      try {
        const result = await original.apply(this,args);
        steps[step] = 'resolved';
        return result;
      } catch (cause) {
        steps[step] = 'rejected'; error('pdfFailed',`${step}: ${cause?.message ?? cause}`);
        throw cause;
      }
    };
  }
  function stallSnapshot() {
    stallTimer = undefined;
    if (initialized || failed || stalled) return;
    stalled = true;
    let snapshot = {};
    try {
    const read = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
    const number = value => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER,Math.round(value)) : null;
    const word = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64) : null;
    const prefix = read(() => `/${new URL(location.href).pathname.split('/')[1]}/`,'/');
    const path = name => read(() => {
      if (typeof name !== 'string') return null;
      const url = new URL(name,location.href);
      if (!['http:','https:'].includes(url.protocol)) return '/[other]';
      const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length - 1) : url.pathname;
      return path.replace(/[a-f\d]{64}/gi,'[token]').slice(0,128);
    });
    const resources = read(() => performance.getEntriesByType('resource').slice(-15),[]).map(entry => ({
      name:read(() => path(entry.name)),responseStatus:read(() => number(entry.responseStatus)),
      duration:read(() => number(entry.duration)),transferSize:read(() => number(entry.transferSize)),
    }));
    snapshot = {readyState:read(() => document.readyState),l10n:read(() => typeof app.l10n),
      pdfViewer:read(() => !!app.pdfViewer),preferences:read(() => !!app.preferences),initialized:read(() => !!app.initialized),
      options:read(() => Object.keys(window.PDFViewerApplicationOptions.getAll()).length),
      locale:read(() => word(navigator.locale)),language:read(() => word(navigator.language)),fonts:read(() => word(document.fonts?.status)),
      navigationStatus:read(() => number(performance.getEntriesByType('navigation')[0]?.responseStatus)),steps:{...steps},resources};
    while (JSON.stringify(snapshot).length > 8192 && resources.length) resources.shift();
    } catch (cause) { snapshot.raw = String(cause?.message ?? cause ?? 'snapshot failed').slice(0,2000); }
    send({type:'stall',snapshot});
  }
  function publishPage() {
    if (!ready || !pagesLoaded || !positionReceived || failed || applyingPage || (pendingGoto !== null && app.page !== pendingGoto)) return;
    pendingGoto = null;
    send({type:'page',n:app.page});
    void pageText();
  }
  function applyGoto() {
    if (!ready || !pagesLoaded || !positionReceived || failed) return;
    if (typeof pendingGoto === 'string') {
      pendingGoto = destinations.get(pendingGoto) ?? null;
      if (pendingGoto === null) return;
    }
    if (pendingGoto > app.pagesCount) { pendingGoto = null; return; }
    const rotation = pendingRotation ?? (!rotationApplied ? {deg:automaticRotation,auto:automaticRotation !== 0} : null);
    const targetPage = pendingGoto ?? app.page;
    pendingRotation = null;
    applyingPage = true;
    try {
      if (rotation) {
        if (rotation.auto) imageCorrection = automaticImage;
        if (rotation.deg === 0) imageCorrection = false;
        rotationApplied = true; app.pdfViewer.pagesRotation = rotation.deg;
      }
      if (rotation || pendingGoto !== null) app.page = targetPage;
      // Resize restores the cached view location; refresh after both setters.
      app.pdfViewer.update();
    } finally { applyingPage = false; }
    // The rotation setter emits synchronously, and emits nothing for the same angle.
    if (rotation) publishRotation(rotation.auto);
    // The setter can dispatch pagechanging synchronously; acknowledge after it returns.
    publishPage();
  }
  function publishRotation(auto) {
    send({type:'rotated',deg:app.pdfViewer.pagesRotation,auto,...(imageCorrection ? {image:true} : {})});
  }
  function orientation(counts) {
    const total = counts.reduce((sum,count) => sum + count,0);
    const largest = Math.max(...counts), quarter = counts.indexOf(largest);
    return total >= 20 && largest / total >= 0.8 ? quarter * 90 : 0;
  }
  async function detectOrientation(pdf) {
    const counts = [0,0,0,0];
    let textCount = 0;
    try {
      for (let n = 1; n <= Math.min(3,pdf.numPages); n++) {
        const page = await pdf.getPage(n);
        if (failed || pdf !== app.pdfDocument) return 0;
        const content = await page.getTextContent();
        if (failed || pdf !== app.pdfDocument) return 0;
        for (const item of content.items) {
          if (typeof item.str !== 'string' || !item.str.trim()) continue;
          textCount++;
          if (content.styles?.[item.fontName]?.vertical) continue;
          const [a,b] = item.transform ?? [];
          if (!Number.isFinite(a) || !Number.isFinite(b) || (!a && !b)) continue;
          const angle = Math.abs(a) >= Math.abs(b) ? (a > 0 ? 0 : 180) : (b > 0 ? 90 : 270);
          counts[((angle - page.rotate + 360) % 360) / 90]++;
        }
      }
    } catch { return 0; /* Text extraction failure only disables automatic correction. */ }
    if (textCount < 20 && !rotationApplied && pendingRotation === null) return detectImageOrientation(pdf);
    return orientation(counts);
  }
  async function detectImageOrientation(pdf) {
    let canvas, task, timer, n = 1;
    // The first page is already on screen; only ready (outline, goto) waits for this budget.
    const start = performance.now(), late = () => performance.now() - start >= IMAGE_PROBE_MS;
    const round = value => value === null ? null : Math.round(value * 10000) / 10000;
    // Every verdict reaches the parent, so a silent refusal can be told apart from a slow one.
    const report = (reason,profile = {}) => {
      if (failed || pdf !== app.pdfDocument) return;
      send({type:'orientation',page:n,ms:round(performance.now() - start),ink:round(profile.ink ?? null),
        rowEnergy:round(profile.rowEnergy ?? null),colEnergy:round(profile.colEnergy ?? null),decision:profile.decision ?? null,
        start:round(profile.start ?? null),end:round(profile.end ?? null),direction:profile.direction ?? null,reason});
    };
    const votes = [];
    try {
      canvas = document.createElement('canvas');
      const context = canvas.getContext('2d',{alpha:false,willReadFrequently:true});
      if (!context) { report('error'); return 0; }
      const timeout = new Promise((_,reject) => {
        cancelImageProbe = () => { const active = task; task = null; active?.cancel(); reject(new Error('image orientation cancelled')); };
        timer = setTimeout(cancelImageProbe,IMAGE_PROBE_MS);
      });
      for (; n <= Math.min(2,pdf.numPages); n++) {
        const page = await Promise.race([pdf.getPage(n),timeout]);
        if (failed || pdf !== app.pdfDocument) return 0;
        if (late()) { report('timeout'); return 0; }
        // Drawn as displayed with /Rotate, so rows, columns and the reading direction need no remapping.
        const base = page.getViewport({scale:1,rotation:page.rotate});
        const viewport = page.getViewport({scale:Math.min(1,512 / Math.max(base.width,base.height)),rotation:page.rotate});
        canvas.width = Math.max(1,Math.min(512,Math.ceil(viewport.width)));
        canvas.height = Math.max(1,Math.min(512,Math.ceil(viewport.height)));
        task = page.render({canvas,viewport,background:'#ffffff',annotationMode:0});
        await Promise.race([task.promise,timeout]);
        task = null;
        if (failed || pdf !== app.pdfDocument) return 0;
        if (late()) { report('timeout'); return 0; }
        const {width,height} = canvas;
        const pixels = context.getImageData(0,0,width,height).data;
        const rows = new Uint32Array(height), cols = new Uint32Array(width);
        const first = new Int32Array(width).fill(-1), last = new Int32Array(width);
        // Outline glyphs of 0.7pt strokes shrink to grey when scaled down; 128 kept too little of a cover page.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4;
          if (pixels[at] * 299 + pixels[at+1] * 587 + pixels[at+2] * 114 < 200000) {
            rows[y]++; cols[x]++; if (first[x] < 0) first[x] = y; last[x] = y;
          }
        }
        const profile = inkProfile(rows,cols);
        if (late()) { report('timeout',profile); return 0; }
        if (profile.decision !== 270) { report(n > 1 ? 'disagree' : profile.reason,profile); return 0; }
        const inked = [...cols.keys()].filter(x => cols[x] >= 2);
        const edges = directionFromEdges(inked.map(x => first[x]),inked.map(x => last[x]));
        if (edges.direction !== null) votes.push(edges.direction);
        report('sideways',{...profile,...edges});
      }
      automaticImage = true;
      // Agreeing votes choose the side; none or a split keeps the old default, which the pill can reverse.
      return votes.length && votes.every(vote => vote === votes[0]) ? votes[0] : 270;
    } catch {
      // A failed or slow probe must not prevent opening the PDF.
      report(late() ? 'timeout' : 'error'); return 0;
    }
    finally {
      clearTimeout(timer); task?.cancel(); cancelImageProbe = undefined;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  async function pageText() {
    if (!ready) return;
    const generation = ++textGeneration, page = app.page;
    try {
      const content = await (await app.pdfDocument.getPage(page)).getTextContent();
      if (generation === textGeneration && ready) send({type:'pageText',page,hasText:content.items.some(item => typeof item.str === 'string' && item.str.trim())});
    } catch { /* A failed text extraction is not proof of an image-only page. */ }
  }
  async function documentReady() {
    try {
      const pdf = app.pdfDocument;
      const outline = await pdf.getOutline();
      const headings = [], pending = (outline ?? []).slice(0,10000).map(item => ({item,level:1})).reverse();
      let visited = 0;
      while (pending.length && visited++ < 10000) {
        const {item,level} = pending.pop();
        let dest = item.dest, page;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) {
          try { page = Number.isInteger(dest[0]) ? dest[0] + 1 : await pdf.getPageIndex(dest[0]) + 1; } catch {}
        }
        if (Number.isSafeInteger(page) && page >= 1 && page <= pdf.numPages) {
          const id = `o${headings.length}`;
          destinations.set(id,page);
          headings.push({id,level:Math.min(level,6),text:String(item.title ?? '').slice(0,4096)});
        }
        // Bound pending work as well as output on deeply nested/unlinked outlines.
        for (const child of (item.items ?? []).slice(0,10000 - pending.length).reverse()) pending.push({item:child,level:level+1});
      }
      if (failed || pdf !== app.pdfDocument) return;
      await app.pdfViewer.onePageRendered;
      if (failed || pdf !== app.pdfDocument) return;
      automaticRotation = await detectOrientation(pdf);
      if (failed || pdf !== app.pdfDocument) return;
      ready = true;
      send({type:'ready',title:document.title.slice(0,4096),pages:pdf.numPages,headings});
      applyGoto();
    } catch (cause) { error('pdfFailed',cause); }
  }
  document.addEventListener('webviewerloaded', () => {
    stage('webviewerloaded');
    app = window.PDFViewerApplication;
    const options = window.PDFViewerApplicationOptions;
    try {
      // initializedPromise is only resolved by PDF.js; a rejected initialize() leaves it pending.
      observe(app,'initialize','initialize');
      observe(app.externalServices,'createL10n','l10n');
      observe(app,'_initializeViewerComponents','components');
      app.preferences.initializedPromise.then(() => { steps.preferences = 'resolved'; },() => { steps.preferences = 'rejected'; });
      const workerSrc = new URL('../build/pdf.worker.mjs',location.href).href;
      // Chromium rejects a blob:null module-worker entry point in opaque frames.
      // A classic Blob entry can import the same fixed ESM without changing CSP.
      // A rejected import() stays in the worker and does not fire its owner's error event.
      const bootstrap = `const fail = cause => postMessage({type:'pdfWorkerError',detail:String(cause?.message ?? cause ?? '').slice(0,4096)});
addEventListener('unhandledrejection',event => fail(event.reason));
postMessage({type:'pdfWorkerStage',name:'worker-start'});
import(${JSON.stringify(workerSrc)}).then(() => postMessage({type:'pdfWorkerStage',name:'worker-imported'}),fail);`;
      workerUrl = URL.createObjectURL(new Blob([bootstrap],{type:'text/javascript'}));
      worker = new Worker(workerUrl);
      worker.addEventListener('error',event => error('pdfFailed',event.message || event.error));
      worker.addEventListener('message',({data}) => {
        if (data?.type === 'pdfWorkerError' && typeof data.detail === 'string') error('pdfFailed',data.detail);
        else if (data?.type === 'pdfWorkerStage' && ['worker-start','worker-imported'].includes(data.name)) {
          stage(data.name);
          if (data.name === 'worker-imported' && !initialized && !failed && !stalled && stallTimer === undefined) {
            stallTimer = setTimeout(stallSnapshot,8000);
          }
        }
      });
      options.setAll({workerPort:worker,disableStream:true,disableAutoFetch:true,
        annotationEditorMode:-1,annotationMode:1,enableSignatureEditor:false,enableSplitMerge:false,enableMerge:false,
        disableHistory:true,disablePreferences:true,viewOnLoad:1});
      app.initializedPromise.then(() => {
        initialized = true; clearTimeout(stallTimer); stallTimer = undefined;
        stage('initializedPromise');
        // Opening inside the embedded viewer would bypass the app's document identity.
        app.appConfig.secondaryToolbar.openFileButton.hidden = true;
        app.passwordPrompt.open = async () => { error('pdfEncrypted'); await app.close(); };
        app.eventBus.on('documenterror',event => error('pdfFailed',event?.message));
        app.eventBus.on('documentinit',() => {
          stage('documentinit');
          app.pdfViewer.onePageRendered.then(() => stage('onePageRendered'),cause => error('pdfFailed',cause));
          void documentReady();
        });
        app.eventBus.on('pagesinit',() => stage('pagesinit'));
        app.eventBus.on('pagesloaded',() => { stage('pagesloaded'); pagesLoaded = true; applyGoto(); });
        app.eventBus.on('pagechanging',publishPage);
        app.eventBus.on('rotationchanging',({pagesRotation}) => {
          if (failed || applyingPage) return;
          rotationApplied = true; pendingRotation = null;
          if (pagesRotation === 0) imageCorrection = false;
          publishRotation(false);
        });
        const found = ({matchesCount}) => {
          if (!ready || !matchesCount || app.findController.state?.query !== query) return;
          send({type:'found',n:Math.min(100000,matchesCount.total),index:Math.min(100000,matchesCount.current),request});
        };
        app.eventBus.on('updatefindmatchescount',found);
        app.eventBus.on('updatefindcontrolstate',found);
      }).catch(cause => error('pdfFailed',cause));
    } catch (cause) { error('pdfFailed',cause); }
  },{once:true});
  addEventListener('message', event => {
    if (event.source !== parent || failed || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.type === 'goto') {
      if (value.rotation !== undefined && ![0,90,180,270].includes(value.rotation)) return;
      const target = typeof value.id === 'string' ? value.id : value.page;
      if (typeof target === 'string') {
        if (!target || target.length > 2048 || (ready && !destinations.has(target))) return;
      } else if (!Number.isSafeInteger(target) || target < 1 || (app?.pagesCount && target > app.pagesCount)) return;
      pendingGoto = target;
      positionReceived = true;
      if (value.rotation !== undefined) pendingRotation = {deg:value.rotation,auto:false};
      applyGoto();
    } else if (value.type === 'rotate' && [0,90,180,270].includes(value.deg)) {
      pendingRotation = {deg:value.deg,auto:false};
      applyGoto();
    } else if (ready && value.type === 'find' && typeof value.q === 'string' && value.q.length <= 4096
      && [1,-1].includes(value.dir) && Number.isSafeInteger(value.request) && value.request >= 0) {
      const again = query === value.q;
      query = value.q; request = value.request;
      app.eventBus.dispatch('find',{source:window,query,type:again?'again':'',findPrevious:value.dir === -1,
        caseSensitive:false,entireWord:false,highlightAll:true,matchDiacritics:false});
    }
  });
  addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || event.button !== 0 || !/^(https?:|mailto:|tel:)/i.test(link.getAttribute('href') ?? '')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    send({type:'link',href:link.href,kind:'external'});
  },true);
  addEventListener('keydown',event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  },true);
  addEventListener('drop',event => { event.preventDefault(); event.stopImmediatePropagation(); },true);
  addEventListener('pagehide',() => {
    ready = false; failed = true; pendingGoto = null; textGeneration++;
    cancelImageProbe?.();
    clearTimeout(stallTimer);
    worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl);
    void app?.close();
  },{once:true});
})();
