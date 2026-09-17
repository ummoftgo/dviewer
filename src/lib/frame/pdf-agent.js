// Trusted viewer bridge; the PDF and this iframe still have no app capabilities.
(() => {
  const load = location.search;
  const send = value => parent.postMessage({...value, load}, '*');
  let app, ready = false, failed = false, worker, workerUrl;
  let pagesLoaded = false, pendingGoto = null, applyingPage = false;
  let initialized = false, stallTimer, stalled = false;
  const steps = {initialize:'not-started',preferences:'pending',l10n:'not-started',components:'not-started'};
  let request = 0, query = '', textGeneration = 0;
  const destinations = new Map();
  const stage = name => { if (!failed) send({type:'stage',name}); };
  const error = (code, cause) => {
    if (failed) return;
    failed = true; ready = false; pendingGoto = null;
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
    if (!ready || !pagesLoaded || failed || applyingPage || (pendingGoto !== null && app.page !== pendingGoto)) return;
    pendingGoto = null;
    send({type:'page',n:app.page});
    void pageText();
  }
  function applyGoto() {
    if (!ready || !pagesLoaded || failed) return;
    if (typeof pendingGoto === 'string') {
      pendingGoto = destinations.get(pendingGoto) ?? null;
      if (pendingGoto === null) return;
    }
    if (pendingGoto !== null) {
      if (pendingGoto > app.pagesCount) { pendingGoto = null; return; }
      applyingPage = true;
      try {
        app.page = pendingGoto;
        // Resize restores the cached view location; refresh it after the setter scrolls.
        app.pdfViewer.update();
      } finally { applyingPage = false; }
    }
    // The setter can dispatch pagechanging synchronously; acknowledge after it returns.
    publishPage();
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
      const target = typeof value.id === 'string' ? value.id : value.page;
      if (typeof target === 'string') {
        if (!target || target.length > 2048 || (ready && !destinations.has(target))) return;
      } else if (!Number.isSafeInteger(target) || target < 1 || (app?.pagesCount && target > app.pagesCount)) return;
      pendingGoto = target;
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
    clearTimeout(stallTimer);
    worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl);
    void app?.close();
  },{once:true});
})();
