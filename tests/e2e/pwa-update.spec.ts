import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const shellFor = (revision: string) => `<!doctype html><html lang="en"><head><meta name="hearth-public-shell" content="v1"><title>Offline update fixture</title></head><body><h1>Loading shell</h1><script type="module" src="/assets/app-${revision}.js"></script></body></html>`;

async function updateWorker(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('The existing worker is missing.');
    return new Promise<string>((resolve, reject) => {
      registration.addEventListener('updatefound', () => {
        const candidate = registration.installing;
        if (!candidate) return reject(new Error('The update candidate is missing.'));
        candidate.addEventListener('statechange', () => {
          if (candidate.state === 'redundant' || candidate.state === 'activated') resolve(candidate.state);
        });
      }, { once: true });
      void registration.update().catch(reject);
    });
  });
}

for (const failure of ['unavailable asset', 'different build document'] as const) {
test(`a PWA update with ${failure} retains its offline shell and a complete retry replaces it`, async ({ page, context }) => {
  const workerSource = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  let revision = 'first';
  let failUpdatedAsset = true;
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (path === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      const documentHash = createHash('sha256').update(shellFor(revision)).digest('hex');
      response.end(`self.__HEARTH_REVISION=${JSON.stringify(revision)};self.__HEARTH_PRECACHE=${JSON.stringify(['/index.html', `/assets/app-${revision}.js`])};self.__HEARTH_DOCUMENT_HASH=${JSON.stringify(documentHash)};\n${workerSource}`);
    } else if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=0' });
      response.end(shellFor(revision === 'second' && failUpdatedAsset && failure === 'different build document' ? 'third' : revision));
    } else if (path === '/assets/app-first.js' || path === '/assets/app-second.js') {
      if (path.includes('second') && failUpdatedAsset && failure === 'unavailable asset') {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.end('Temporary asset failure');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' });
        response.end(`document.querySelector('h1').textContent=${JSON.stringify(path.includes('first') ? 'First working shell' : 'Second working shell')};`);
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local fixture port.');
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.getByRole('heading', { name: 'First working shell' })).toBeVisible();
    await page.evaluate(async () => {
      // A preserved cache from another feature must never win offline navigation.
      const unrelated = await caches.open('another-app-cache');
      await unrelated.put('/index.html', new Response('<html><h1>Unrelated cached document</h1></html>', { headers: { 'Content-Type': 'text/html' } }));
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    revision = 'second';
    expect(await updateWorker(page)).toBe('redundant');
    expect(await page.evaluate(() => caches.keys())).toEqual(['another-app-cache', 'hearth-shell-first']);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'First working shell' })).toBeVisible();

    await context.setOffline(false);
    failUpdatedAsset = false;
    expect(await updateWorker(page)).toBe('activated');
    expect(await page.evaluate(() => caches.keys())).toEqual(['another-app-cache', 'hearth-shell-second']);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Second working shell' })).toBeVisible();
  } finally {
    await context.setOffline(false);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
}
