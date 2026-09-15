// Trusted viewer bridge; the PDF and this iframe still have no app capabilities.
(() => {
  const load = location.search;
  const send = value => parent.postMessage({...value, load}, '*');
  let app, ready = false, failed = false, worker, workerUrl;
  let request = 0, query = '', textGeneration = 0;
  const destinations = new Map();
  const error = code => { if (!failed) { failed = true; ready = false; send({type:'error',code}); } };
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
      send({type:'page',n:app.page});
      void pageText();
    } catch { error('pdfFailed'); }
  }
  document.addEventListener('webviewerloaded', () => {
    app = window.PDFViewerApplication;
    const options = window.PDFViewerApplicationOptions;
    try {
      const workerSrc = new URL('../build/pdf.worker.mjs',location.href).href;
      // Chromium rejects a blob:null module-worker entry point in opaque frames.
      // A classic Blob entry can import the same fixed ESM without changing CSP.
      workerUrl = URL.createObjectURL(new Blob([`import(${JSON.stringify(workerSrc)});`],{type:'text/javascript'}));
      worker = new Worker(workerUrl);
      worker.addEventListener('error',() => error('pdfFailed'));
      options.setAll({workerPort:worker,disableStream:true,disableAutoFetch:true,
        annotationEditorMode:-1,annotationMode:1,enableSignatureEditor:false,enableSplitMerge:false,enableMerge:false,
        disableHistory:true,disablePreferences:true,viewOnLoad:1});
      app.initializedPromise.then(() => {
        // Opening inside the embedded viewer would bypass the app's document identity.
        app.appConfig.secondaryToolbar.openFileButton.hidden = true;
        app.passwordPrompt.open = async () => { error('pdfEncrypted'); await app.close(); };
        app.eventBus.on('documenterror',() => error('pdfFailed'));
        app.eventBus.on('documentinit',() => void documentReady());
        app.eventBus.on('pagechanging',({pageNumber}) => {
          if (!ready) return;
          send({type:'page',n:pageNumber}); void pageText();
        });
        const found = ({matchesCount}) => {
          if (!ready || !matchesCount || app.findController.state?.query !== query) return;
          send({type:'found',n:Math.min(100000,matchesCount.total),index:Math.min(100000,matchesCount.current),request});
        };
        app.eventBus.on('updatefindmatchescount',found);
        app.eventBus.on('updatefindcontrolstate',found);
      }).catch(() => error('pdfFailed'));
    } catch { error('pdfFailed'); }
  },{once:true});
  addEventListener('message', event => {
    if (event.source !== parent || !ready || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.type === 'goto') {
      const page = typeof value.id === 'string' ? destinations.get(value.id) : value.page;
      if (!Number.isSafeInteger(page) || page < 1 || page > app.pagesCount) return;
      app.page = page;
      // A same-page restore must acknowledge its completion too.
      send({type:'page',n:app.page});
    } else if (value.type === 'find' && typeof value.q === 'string' && value.q.length <= 4096
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
    ready = false; failed = true; textGeneration++;
    worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl);
    void app?.close();
  },{once:true});
})();
