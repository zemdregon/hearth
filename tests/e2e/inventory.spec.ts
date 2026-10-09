import { readFileSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';
import type { Bootstrap } from '../../src/shared/types';
import type { InvLedgerEntry, InventoryState } from '../../src/shared/inventory/wire';

const ORIGIN = 'http://localhost:5173';
const authFile = new URL('../../.wrangler/e2e-auth.json', import.meta.url);
const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
const test = base.extend({
  storageState: async ({}, use) => {
    const { sessions } = JSON.parse(readFileSync(authFile, 'utf8')) as { sessions: Record<string, string> };
    await use({ cookies: [{ name: '__Host-hearth_session', value: sessions.alex, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' }], origins: [] });
  },
});
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const dialogOf = (page: Page) => page.getByRole('dialog');
const lotRow = (page: Page, text: string | RegExp) => page.locator('.inventory-lot').filter({ hasText: text });

/* ------------------------------------------------------------------ real Worker + local D1 */

async function setModule(request: APIRequestContext, enabled: boolean) {
  const response = await request.patch('/api/modules/inventory', { headers, data: { enabled } });
  expect(response.status(), 'module toggle').toBe(200);
}
/** Leaves the disposable e2e database with inventory switched off and nothing active in it. */
async function resetInventory(request: APIRequestContext) {
  await setModule(request, true);
  const state = await (await request.get('/api/inventory')).json() as InventoryState;
  for (const lot of state.lots) expect((await request.post(`/api/inventory/lots/${lot.id}/archive`, { headers, data: { txnId: `cleanup-${crypto.randomUUID()}`, version: lot.version, reason: 'Test cleanup' } })).ok()).toBe(true);
  for (const item of state.items) expect((await request.post(`/api/inventory/items/${item.id}/archive`, { headers, data: { version: item.version } })).ok()).toBe(true);
  for (const place of state.locations) expect((await request.post(`/api/inventory/locations/${place.id}/archive`, { headers, data: { version: place.version } })).ok()).toBe(true);
  await setModule(request, false);
}
async function makeItem(request: APIRequestContext, name: string, dim = 'mass') {
  const response = await request.post('/api/inventory/items', { headers, data: { name, dim } });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string; version: number };
}
async function makeLot(request: APIRequestContext, itemId: string, amount: string, unit: string) {
  const response = await request.post('/api/inventory/lots', { headers, data: { txnId: `seed-${crypto.randomUUID()}`, itemId, locationId: null, amount, unit, precision: 'exact', note: '' } });
  expect(response.status()).toBe(201);
}

test.describe('Inventory on the real Worker and local D1', () => {
  test.setTimeout(120000);
  // Each test leaves behind an empty inventory with the module switched off (the Worker allows 240 writes an hour per member, so cleanup stays lean).
  test.beforeEach(async ({ request }) => { await setModule(request, false); });
  test.afterEach(async ({ request }) => { await resetInventory(request); });

  test('is off by default, hidden from navigation, and an administrator can switch it on', async ({ page }) => {
    await page.goto('/#settings');
    const toggle = page.getByRole('switch', { name: 'Enable Inventory' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('heading', { name: 'Inventory', level: 2 })).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Inventory' })).toHaveCount(0);
    await page.goto('/#inventory');
    await expect(page.getByRole('heading', { name: 'A little room to pause' })).toBeVisible();
    await page.getByRole('button', { name: 'Make it your own', exact: true }).first().click();
    await page.getByRole('switch', { name: 'Enable Inventory' }).click();
    await expect(page.getByRole('switch', { name: 'Disable Inventory' })).toHaveAttribute('aria-checked', 'true');
    await mainNav(page).getByRole('link', { name: 'Inventory' }).click();
    await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nothing on the shelves yet' })).toBeVisible();
  });

  test('builds a pantry: places, items, exact and estimated stock, adjustments, archive and history', async ({ page, request }) => {
    await setModule(request, true);
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/inventory/')) posts.push(new URL(request.url()).pathname); });
    await page.goto('/#inventory');
    await expect(page.getByRole('heading', { name: 'Nothing on the shelves yet' })).toBeVisible();

    // Places
    await page.getByRole('button', { name: 'Places', exact: true }).click();
    let dialog = dialogOf(page);
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await dialog.getByLabel('Name').fill('Pantry shelf');
    await dialog.getByRole('button', { name: 'Add place' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Added Pantry shelf.');
    await dialog.getByLabel('Name').fill('Garage freezer');
    await dialog.getByLabel('Kind of place').selectOption('freezer');
    await dialog.getByRole('button', { name: 'Add place' }).click();
    await expect(dialog.getByRole('list', { name: 'Your places' }).getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Places', exact: true })).toBeFocused();

    // An item, then focus lands on its heading
    await page.getByRole('button', { name: 'Add an item' }).click();
    await dialog.getByLabel('Name').fill('Plain flour');
    await dialog.getByRole('button', { name: 'Add item' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Added Plain flour' })).toBeVisible();
    await expect(page.getByText('No stock yet')).toBeVisible();

    // Exact stock with a past best-by date
    await page.getByRole('button', { name: 'Add stock for Plain flour' }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('500');
    await dialog.getByLabel('Where is it?').selectOption({ label: 'Pantry shelf' });
    await dialog.getByLabel('Date on the package').selectOption('best_by');
    await dialog.getByLabel('Date', { exact: true }).fill('2020-01-15');
    await dialog.getByLabel('A note').fill('Opened bag');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog).toHaveCount(0);
    const flour = lotRow(page, '500 g');
    await expect(flour).toContainText('Pantry shelf');
    await expect(flour).toContainText('Best by Jan 15, 2020');
    await expect(flour).toContainText('Past date');
    await expect(flour).toContainText('Opened bag');
    await expect(page.getByText('500 g in total')).toBeVisible();
    await expect(page.getByText('1 item · 1 stock entry · 1 past its date')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add stock for Plain flour' })).toBeFocused();

    // Convention and amount validation: nothing is sent
    await page.getByRole('button', { name: 'Add an item' }).click();
    await dialog.getByLabel('Name').fill('Whole milk');
    await dialog.getByLabel('How do you measure it?').selectOption('volume');
    await dialog.getByRole('button', { name: 'Add item' }).click();
    await expect(page.getByRole('heading', { name: 'Whole milk', level: 2 })).toBeFocused();
    const lotPosts = () => posts.filter(path => path === '/api/inventory/lots').length;
    const before = lotPosts();
    await page.getByRole('button', { name: 'Add stock for Whole milk' }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('1');
    await dialog.getByLabel('Unit').selectOption('cup');
    await expect(dialog.getByLabel('Measuring convention')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Choose a measuring convention first' })).toBeVisible();
    await expect(dialog.getByLabel('Measuring convention')).toBeFocused();
    await dialog.getByLabel('Measuring convention').selectOption('us-customary');
    await dialog.getByLabel('Amount', { exact: true }).fill('1 or 2');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Enter one exact amount' })).toBeVisible();
    expect(lotPosts()).toBe(before);
    await dialog.getByLabel('Amount', { exact: true }).fill('1 1/2');
    await dialog.getByLabel('Measuring convention').selectOption('us-label');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(lotRow(page, '360 mL')).toBeVisible();
    expect(lotPosts()).toBe(before + 1);

    // Estimated stock is never shown as exact
    await page.getByRole('button', { name: 'Add an item' }).click();
    await dialog.getByLabel('Name').fill('Spinach');
    await dialog.getByLabel('How do you measure it?').selectOption('count:bunch');
    await dialog.getByRole('button', { name: 'Add item' }).click();
    await page.getByRole('button', { name: 'Add stock for Spinach' }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('2');
    await expect(dialog.getByLabel('Unit')).toHaveValue('bunch');
    await dialog.getByLabel('Where is it?').selectOption({ label: 'Garage freezer' });
    await dialog.getByRole('radio', { name: /estimate/ }).check();
    await dialog.getByLabel('How close is your guess?').selectOption({ label: 'A rough guess (give or take 25%)' });
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    const spinach = lotRow(page, 'About 2 bunches');
    await expect(spinach).toContainText('Estimated, give or take 25%');
    await expect(page.getByText('About 2 bunches in total (estimated)')).toBeVisible();

    // Adjust: add, remove (with an over-removal caught in the form), recount, then a second exact lot
    await page.getByRole('button', { name: /^Add to 500 g of Plain flour/ }).click();
    await expect(dialog.getByLabel('How much more?')).toBeFocused();
    await dialog.getByLabel('How much more?').fill('100');
    await dialog.getByLabel('Why? (optional)').fill('Bought more');
    await dialog.getByRole('button', { name: 'Add to stock' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(lotRow(page, '600 g')).toBeVisible();
    await page.getByRole('button', { name: /^Remove from 600 g of Plain flour/ }).click();
    const adjusts = () => posts.filter(path => path.endsWith('/adjust')).length;
    const adjustsBefore = adjusts();
    await dialog.getByLabel('How much did you use?').fill('1000');
    await dialog.getByRole('button', { name: 'Remove from stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('There is less than that recorded');
    expect(adjusts()).toBe(adjustsBefore);
    await dialog.getByLabel('How much did you use?').fill('80');
    await dialog.getByRole('button', { name: 'Remove from stock' }).click();
    await expect(lotRow(page, '520 g')).toBeVisible();
    await page.getByRole('button', { name: /^Recount 520 g of Plain flour/ }).click();
    await dialog.getByLabel('What is there now?').fill('0.5');
    await dialog.getByLabel('Unit').selectOption('kg');
    await dialog.getByRole('radio', { name: /estimate/ }).check();
    await dialog.getByRole('button', { name: 'Save recount' }).click();
    await expect(lotRow(page, 'About 500 g')).toContainText('Estimated, give or take 10%');
    await page.getByRole('button', { name: 'Add stock for Plain flour' }).click();
    await dialog.getByLabel('Amount', { exact: true }).fill('1');
    await dialog.getByLabel('Unit').selectOption('kg');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(page.getByText('About 1.5 kg in total (estimated)')).toBeVisible();
    await expect(lotRow(page, /^1 kg/)).not.toContainText('About');

    // Archive the exact lot; focus returns to the item heading because the button disappears
    await page.getByRole('button', { name: /^Archive 1 kg of Plain flour/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Archive this Plain flour?' })).toBeVisible();
    await dialog.getByLabel('Why? (optional)').fill('Finished it');
    await dialog.getByRole('button', { name: 'Archive stock' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeFocused();
    await expect(page.getByText('About 500 g in total (estimated)')).toBeVisible();

    // History shows who changed what, newest first
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = dialog.getByRole('list', { name: 'Stock history' });
    await expect(history.getByRole('listitem').first()).toContainText('Archived');
    await expect(history.getByRole('listitem').first()).toContainText('Finished it');
    await expect(history).toContainText('+100 g');
    await expect(history).toContainText('−80 g');
    await expect(history).toContainText('Recounted');
    await expect(history).toContainText('Alex');
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'History', exact: true })).toBeFocused();

    // Rename and archive an item; a place in use cannot be archived and says why
    await page.getByRole('button', { name: 'Edit Spinach' }).click();
    await dialog.getByLabel('Name').fill('Baby spinach');
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('heading', { name: 'Baby spinach', level: 2 })).toBeFocused();
    await page.getByRole('button', { name: 'Places', exact: true }).click();
    await dialog.getByRole('button', { name: 'Archive Garage freezer' }).click();
    await dialog.getByRole('button', { name: 'Yes, archive Garage freezer' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Use up or archive the stock stored here first.');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('a failed save keeps the draft, retries with the same request id, and uses a new one once the draft changes', async ({ page, request }) => {
    await setModule(request, true);
    const item = await makeItem(request, 'Brown rice');
    expect(item.id).toBeTruthy();
    const sent: string[] = [];
    let attempt = 0;
    await page.route('**/api/inventory/lots', async (route: Route) => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      sent.push((route.request().postDataJSON() as { txnId: string }).txnId);
      attempt++;
      if (attempt === 1) await route.fulfill({ status: 500, json: { error: 'We could not save that right now.' } });
      else if (attempt === 2) await route.abort('failed');
      else { await new Promise(resolve => setTimeout(resolve, 400)); await route.continue(); }
    });
    await page.goto('/#inventory');
    await page.getByRole('button', { name: 'Add stock for Brown rice' }).click();
    const dialog = dialogOf(page);
    await dialog.getByLabel('Amount', { exact: true }).fill('250');
    await dialog.getByLabel('A note').fill('Keep this draft');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('We could not save that right now.');
    await expect(dialog.getByLabel('Amount', { exact: true })).toHaveValue('250');
    await expect(dialog.getByLabel('A note')).toHaveValue('Keep this draft');
    await dialog.getByRole('button', { name: 'Add stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('We couldn’t reach your family space');
    await expect(dialog.getByLabel('Amount', { exact: true })).toHaveValue('250');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    await dialog.getByLabel('Amount', { exact: true }).fill('300');
    await dialog.getByRole('button', { name: 'Add stock' }).dblclick();
    await expect(dialog).toHaveCount(0);
    await expect(lotRow(page, '300 g')).toBeVisible();
    expect(sent).toHaveLength(3);
    expect(sent[2]).not.toBe(sent[0]);
    expect(sent[2]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    await expect(lotRow(page, '250 g')).toHaveCount(0);
  });

  test('a conflicting change shows the message, refreshes the list, and keeps the draft for another try', async ({ page, request }) => {
    await setModule(request, true);
    const item = await makeItem(request, 'Rolled oats');
    await makeLot(request, item.id, '1', 'kg');
    await page.goto('/#inventory');
    await expect(lotRow(page, '1 kg')).toBeVisible();
    await page.getByRole('button', { name: /^Remove from 1 kg of Rolled oats/ }).click();
    const dialog = dialogOf(page);
    await dialog.getByLabel('How much did you use?').fill('100');
    await dialog.getByLabel('Unit').selectOption('g');
    // Someone else changes the same stock while this form is open.
    const state = await (await request.get('/api/inventory')).json() as InventoryState;
    const lot = state.lots.find(candidate => candidate.itemId === item.id)!;
    expect((await request.post(`/api/inventory/lots/${lot.id}/adjust`, { headers, data: { txnId: `other-${crypto.randomUUID()}`, version: lot.version, mode: 'add', amount: '500', unit: 'g', reason: 'Someone else' } })).ok()).toBe(true);
    const reloads: string[] = [];
    page.on('request', req => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/inventory') reloads.push(req.url()); });
    await dialog.getByRole('button', { name: 'Remove from stock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Inventory changed');
    await expect(dialog.getByRole('alert')).toContainText('your entries are still here');
    await expect(dialog.getByLabel('How much did you use?')).toHaveValue('100');
    await expect.poll(() => reloads.length).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: 'Remove from stock' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(lotRow(page, '1.4 kg')).toBeVisible();
  });

  test('keeps nothing from inventory in browser storage', async ({ page, request }) => {
    await setModule(request, true);
    await makeLot(request, (await makeItem(request, 'Rolled oats')).id, '1', 'kg');
    await page.goto('/#inventory');
    await expect(page.getByRole('heading', { name: 'Rolled oats', level: 2 })).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      session: Object.entries(sessionStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      databases: (await indexedDB.databases()).map(database => database.name),
      caches: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    }));
    expect(stored.local + stored.session).not.toMatch(/inventory|Rolled oats|Brown rice/i);
    expect(stored.databases).toEqual([]);
    expect(stored.caches.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ mocked API: deterministic fixtures for layout, accessibility and edge cases */

const PAST = '2020-01-01';
const FUTURE = '2099-12-31';
function populated(): InventoryState {
  const lot = (id: string, itemId: string, locationId: string | null, qty: number, extra: Partial<InventoryState['lots'][number]> = {}) =>
    ({ id, itemId, locationId, qty, precision: 'exact' as const, estBp: 0, enteredText: '', dateKind: null, date: null, note: '', version: 1, createdAt: 1_700_000_000, updatedAt: 1_700_000_000, ...extra });
  return {
    locations: [{ id: 'loc-pantry', name: 'Pantry shelf', kind: 'pantry', version: 1 }, { id: 'loc-fridge', name: 'Fridge, top shelf', kind: 'fridge', version: 1 }],
    items: [
      { id: 'item-flour', name: 'Plain flour', dim: 'mass', version: 1 }, { id: 'item-milk', name: 'Whole milk', dim: 'volume', version: 1 },
      { id: 'item-eggs', name: 'Eggs', dim: 'count:egg', version: 1 }, { id: 'item-bunch', name: 'Parsley, an unusually long ingredient name that must wrap on a small phone', dim: 'count:bunch', version: 1 },
    ],
    lots: [
      lot('lot-flour-1', 'item-flour', 'loc-pantry', 1_500_000_000_000, { dateKind: 'best_by', date: FUTURE, note: 'Unopened' }),
      lot('lot-flour-2', 'item-flour', 'loc-pantry', 400_000_000_000, { precision: 'estimated', estBp: 2500, dateKind: 'best_by', date: PAST }),
      lot('lot-milk', 'item-milk', 'loc-fridge', 1_000_000_000, { dateKind: 'use_by', date: PAST }),
      lot('lot-eggs', 'item-eggs', null, 6),
    ],
    aliases: [], calibrations: [], settings: { measureProfile: null, version: 1 },
  };
}
function family(): Bootstrap {
  const base = createDemo();
  return { ...base, demo: false, modules: base.modules.map(module => ({ ...module, enabled: true })) };
}
async function openMocked(page: Page, options: { state?: InventoryState; hash?: string } = {}) {
  const bootstrap = family();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/inventory', route => route.fulfill({ json: options.state ?? populated() }));
  await page.goto(`/#${options.hash ?? 'inventory'}`);
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function axe(page: Page, selector: string, label: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical'), `${label}: serious or critical`).toEqual([]);
  expect(results.violations, `${label}: all violations`).toEqual([]);
}

test.describe('Inventory page with fixed data', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('groups stock by item, never presents uncertain stock as exact, and flags past dates', async ({ page }) => {
    await openMocked(page);
    await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible();
    await expect(page.getByText('4 items · 4 stock entries · 1 estimated · 2 past their dates')).toBeVisible();
    const flour = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Plain flour' }) });
    await expect(flour.getByText('About 1.9 kg in total (estimated)')).toBeVisible();
    await expect(flour.locator('.inventory-lot').filter({ hasText: '1.5 kg' })).toContainText('Best by Dec 31, 2099');
    await expect(flour.locator('.inventory-lot').filter({ hasText: '1.5 kg' })).not.toContainText('Past date');
    await expect(flour.locator('.inventory-lot').filter({ hasText: 'About 400 g' })).toContainText('Past date');
    await expect(flour.locator('.inventory-lot').filter({ hasText: 'About 400 g' })).toContainText('Estimated, give or take 25%');
    const milk = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Whole milk' }) });
    await expect(milk.getByText('1 L in total')).toBeVisible();
    await expect(milk).toContainText('Use by Jan 1, 2020');
    await expect(milk).toContainText('Past date');
    await expect(page.getByText('6 eggs in total')).toBeVisible();
    await expect(page.getByText('No set place')).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/\bng\b|\bnL\b|txn/i);
  });

  test('shows a paused message and asks the family for fresh module settings when the module is off', async ({ page }) => {
    let bootstraps = 0;
    await page.route('**/api/bootstrap', route => { bootstraps++; return route.fulfill({ json: family() }); });
    await page.route('**/api/inventory', route => route.fulfill({ status: 403, json: { error: 'This module is disabled.' } }));
    await page.goto('/#inventory');
    await expect(page.getByRole('heading', { name: 'Inventory is paused' })).toBeVisible();
    await expect.poll(() => bootstraps).toBeGreaterThan(1);
  });

  test('explains that demo mode does not store inventory and never calls the inventory API', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/inventory')) calls.push(request.url()); });
    await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local test deployment is not configured.' } }));
    await page.goto('/#settings');
    await page.getByRole('button', { name: 'Explore the local demo' }).click();
    const toggle = page.getByRole('switch', { name: 'Enable Inventory' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(mainNav(page).getByRole('link', { name: 'Inventory' })).toHaveCount(0);
    await toggle.click();
    await mainNav(page).getByRole('link', { name: 'Inventory' }).click();
    await expect(page.getByRole('heading', { name: 'Inventory needs your real family space' })).toBeVisible();
    await expect(page.getByText('aren’t stored in the demo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add an item' })).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test('history loads in pages and ends with a focused message', async ({ page }) => {
    const entries: InvLedgerEntry[] = Array.from({ length: 45 }, (_, index) => ({ seq: 45 - index, txnId: `txn-${45 - index}-padding`, kind: 'add', memberId: 'sam', lotId: 'lot-eggs', itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', delta: 1, qtyAfter: 6, reason: `Entry number ${45 - index}`, createdAt: 1_700_000_000 + index }));
    const requests: URL[] = [];
    await openMocked(page);
    await page.route('**/api/inventory/ledger**', route => {
      const url = new URL(route.request().url());
      requests.push(url);
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const limit = Number(url.searchParams.get('limit'));
      const rows = entries.filter(entry => entry.seq < before).slice(0, limit);
      return route.fulfill({ json: { entries: rows, next: rows.length === limit ? rows.at(-1)!.seq : null } });
    });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const dialog = dialogOf(page);
    const list = dialog.getByRole('list', { name: 'Stock history' });
    await expect(list.getByRole('listitem')).toHaveCount(20);
    await expect(list.getByRole('listitem').first()).toContainText('Entry number 45');
    await expect(list.getByRole('listitem').first()).toContainText('Sam');
    await expect(list.getByRole('listitem').first()).toContainText('+1 egg');
    await dialog.getByRole('button', { name: 'Load more' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(40);
    await dialog.getByRole('button', { name: 'Load more' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(45);
    await expect(dialog.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    await expect(dialog.getByText('That’s everything so far.')).toBeFocused();
    expect(requests.map(url => url.searchParams.get('before'))).toEqual([null, '26', '6']);
    await expect(list.getByText('Entry number 45')).toHaveCount(1);
  });

  test('sign-out removes inventory from the page, and a late response cannot bring it back', async ({ page }) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let delayed = false;
    const bootstrap = family();
    await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap }));
    await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/inventory', async route => { if (delayed) await gate; await route.fulfill({ json: populated() }); });
    await page.goto('/#inventory');
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Your account and family members' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
    await expect(page.getByText('Plain flour')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/flour|milk|eggs|Inventory/i);

    // A response that arrives after sign-out is ignored.
    delayed = true;
    await page.goto('/?again#inventory');
    await expect(page.getByText('Loading your inventory…')).toBeVisible();
    await page.evaluate(() => { const channel = new BroadcastChannel('hearth-session'); channel.postMessage('logout'); channel.close(); });
    await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
    release?.();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Plain flour')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  });

  test('fits a 320px phone, including its dialogs, without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openMocked(page);
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    const dialog = dialogOf(page);
    const targets: [string | RegExp, string][] = [
      ['Add an item', 'Add an item'], ['Places', 'Where things live'], ['History', 'History'],
      ['Add stock for Plain flour', 'Add stock: Plain flour'], [/^Recount 1.5 kg of Plain flour/, 'Recount: Plain flour'], [/^Archive 6 eggs of Eggs/, 'Archive this Eggs?'],
    ];
    for (const [button, title] of targets) {
      await page.getByRole('button', typeof button === 'string' ? { name: button, exact: true } : { name: button }).first().click();
      await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
      expect(await noOverflow(page), `${title} dialog`).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), `${title} dialog width`).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    const small = await page.locator('.inventory-module .button, .inventory-module select, .inventory-module input:not([type=radio])').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height < 43.5).length);
    expect(small).toBe(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations at 390px in ${scheme} mode`, async ({ page }) => {
      test.setTimeout(90000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await openMocked(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeVisible();
      await axe(page, '#main-content', `${scheme} page`);
      const dialog = dialogOf(page);
      await page.getByRole('button', { name: 'Add stock for Whole milk' }).click();
      await dialog.getByLabel('Amount', { exact: true }).fill('1');
      await dialog.getByLabel('Unit').selectOption('cup');
      await dialog.getByRole('radio', { name: /estimate/ }).check();
      await dialog.getByRole('button', { name: 'Add stock' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await axe(page, 'dialog', `${scheme} add-stock dialog with an error`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Places', exact: true }).click();
      await dialog.getByRole('button', { name: 'Archive Pantry shelf' }).click();
      await axe(page, 'dialog', `${scheme} places dialog`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Recount about 400 g of Plain flour/ }).click();
      await axe(page, 'dialog', `${scheme} recount dialog`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Archive 6 eggs of Eggs/ }).click();
      await axe(page, 'dialog', `${scheme} archive dialog`);
    });
  }

});

test.describe('Inventory in the production build', () => {
  test.use({ storageState: { cookies: [], origins: [] }, baseURL: 'http://localhost:4173', serviceWorkers: 'allow' });

  test('keeps nothing from inventory in storage, including the production service-worker caches', async ({ page }) => {
    await openMocked(page);
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.keyboard.press('Escape');
    const stored = await page.evaluate(async () => ({
      local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      session: Object.entries(sessionStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      databases: (await indexedDB.databases()).map(database => database.name),
      entries: (await Promise.all((await caches.keys()).map(async name => { const cache = await caches.open(name); return Promise.all((await cache.keys()).map(async request => ({ url: request.url, text: await (await cache.match(request))!.clone().text().catch(() => '') }))); }))).flat(),
    }));
    expect(stored.local + stored.session).not.toMatch(/inventory|Plain flour|Whole milk/i);
    expect(stored.databases).toEqual([]);
    expect(stored.entries.filter(entry => new URL(entry.url).pathname.startsWith('/api/'))).toEqual([]);
    expect(stored.entries.some(entry => /Whole milk|Fridge, top shelf|Unopened/.test(entry.text))).toBe(false);
  });
});
