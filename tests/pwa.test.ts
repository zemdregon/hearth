import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://family.example.com';
type RequestLike = { url: string; method?: string; mode?: string; headers?: HeadersInit };
type CacheKey = string | RequestLike;
type EventLike = { request?: RequestLike; waitUntil(promise: Promise<unknown>): void; respondWith?(promise: Promise<Response>): void };
const keyOf = (key: CacheKey) => new URL(typeof key === 'string' ? key : key.url, origin).href;
const basicResponse = (body: string, contentType: string, headers: Record<string, string> = {}) => {
  const response = new Response(body, { headers: { 'content-type': contentType, ...headers } });
  // Browser fetch returns "basic" for a same-origin response. Node's Response
  // constructor returns "default", so model that browser boundary explicitly.
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
};

function workerHarness(network: (request: CacheKey, init?: RequestInit) => Promise<Response> = async () => basicResponse('export {}', 'text/javascript'), build?: { precache: string[]; revision: string }) {
  const storage = new Map<string, Map<string, Response>>();
  const storedRequestHeaders = new Map<string, Map<string, Headers>>();
  const listeners = new Map<string, (event: EventLike) => void>();
  const fetch = vi.fn(network);
  function matchEntry(name: string, key: CacheKey, options?: { ignoreVary?: boolean }) {
    const response = storage.get(name)?.get(keyOf(key));
    if (!response || options?.ignoreVary) return response;
    const original = storedRequestHeaders.get(name)?.get(keyOf(key)) ?? new Headers();
    const incoming = new Headers(typeof key === 'string' ? undefined : key.headers);
    const vary = (response.headers.get('vary') ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (vary.some(header => header === '*' || original.get(header) !== incoming.get(header))) return undefined;
    return response;
  }
  const cacheStorage = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new Map());
      if (!storedRequestHeaders.has(name)) storedRequestHeaders.set(name, new Map());
      const cache = storage.get(name)!;
      return {
        async put(key: CacheKey, response: Response) {
          cache.set(keyOf(key), response);
          storedRequestHeaders.get(name)!.set(keyOf(key), new Headers(typeof key === 'string' ? undefined : key.headers));
        },
        async match(key: CacheKey, options?: { ignoreVary?: boolean }) { return matchEntry(name, key, options); },
        async keys() { return [...cache.keys()].map(url => new Request(url)); },
      };
    },
    async match(key: CacheKey) {
      for (const name of storage.keys()) {
        const response = matchEntry(name, key);
        if (response) return response;
      }
      return undefined;
    },
    async keys() { return [...storage.keys()]; },
    async delete(name: string) { return storage.delete(name); },
  };
  const claim = vi.fn().mockResolvedValue(undefined);
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), {
    self: { location: { origin }, __HEARTH_PRECACHE: build?.precache, __HEARTH_REVISION: build?.revision, addEventListener(type: string, handler: (event: EventLike) => void) { listeners.set(type, handler); }, clients: { claim }, skipWaiting },
    caches: cacheStorage, fetch, URL, Response, Request, Headers, console,
  });
  async function dispatch(type: string, request?: RequestLike) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event: EventLike = { request, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { response = Promise.resolve(promise); } };
    listeners.get(type)?.(event);
    const result = response ? await response : undefined;
    while (pending.length) await Promise.all(pending.splice(0));
    return { handled: !!response, response: result };
  }
  return { dispatch, storage, cacheStorage, fetch, claim, skipWaiting };
}

