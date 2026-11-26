// Golf Scores service worker: lets the app open on the course with no signal.
// The page itself is network-first (so updates show up straight away), everything else cache-first.
// Live scores are NOT handled here: Firestore keeps its own offline copy and syncs when back online.
const V = 'gs-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isPage = req.mode === 'navigate' || (sameOrigin && /\/(index\.html)?$/.test(url.pathname));
  const isStatic = sameOrigin
    || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com'
    || (url.host === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
  if (!isPage && !isStatic) return;            // Firestore / Auth traffic goes straight to the network
  if (isPage) {
    e.respondWith((async () => {
      const c = await caches.open(V);
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
        // no-cache: always ask the server (cheap 304 if unchanged), so an update shows on the next open, not 10 minutes later
        const res = await fetch(req.url, { signal: ctl.signal, cache: 'no-cache', credentials: 'same-origin' }); clearTimeout(t);
        if (res.ok) c.put('./index.html', res.clone());
        return res;
      } catch {
        return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(V);
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
