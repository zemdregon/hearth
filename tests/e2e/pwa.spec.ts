import { test, expect } from '@playwright/test';
import { createDemo } from '../../src/client/demo';

test.use({ baseURL: 'http://localhost:4173', serviceWorkers: 'allow' });

function privateFixture() {
  const fixture = { ...createDemo(), demo: false };
  fixture.user = { ...fixture.user, name: 'Private Fixture Person' };
  fixture.members = fixture.members.map(member => member.id === fixture.user.id ? fixture.user : member);
  return fixture;
}

test('production PWA precaches its first visit and reloads offline without private family data', async ({ page, context }) => {
  const fixture = privateFixture();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture, headers: { 'cache-control': 'no-store, private' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
  await expect(page.getByText(fixture.user.name, { exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const cacheEntries = await page.evaluate(async () => {
    const all: { url: string; text: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const mime = response?.headers.get('content-type') ?? '';
        all.push({ url: request.url, text: /(?:text|javascript|json)/.test(mime) ? await response!.text() : '' });
      }
    }
    return all;
  });
  expect(cacheEntries.some(entry => new URL(entry.url).pathname === '/index.html')).toBe(true);
  expect(cacheEntries.some(entry => /\/assets\/[^/]+\.js$/.test(entry.url))).toBe(true);
  expect(cacheEntries.some(entry => /\/assets\/[^/]+\.css$/.test(entry.url))).toBe(true);
  expect(cacheEntries.some(entry => /\/(?:api|cdn-cgi)\//.test(entry.url))).toBe(false);
  expect(cacheEntries.some(entry => entry.text.includes(fixture.user.name))).toBe(false);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  // Route fixtures must be removed: Playwright could otherwise fulfill them
  // despite browser offline mode and accidentally simulate offline family data.
  await page.unroute('**/api/bootstrap');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  await expect(page.getByText(fixture.user.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  expect(errors).toEqual([]);
});

test('production manifest icons decode to their declared dimensions', async ({ page }) => {
  await page.goto('/');
  const icons = await page.evaluate(async () => {
    const manifest = await (await fetch('/manifest.webmanifest')).json() as { icons: { src: string; type: string; sizes: string }[] };
    return Promise.all(manifest.icons.filter(icon => icon.type === 'image/png').map(async icon => {
      const image = new Image();
      image.src = icon.src;
      await image.decode();
      return { declared: icon.sizes, width: image.naturalWidth, height: image.naturalHeight };
    }));
  });
  expect(icons.length).toBeGreaterThanOrEqual(2);
  for (const icon of icons) expect(icon.declared).toBe(`${icon.width}x${icon.height}`);
  expect(icons.some(icon => icon.width === 192)).toBe(true);
  expect(icons.some(icon => icon.width === 512)).toBe(true);
});

test('sign-out clears private UI immediately, broadcasts to another tab, and stays clear on offline back navigation', async ({ page, context }) => {
  const fixture = privateFixture();
  await context.route('**/api/bootstrap', route => route.fulfill({ json: fixture, headers: { 'cache-control': 'no-store, private' } }));
  let releaseLogout: () => void = () => undefined;
  const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve; });
  await context.route('**/cdn-cgi/access/logout', async route => {
    await logoutGate;
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Signed out fixture</title><p>Signed out</p>', headers: { 'cache-control': 'no-store' } });
  });
  await page.goto('/');
  await expect(page.getByText(fixture.user.name, { exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByText(fixture.user.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  try {
    const retainsPrivateText = await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button, privateName) => {
      (button as HTMLButtonElement).click();
      // Inspect the synchronous clear in this execution context. A locator
      // assertion would wait for the intentionally paused navigation to finish.
      return document.body.textContent?.includes(privateName) ?? false;
    }, fixture.user.name);
    expect(retainsPrivateText).toBe(false);
    await expect(otherTab.getByText(fixture.user.name, { exact: true })).toHaveCount(0);
    await expect(otherTab.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  } finally { releaseLogout(); }
  await page.waitForURL('**/cdn-cgi/access/logout');
  await expect(page.getByText('Signed out', { exact: true })).toBeVisible();
  await context.unroute('**/api/bootstrap');
  await context.setOffline(true);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  await expect(page.getByText(fixture.user.name, { exact: true })).toHaveCount(0);
});