describe('service worker privacy and cache routing', () => {
  it.each([
    { url: '/api/bootstrap' }, { url: '/api/export' }, { url: '/api/recipes/import', method: 'POST' },
    { url: '/cdn-cgi/access/logout', mode: 'navigate' }, { url: '/cdn-cgi/challenge-platform/flow' },
    { url: 'https://another.example.com/assets/app.js' }, { url: '/assets/app.js', method: 'POST' },
    { url: '/family-export.json' }, { url: '/private/photo.png' },
  ])('does not intercept private, Access, external or write request $url', async request => {
    const worker = workerHarness();
    const result = await worker.dispatch('fetch', { method: 'GET', mode: 'cors', ...request, url: new URL(request.url, origin).href });
    expect(result.handled).toBe(false);
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.storage.size).toBe(0);
  });

  it('serves API requests directly even if a stale cache happens to contain private data', async () => {
    const worker = workerHarness();
    const cache = await worker.cacheStorage.open('hearth-shell-v0');
    await cache.put('/api/bootstrap', Response.json({ records: ['old secret'] }));
    const result = await worker.dispatch('fetch', { url: `${origin}/api/bootstrap`, method: 'GET', mode: 'cors' });
    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('caches a successful public script and serves it offline', async () => {
    const worker = workerHarness();
    const request = { url: `${origin}/assets/app-a1b2.js`, method: 'GET', mode: 'cors' };
    expect((await worker.dispatch('fetch', request)).response?.ok).toBe(true);
    expect(await worker.cacheStorage.match(request)).toBeDefined();
    worker.fetch.mockRejectedValue(new TypeError('Network unavailable'));
    const offline = await worker.dispatch('fetch', request);
    expect(await offline.response?.text()).toBe('export {}');
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no-store', { 'cache-control': 'no-store, private' }],
    ['private', { 'cache-control': 'private, max-age=0' }],
    ['case-insensitive directives', { 'cache-control': 'NO-STORE' }],
  ])('does not persist a %s asset response', async (_name, headers) => {
    const worker = workerHarness(async () => basicResponse('personalized payload', 'text/javascript', headers));
    const request = { url: `${origin}/assets/app-private.js`, method: 'GET', mode: 'cors' };
    await worker.dispatch('fetch', request);
    expect(await worker.cacheStorage.match(request)).toBeUndefined();
  });

  it.each(['/assets/app-a1b2.js', '/assets/app-a1b2.css', '/icon-192.png'])('never caches a 200 Access challenge returned for %s', async path => {
    const worker = workerHarness(async () => basicResponse('<!doctype html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/script.js"></script>', 'text/html'));
    const request = { url: `${origin}${path}`, method: 'GET', mode: 'cors' };
    await worker.dispatch('fetch', request);
    expect(await worker.cacheStorage.match(request)).toBeUndefined();
  });

  it('does not cache successful but redirected asset responses', async () => {
    const worker = workerHarness(async () => {
      const response = basicResponse('Sign in', 'text/html');
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    const request = { url: `${origin}/assets/app-a1b2.js`, method: 'GET', mode: 'cors' };
    await worker.dispatch('fetch', request);
    expect(await worker.cacheStorage.match(request)).toBeUndefined();
  });

  it('does not persist navigation responses even when they contain private content', async () => {
    const worker = workerHarness(async () => basicResponse('<html>Private content</html>', 'text/html'));
    const request = { url: `${origin}/profile`, method: 'GET', mode: 'navigate' };
    const result = await worker.dispatch('fetch', request);
    expect(await result.response?.text()).toContain('Private content');
    expect(worker.storage.size).toBe(0);
  });

  it('gives an offline fallback without requesting private API data', async () => {
    const worker = workerHarness(async () => { throw new TypeError('Network unavailable'); });
    const result = await worker.dispatch('fetch', { url: `${origin}/`, method: 'GET', mode: 'navigate' });
    expect(result.response?.headers.get('content-type')).toContain('text/html');
    expect(await result.response?.text()).toMatch(/offline|internet/i);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it('never precaches authentication or challenge HTML during install', async () => {
    const worker = workerHarness(async () => basicResponse('<!doctype html><title>Cloudflare Access</title><form>Sign in to this application</form>', 'text/html'));
    await worker.dispatch('install');
    expect([...worker.storage.values()].flatMap(cache => [...cache.keys()])).toEqual([]);
    for (const [, init] of worker.fetch.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('same-origin');
    }
  });

  it('cleans old Hearth cache versions without deleting unrelated caches', async () => {
    const worker = workerHarness(async () => { throw new Error('Offline'); });
    await worker.cacheStorage.open('hearth-shell-obsolete-build');
    await worker.cacheStorage.open('another-app-cache');
    await worker.dispatch('install');
    await worker.dispatch('activate');
    expect(worker.storage.has('hearth-shell-obsolete-build')).toBe(false);
    expect(worker.storage.has('another-app-cache')).toBe(true);
    expect(worker.claim).toHaveBeenCalledOnce();
  });

  it('precaches the generated build entry assets on the first installation', async () => {
    const build = { precache: ['/index.html', '/assets/app-a1b2.js', '/assets/app-a1b2.css'], revision: 'test-build-one' };
    const worker = workerHarness(async request => {
      const path = new URL(keyOf(request)).pathname;
      return path === '/index.html' ? basicResponse(readFileSync(resolve('index.html'), 'utf8'), 'text/html')
        : path.endsWith('.css') ? basicResponse('body{color:#123}', 'text/css') : basicResponse('export {}', 'text/javascript');
    }, build);
    await worker.dispatch('install');
    for (const path of build.precache) expect(await worker.cacheStorage.match(path)).toBeDefined();
    expect(worker.storage.has('hearth-shell-test-build-one')).toBe(true);
  });

  it('limits production asset caching to the exact generated build list', async () => {
    const worker = workerHarness(undefined, { precache: ['/index.html', '/assets/app-a1b2.js'], revision: 'test-build-two' });
    const result = await worker.dispatch('fetch', { url: `${origin}/assets/arbitrary-private.js`, method: 'GET', mode: 'cors' });
    expect(result.handled).toBe(false);
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it('reuses a precached public module when browser module requests add an Origin header', async () => {
    const worker = workerHarness(async () => basicResponse('export {}', 'text/javascript', { vary: 'Origin' }), { precache: ['/assets/app-a1b2.js'], revision: 'vary-origin-build' });
    await worker.dispatch('install');
    worker.fetch.mockRejectedValue(new TypeError('Offline'));
    const request = { url: `${origin}/assets/app-a1b2.js`, method: 'GET', mode: 'cors', headers: { Origin: origin } };
    const result = await worker.dispatch('fetch', request);
    expect(await result.response?.text()).toBe('export {}');
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('installable PWA assets', () => {
  it('declares usable local raster icons at the required dimensions', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/manifest.webmanifest'), 'utf8'));
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((item: { sizes: string; type: string }) => item.sizes === `${size}x${size}` && item.type === 'image/png');
      expect(icon).toBeDefined();
      expect(icon.src).toMatch(/^\/[a-z0-9-]+\.png$/);
      const bytes = readFileSync(resolve(`public${icon.src}`));
      expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(header.getUint32(16)).toBe(size);
      expect(header.getUint32(20)).toBe(size);
    }
  });
});
