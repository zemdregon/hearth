/* The build prepends a revision and a list of public, immutable assets. Family
 * API data, auth responses and arbitrary URLs must never enter this cache. */
const CACHE = `hearth-shell-${self.__HEARTH_REVISION || 'dev'}`;
const SHELL = self.__HEARTH_PRECACHE || ['/index.html', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable.png', '/manifest.webmanifest'];

async function safeToCache(path, response) {
  if (!response.ok || response.type !== 'basic' || response.redirected) return false;
  if (/(?:^|,)\s*(?:no-store|private)\b/i.test(response.headers.get('cache-control') || '')) return false;
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (path === '/' || path === '/index.html') {
    if (mime !== 'text/html') return false;
    // A successful Cloudflare challenge is not the public application shell.
    const document = await response.clone().arrayBuffer();
    if (!/<meta\s+name=["']?hearth-public-shell["']?\s+content=["']?v1["']?\s*\/?\s*>/i.test(new TextDecoder().decode(document))) return false;
    // Overlapping deployments can serve HTML from a different build, pointing
    // at scripts absent from this worker's precache. Accept this build only.
    if (self.__HEARTH_DOCUMENT_HASH) {
      const digest = await crypto.subtle.digest('SHA-256', document);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') === self.__HEARTH_DOCUMENT_HASH;
    }
    return true;
  }
  if (/\.js$/.test(path)) return mime === 'text/javascript' || mime === 'application/javascript';
  if (/\.css$/.test(path)) return mime === 'text/css';
  if (/\.svg$/.test(path)) return mime === 'image/svg+xml';
  if (/\.png$/.test(path)) return mime === 'image/png';
  if (/\.woff2?$/.test(path)) return /^(?:font\/woff2?|application\/font-woff)$/.test(mime);
  if (path === '/manifest.webmanifest') return mime === 'application/manifest+json' || mime === 'application/json';
  return false;
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    // An interrupted update must not replace a complete offline shell. Wait for
    // every write before removing a failed candidate, so late writes cannot
    // recreate a partial cache after cleanup.
    const results = await Promise.allSettled(SHELL.map(async path => {
      if (path.startsWith('/api/') || path.startsWith('/cdn-cgi/')) throw new Error('Private precache path.');
      const response = await fetch(path, { credentials: 'same-origin', cache: 'reload', redirect: 'error' });
      if (!await safeToCache(path, response)) throw new Error('Public asset unavailable.');
      await cache.put(path, response);
    }));
    if (results.some(result => result.status === 'rejected')) {
      await caches.delete(CACHE);
      throw new Error('The public app shell could not be installed completely.');
    }
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('hearth-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;
  if (request.mode === 'navigate') {
    // Navigation stays network-first and its response is never persisted.
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(CACHE)).match('/index.html', { ignoreVary: true })) || new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Hearth is offline</title><body style="font-family:system-ui;padding:3rem;background:#f7f6f2;color:#315343"><h1>A little pause.</h1><p>Connect to the internet to return to your family space.</p><a href="/">Try again</a></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  const publicAsset = SHELL.includes(url.pathname) || !self.__HEARTH_PRECACHE && /^\/assets\/[^/]+\.(js|css|woff2?|svg|png)$/.test(url.pathname);
  if (!publicAsset || url.search) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    // Public build assets are identical across Origin/CORS request modes.
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (await safeToCache(url.pathname, response)) {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy));
    }
    return response;
  }));
});
