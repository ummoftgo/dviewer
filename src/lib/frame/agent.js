// Runs inside the document's opaque sandbox. The host validates every message.
(() => {
  const load = location.search;
  parent.postMessage({type:'agentStart', load}, '*');
  const send = value => parent.postMessage({...value, load}, '*');
  const MAX_HEADINGS = 10000, MAX_MATCHES = 100000;
  let blocked = 0, scrollTimer, search = 0;
  let query = '', ranges = [], selected = -1, built = false;
  addEventListener('securitypolicyviolation', () => send({type:'blocked', n:++blocked}));
  const currentRatio = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? Math.max(0, Math.min(1, scrollY / max)) : 0;
  };
  addEventListener('scroll', () => {
    if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = undefined; send({type:'scroll', ratio:currentRatio()}); }, 100);
  }, {passive:true});
  const goto = id => { document.getElementById(id)?.scrollIntoView(); };
  addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || event.button !== 0 || event.defaultPrevented) return;
    const href = link.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (href.startsWith('#')) {
      try { goto(decodeURIComponent(href.slice(1))); } catch {}
    } else send({type:'link', href, kind:/^(https?:|mailto:|tel:)/i.test(href) ? 'external' : 'relative'});
  });
  async function find(q, direction, request) {
    const generation = ++search;
    if (query !== q || !built) {
      query = q; ranges = []; selected = -1; built = false;
      if (q) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) { return node.parentElement?.closest('script,style,noscript,textarea,[hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
        });
        let node, visited = 0;
        // Search one text node at a time; never assemble a second document string.
        while ((node = walker.nextNode())) {
          const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
          let match;
          while ((match = pattern.exec(node.textContent)) && ranges.length < MAX_MATCHES) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            ranges.push(range);
          }
          if (ranges.length >= MAX_MATCHES) break;
          if (++visited % 4096 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (generation !== search) return;
          }
        }
      }
    }
    if (generation !== search) return;
    built = true;
    if (ranges.length) {
      selected = selected < 0 ? (direction === 1 ? 0 : ranges.length - 1) : (selected + direction + ranges.length) % ranges.length;
      const range = ranges[selected];
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({block:'center'});
    } else { selected = -1; getSelection()?.removeAllRanges(); }
    send({type:'found', n:ranges.length, index:selected + 1, request});
  }
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.type === 'goto') {
      if (typeof value.id === 'string') goto(value.id);
      else if (Number.isFinite(value.ratio)) scrollTo(0, Math.max(0, Math.min(1, value.ratio)) * Math.max(0, document.documentElement.scrollHeight - innerHeight));
    } else if (value.type === 'theme' && typeof value.dark === 'boolean') {
      document.documentElement.dataset.dviewerTheme = value.dark ? 'dark' : 'light';
    } else if (value.type === 'find' && typeof value.q === 'string' && value.q.length <= 4096
      && (value.dir === 1 || value.dir === -1) && Number.isSafeInteger(value.request)) void find(value.q, value.dir, value.request);
  });
  addEventListener('keydown', event => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['Escape','F11'].includes(event.key)) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!event.repeat) send({type:'shortcut',key:event.key === 'F11' ? 'focus' : 'escape'});
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f','e'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      send({type:'shortcut',key:event.key.toLowerCase() === 'f' ? 'find' : 'raw'});
    }
  });
  function ready() {
    const used = new Set([...document.querySelectorAll('[id]')].map(node => node.id));
    const seen = new Set();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, MAX_HEADINGS).map((node, index) => {
      if (!node.id || seen.has(node.id)) {
        let id = `dv-h-${index}`, suffix = 0;
        while (used.has(id)) id = `dv-h-${index}-${++suffix}`;
        node.id = id; used.add(id);
      }
      seen.add(node.id);
      return {id:node.id.slice(0,2048), level:Number(node.tagName[1]), text:(node.textContent ?? '').trim().slice(0,4096)};
    });
    send({type:'ready', title:document.title.slice(0,4096), headings});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true});
  else ready();
  const loaded = () => {
    Promise.resolve(document.fonts?.ready).then(() => send({type:'loaded',scrollable:document.documentElement.scrollHeight > innerHeight}));
  };
  if (document.readyState === 'complete') loaded();
  else addEventListener('load',loaded,{once:true});
  // This marker is emitted by the server only for an authorized smoke response.
  if (document.currentScript?.hasAttribute('data-probe')) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals) send({type:'probe', invoke:'absent'});
    else {
      let finished = false;
      const timer = setTimeout(() => { finished = true; send({type:'probe', invoke:'timeout'}); }, 5000);
      Promise.resolve().then(() => internals.invoke('encoding_choices')).then(() => {
        clearTimeout(timer); send({type:'isolationBroken'});
      }, error => {
        clearTimeout(timer);
        if (!finished) send({type:'probe', invoke:'rejected:' + String(error).slice(0,4096)});
      });
    }
  }
})();
