import { readFileSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';
import type { Bootstrap, FamilyRecord, ModuleId, Recipe } from '../../src/shared/types';
import type { AvailabilityItem, AvailabilityResult, InvAlias, InvCalibration, InvProfile, InventoryState } from '../../src/shared/inventory/wire';

/* ------------------------------------------------------------------ fixtures */

const test = base.extend({});

const RECIPE_ID = 'recipe-pancakes-fixture';
const recipe: Recipe = {
  title: 'Sunday pancakes', description: 'Fluffy and quick.', servings: 4, prepMinutes: 10, cookMinutes: 15, tags: ['Breakfast'], favorite: false,
  ingredients: [
    { name: 'plain flour', quantity: 2, unit: 'cup' }, { name: 'eggs', quantity: 2, unit: '' }, { name: 'whole milk', quantity: 1, unit: 'cup' },
    { name: 'fresh parsley', quantity: null, unit: '', note: 'to garnish' }, { name: 'salt', quantity: null, unit: '', note: 'to taste' },
  ],
  steps: ['Whisk everything together.', 'Cook on a hot pan.'],
};
const record: FamilyRecord<'recipe'> = { id: RECIPE_ID, kind: 'recipe', data: recipe, ownerId: 'alex', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };

type FamilyOptions = { off?: ModuleId[]; role?: 'admin' | 'member'; tasks?: { title: string; done: boolean }[] };
function family(options: FamilyOptions = {}): Bootstrap {
  const base = createDemo();
  const user = options.role === 'member' ? base.members[1] : base.user;
  return { ...base, demo: false, user, modules: base.modules.map(module => ({ ...module, enabled: !options.off?.includes(module.id) })), records: [...base.records.filter(r => r.kind !== 'recipe'), record, ...(options.tasks ?? []).map((task, index): FamilyRecord<'task'> => ({ id: `task-existing-${index}`, kind: 'task', data: task, ownerId: 'alex', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }))] };
}

const G = 1_000_000_000; // 1 g in the wire's integer ng
const ML = 1_000_000; // 1 mL in nL
const exact = (value: number) => ({ lo: value, hi: value });
function item(over: Partial<AvailabilityItem> = {}): AvailabilityItem {
  return { itemId: 'item-flour', itemName: 'Plain flour', dim: 'mass', lineIndexes: [0], verdict: 'sufficient', reasons: [], need: exact(250 * G), have: exact(1500 * G), needComplete: true, haveComplete: true, short: null, ...over };
}
function result(over: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return { verdict: 'sufficient', servings: 4, recipeServings: 4, items: [item()], unmapped: [], excluded: [], ...over };
}
const sufficient = () => result({ items: [item(), item({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], need: exact(2), have: exact(6) })], excluded: [3, 4] });
const insufficient = () => result({
  verdict: 'insufficient',
  items: [
    item({ verdict: 'insufficient', need: exact(500 * G), have: exact(250 * G), short: exact(250 * G) }),
    item({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], verdict: 'insufficient', reasons: ['RANGE_DEMAND'], need: { lo: 240 * ML, hi: 250 * ML }, have: exact(100 * ML), short: { lo: 140 * ML, hi: 150 * ML } }),
    item({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], need: exact(2), have: exact(6) }),
  ],
});

function stock(over: Partial<InventoryState> = {}): InventoryState {
  return {
    locations: [], lots: [], aliases: [], calibrations: [], settings: { measureProfile: null, version: 1 },
    items: [{ id: 'item-flour', name: 'Plain flour', dim: 'mass', version: 1 }, { id: 'item-milk', name: 'Whole milk', dim: 'volume', version: 1 }, { id: 'item-eggs', name: 'Eggs', dim: 'count:egg', version: 1 }],
    ...over,
  };
}

type Reply = { status?: number; json: unknown };
type Call = { method: string; path: string; body: Record<string, unknown> | null };
type MockOptions = FamilyOptions & { availability?: (Reply | ((body: Record<string, unknown>) => Reply))[]; inventory?: InventoryState };

/** A tiny in-memory stand-in for the inventory and records routes; every request is recorded. */
async function mock(page: Page, options: MockOptions = {}) {
  const calls: Call[] = [];
  const inventory = options.inventory ?? stock();
  const replies = options.availability ?? [{ json: sufficient() }];
  let asked = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: family(options) }));
  await page.route(url => url.pathname.startsWith('/api/inventory') || url.pathname === '/api/records', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: Record<string, unknown> | null = null;
    try { body = request.postDataJSON() as Record<string, unknown> | null; } catch { body = null; }
    calls.push({ method: request.method(), path, body });
    const method = request.method();
    if (method === 'GET' && path === '/api/inventory') return route.fulfill({ json: inventory });
    if (method === 'POST' && path === '/api/inventory/availability') {
      const reply = replies[Math.min(asked++, replies.length - 1)];
      const settled = typeof reply === 'function' ? reply(body ?? {}) : reply;
      return route.fulfill({ status: settled.status ?? 200, json: settled.json });
    }
    if (method === 'POST' && path === '/api/inventory/items') return route.fulfill({ status: 201, json: { id: 'item-new', name: body?.name, dim: body?.dim, version: 1 } });
    if (method === 'POST' && path === '/api/inventory/aliases') { const alias: InvAlias = { id: 'alias-new', name: String(body?.name), itemId: String(body?.itemId), version: 1 }; inventory.aliases.push(alias); return route.fulfill({ status: 201, json: alias }); }
    if (method === 'POST' && path === '/api/inventory/calibrations') {
      const cal = { id: 'cal-new', version: 1, fromProfile: null, toProfile: null, ...body } as unknown as InvCalibration;
      inventory.calibrations.push(cal);
      return route.fulfill({ status: 201, json: cal });
    }
    if (method === 'PUT' && path === '/api/inventory/settings') { inventory.settings = { measureProfile: body?.measureProfile as InvProfile | null, version: inventory.settings.version + 1 }; return route.fulfill({ json: inventory.settings }); }
    const archived = /^\/api\/inventory\/(aliases|calibrations)\/([^/]+)\/archive$/.exec(path);
    if (method === 'POST' && archived) {
      if (archived[1] === 'aliases') inventory.aliases = inventory.aliases.filter(alias => alias.id !== archived[2]); else inventory.calibrations = inventory.calibrations.filter(cal => cal.id !== archived[2]);
      return route.fulfill({ json: { id: archived[2] } });
    }
    if (method === 'POST' && path === '/api/records') return route.fulfill({ status: 201, json: { id: `task-${calls.length}`, kind: 'task', ownerId: 'alex', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), data: body?.data } });
    return route.fulfill({ status: 404, json: { error: 'Not mocked.' } });
  });
  return { calls, inventory, ofPath: (path: string, method = 'POST') => calls.filter(call => call.path === path && call.method === method) };
}

async function openRecipe(page: Page) {
  await page.goto('/#recipes');
  await page.getByRole('button', { name: 'View Sunday pancakes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sunday pancakes', level: 1 })).toBeVisible();
}
const panel = (page: Page) => page.getByRole('region', { name: 'Pantry check' });
const dialogOf = (page: Page) => page.getByRole('dialog');
async function runCheck(page: Page) {
  await panel(page).getByRole('button', { name: /^Check (pantry|again)$/ }).click();
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function axe(page: Page, selector: string, label: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical'), `${label}: serious or critical`).toEqual([]);
  expect(results.violations, `${label}: all violations`).toEqual([]);
}

/* ------------------------------------------------------------------ the panel on a recipe */

test.describe('Pantry check on a recipe', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('is absent when inventory is off, and in the demo, and makes no inventory request', async ({ page }) => {
    const api = await mock(page, { off: ['inventory'] });
    await openRecipe(page);
    await expect(page.getByRole('heading', { name: 'Ingredients', level: 2 })).toBeVisible();
    await expect(page.getByText('Pantry check')).toHaveCount(0);
    expect(api.calls.filter(call => call.path.startsWith('/api/inventory'))).toEqual([]);
  });

  test('is absent in the demo even with Inventory switched on there', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/inventory')) calls.push(request.url()); });
    await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local test deployment is not configured.' } }));
    await page.goto('/#settings');
    await page.getByRole('button', { name: 'Explore the local demo' }).click();
    await page.getByRole('switch', { name: 'Enable Inventory' }).click();
    await expect(page.getByRole('switch', { name: 'Disable Inventory' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /Recipe/ }).click();
    await expect(page.getByRole('heading', { name: 'A little taste of home.' })).toBeVisible();
    await page.getByRole('button', { name: 'View Slow morning pancakes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Slow morning pancakes', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ingredients', level: 2 })).toBeVisible();
    await expect(page.getByText('Pantry check')).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test('never calls the server on its own: not on load, not when servings change', async ({ page }) => {
    const api = await mock(page);
    await openRecipe(page);
    await expect(panel(page)).toBeVisible();
    await page.getByRole('button', { name: 'Increase servings' }).click();
    await page.getByLabel('Servings', { exact: true }).fill('6');
    await page.getByRole('tab', { name: 'Steps' }).click();
    await page.getByRole('tab', { name: 'Ingredients' }).click();
    await page.waitForTimeout(400);
    expect(api.calls.filter(call => call.path.startsWith('/api/inventory'))).toEqual([]);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    const sent = api.ofPath('/api/inventory/availability');
    expect(sent).toHaveLength(1);
    // Only ids and numbers leave the page: the server reads the recipe itself.
    expect(sent[0].body).toEqual({ recipeId: RECIPE_ID, servings: 6, exclude: [] });
  });

  test('shows an enough verdict as text and an icon, with need and have for each item', async ({ page }) => {
    await mock(page, { availability: [{ json: sufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    const banner = panel(page).getByRole('heading', { name: 'You have enough' });
    await expect(banner).toBeFocused();
    await expect(panel(page)).toContainText('Everything checked is covered for 4 servings, with 2 lines skipped by you.');
    const flour = panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' });
    await expect(flour).toContainText('Enough');
    await expect(flour.locator('dt', { hasText: 'Need' }).locator('xpath=following-sibling::dd')).toHaveText('250 g');
    await expect(flour.locator('dt', { hasText: 'You have' }).locator('xpath=following-sibling::dd')).toHaveText('1.5 kg');
    const eggs = panel(page).getByRole('listitem').filter({ hasText: 'Eggs' });
    await expect(eggs).toContainText('2 eggs');
    await expect(eggs).toContainText('6 eggs');
    await expect(panel(page).getByRole('button', { name: 'Copy shortages' })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  test('a server "sufficient" is not shown as enough while anything is unmatched or unconfirmed', async ({ page }) => {
    await mock(page, { availability: [{ json: result({ verdict: 'sufficient', unmapped: [{ index: 3, name: 'fresh parsley' }] }) }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Can’t confirm' })).toBeVisible();
    await expect(panel(page)).not.toContainText('You have enough');
  });

  test('reports shortages conservatively, copies them, and adds tasks only after a confirmation', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const api = await mock(page, { availability: [{ json: insufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeFocused();
    await expect(panel(page)).toContainText('Short on 2 items for 4 servings.');
    const flour = panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' });
    await expect(flour).toContainText('Not enough');
    await expect(flour).toContainText('Short by 250 g');
    await expect(flour).not.toContainText('Short by about');
    const milk = panel(page).getByRole('listitem').filter({ hasText: 'Whole milk' });
    await expect(milk).toContainText('240 mL to 250 mL');
    await expect(milk).toContainText('Short by between 140 mL and 150 mL');
    await expect(milk).toContainText('The recipe gives a range of amounts');

    await panel(page).getByRole('button', { name: 'Copy shortages' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Shortages for Sunday pancakes (4 servings)\n- Plain flour: 250 g\n- Whole milk: 140 mL to 150 mL');

    await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Add shortages to Tasks?' })).toBeVisible();
    await expect(dialog.getByRole('list')).toContainText('Buy: Plain flour (250 g)');
    await expect(dialog.getByRole('list')).toContainText('Buy: Whole milk (140 mL to 150 mL)');
    await expect(dialog.getByText('2 tasks will be created:')).toBeVisible();
    expect(api.ofPath('/api/records')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/records')).toHaveLength(0);

    await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
    await dialog.getByRole('button', { name: 'Add 2 tasks' }).click();
    await expect(dialog).toHaveCount(0);
    const created = api.ofPath('/api/records');
    expect(created.map(call => call.body)).toEqual([
      { kind: 'task', data: { title: 'Buy: Plain flour (250 g)', done: false } },
      { kind: 'task', data: { title: 'Buy: Whole milk (140 mL to 150 mL)', done: false } },
    ]);
    await expect(panel(page).getByRole('button', { name: 'Added to Tasks' })).toBeDisabled();
  });

  test('prints one amount when it is exact and a range only when it is one', async ({ page }) => {
    const MLs = (n: number) => Math.round(n * ML);
    await mock(page, {
      availability: [{
        json: result({
          verdict: 'insufficient',
          items: [
            // Outward rounding makes lo and hi differ by a nanolitre or two: that is still one amount to a person.
            item({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], verdict: 'insufficient', need: { lo: MLs(354.8819), hi: MLs(354.8823) }, have: exact(MLs(118.294)), short: { lo: MLs(236.5876), hi: MLs(236.5884) } }),
            item({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], verdict: 'insufficient', need: exact(5), have: exact(3), short: exact(2) }),
            item({ itemId: 'item-salt', itemName: 'Salt', lineIndexes: [4], verdict: 'insufficient', need: { lo: 100 * G, hi: 150 * G }, have: exact(50 * G), short: { lo: 0, hi: 100 * G } }),
            item({ itemName: 'Plain flour', verdict: 'unknown', reasons: ['UNQUANTIFIED'], needComplete: false, need: exact(0), have: exact(1500 * G) }),
          ],
        }),
      }],
    });
    await openRecipe(page);
    await runCheck(page);
    const milk = panel(page).getByRole('listitem').filter({ hasText: 'Whole milk' });
    await expect(milk.locator('dd').first()).toHaveText('354.882 mL');
    await expect(milk).toContainText('Short by 236.588 mL');
    await expect(milk).not.toContainText(' to ');
    await expect(milk).not.toContainText('at least');
    const eggs = panel(page).getByRole('listitem').filter({ hasText: 'Eggs' });
    await expect(eggs).toContainText('Short by 2 eggs');
    await expect(eggs).not.toContainText('about');
    const salt = panel(page).getByRole('listitem').filter({ hasText: 'Salt' });
    await expect(salt).toContainText('100 g to 150 g');
    await expect(salt).toContainText('Short by up to 100 g');
    const flour = panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' });
    await expect(flour.locator('dd').first()).toHaveText('Amount unclear');
    await expect(flour).not.toContainText('at least 0');
    await expect(panel(page)).not.toContainText(/at least 0|NEED at least/i);
  });

  test('says “at least” only when the need itself is a lower bound', async ({ page }) => {
    await mock(page, {
      availability: [{ json: result({ verdict: 'insufficient', items: [item({ verdict: 'insufficient', reasons: ['UNQUANTIFIED'], needComplete: false, need: exact(500 * G), have: exact(250 * G), short: exact(250 * G) })] }) }],
    });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' })).toContainText('Short by at least 250 g');
  });

  test('lists tasks that are already on the list, skips them by default, and can add them again on request', async ({ page }) => {
    const tasks = [{ title: 'Buy: Plain flour (250 g)', done: false }, { title: 'Buy: Whole milk (140 mL to 150 mL)', done: true }];
    const api = await mock(page, { tasks, availability: [{ json: insufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
    const dialog = dialogOf(page);
    // Only the open task counts: the milk one was finished, so it is offered again.
    await expect(dialog.getByText('Already on your list: these will be skipped.')).toBeVisible();
    await expect(dialog.getByRole('list', { name: /Already on your list/ })).toContainText('Buy: Plain flour (250 g)');
    await expect(dialog.getByRole('list', { name: /Already on your list/ }).getByRole('listitem')).toHaveCount(1);
    await expect(dialog.getByText('1 task will be created:')).toBeVisible();
    await expect(dialog.getByRole('list', { name: '1 task will be created:' })).toContainText('Buy: Whole milk (140 mL to 150 mL)');
    await dialog.getByRole('button', { name: 'Add 1 task' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/records').map(call => call.body)).toEqual([{ kind: 'task', data: { title: 'Buy: Whole milk (140 mL to 150 mL)', done: false } }]);
    await expect(panel(page).locator('[aria-live="polite"]')).toHaveText('Added 1 task to Tasks. Left out 1 that was already on your list.');
    await expect(panel(page).getByRole('button', { name: 'Added to Tasks' })).toBeDisabled();
  });

  test('a person can still add the duplicates, and with nothing new the button says so', async ({ page }) => {
    const tasks = [{ title: 'Buy: Plain flour (250 g)', done: false }, { title: 'Buy: Whole milk (140 mL to 150 mL)', done: false }];
    const api = await mock(page, { tasks, availability: [{ json: insufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByText('Nothing new will be created.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Nothing new to add' })).toBeDisabled();
    await expect(dialog.getByRole('list', { name: /Already on your list/ }).getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('checkbox', { name: 'Add them again anyway' }).check();
    await expect(dialog.getByText('Already on your list: these will be added again.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Add 2 tasks' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/records').map(call => (call.body as { data: { title: string } }).data.title)).toEqual(['Buy: Plain flour (250 g)', 'Buy: Whole milk (140 mL to 150 mL)']);
  });

  test('offers no task button when Tasks is off, and a manual copy box when the clipboard is unavailable', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
    await mock(page, { off: ['tasks'], availability: [{ json: insufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('button', { name: 'Copy shortages' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Add to Tasks' })).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Copy shortages' }).click();
    await expect(panel(page).getByLabel('Copy these shortages')).toHaveValue(/Plain flour: 250 g/);
  });

  test('says why in plain words for every reason, never presenting unknown as enough', async ({ page }) => {
    await mock(page, {
      availability: [{
        json: result({
          verdict: 'unknown',
          items: [
            item({ verdict: 'unknown', reasons: ['UNQUANTIFIED', 'MEASURE_PROFILE_AMBIGUOUS'], needComplete: false, lineIndexes: [0, 4] }),
            item({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION', 'UNKNOWN_UNIT', 'OZ_ASSUMED_WEIGHT'], need: exact(0), have: exact(1000 * ML) }),
            item({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], verdict: 'unknown', reasons: ['AMBIGUOUS_OUNCE', 'CALIBRATION_UNACCEPTED', 'CALIBRATION_CONFLICT', 'INTERVAL_OVERLAP', 'ACCEPTED_CALIBRATION', 'ESTIMATED_STOCK'], need: { lo: 2, hi: 3 }, have: { lo: 2, hi: 4 }, haveComplete: false }),
          ],
        }),
      }],
    });
    await openRecipe(page);
    await runCheck(page);
    const area = panel(page);
    await expect(area.getByRole('heading', { name: 'Can’t confirm' })).toBeFocused();
    await expect(area).toContainText('This isn’t a yes.');
    await expect(area).not.toContainText(/You have enough|Everything checked is covered/);
    await expect(area.getByText('No exact amount (e.g. ‘to taste’) — exclude it or it can’t be confirmed')).toBeVisible();
    await expect(area.getByText('Cups and spoons differ by region — choose your measuring convention in Inventory')).toBeVisible();
    await expect(area.getByText('The recipe measures this differently from how you track it (volume) — add a conversion like 100 g = 1 cup')).toBeVisible();
    await expect(area.getByText(/We don’t recognise|unit we don’t recognise/)).toBeVisible();
    await expect(area.getByText('“oz” could mean weight or fluid ounces, and this item isn’t tracked in a way that decides it. Change the recipe line to “fl oz” for a liquid, or to grams or pounds, or skip the line.')).toBeVisible();
    await expect(area.getByText(/Edit the recipe to say “oz” for weight/)).toHaveCount(0);
    await expect(area.getByText('Counted “oz” as weight because you track this by weight.')).toBeVisible();
    await expect(area.locator('li[data-reason="OZ_ASSUMED_WEIGHT"]')).toHaveClass(/note/);
    await expect(area.getByText(/hasn’t been accepted yet/)).toBeVisible();
    await expect(area.getByText(/Two conversions for this item disagree/)).toBeVisible();
    await expect(area.getByText(/too close to call/)).toBeVisible();
    await expect(area.getByText('Uses a conversion your household accepted.')).toBeVisible();
    await expect(area.getByText(/Some of your stock is an estimate/)).toBeVisible();
    // Incomplete amounts never read as exact.
    await expect(area.getByRole('listitem').filter({ hasText: 'Plain flour' })).toContainText('at least 250 g');
    await expect(area.getByRole('listitem').filter({ hasText: 'Eggs' })).toContainText('at least 2 eggs');
    for (const chip of await area.locator('.pantry-item .pill').allTextContents()) expect(chip.trim()).toBe('Can’t confirm');
    await expect(area.getByRole('link', { name: /Open Inventory/ })).toHaveAttribute('href', '#inventory');
    await expect(area.getByRole('button', { name: 'Copy shortages' })).toHaveCount(0);
  });

  test('matches an unmatched ingredient to an existing item, then asks for a fresh check', async ({ page }) => {
    const api = await mock(page, { availability: [{ json: result({ verdict: 'unknown', unmapped: [{ index: 3, name: 'fresh parsley' }] }) }, { json: sufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    const area = panel(page);
    await expect(area).toContainText('1 ingredient isn’t matched to your inventory');
    await area.getByRole('button', { name: 'Match to inventory item for fresh parsley' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Match to an inventory item' })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'An item I already keep' })).toBeFocused();
    await expect(dialog.getByLabel('Inventory item')).toContainText('Plain flour (Weight)');
    await dialog.getByRole('button', { name: 'Save match' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose which item this ingredient is.');
    expect(api.ofPath('/api/inventory/aliases')).toHaveLength(0);
    await dialog.getByLabel('Inventory item').selectOption({ label: 'Eggs (counted in eggs)' });
    await dialog.getByRole('button', { name: 'Save match' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/inventory/aliases').map(call => call.body)).toEqual([{ name: 'fresh parsley', itemId: 'item-eggs' }]);
    // The old answer is retired rather than left to mislead; nothing re-runs on its own.
    await expect(area.getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(1);
    await expect(area.getByRole('button', { name: 'Check again' })).toBeFocused();
    await expect(area.getByRole('button', { name: 'Match to inventory item for fresh parsley' })).toBeVisible();
    await runCheck(page);
    await expect(area.getByRole('heading', { name: 'You have enough' })).toBeVisible();
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(2);
  });

  test('creates a new item while matching, and reuses it if saving the match fails first', async ({ page }) => {
    let aliasAttempts = 0;
    const api = await mock(page, { inventory: stock({ items: [] }), availability: [{ json: result({ verdict: 'unknown', items: [], unmapped: [{ index: 3, name: 'fresh parsley' }] }) }] });
    await page.route('**/api/inventory/aliases', async route => {
      if (route.request().method() === 'POST' && aliasAttempts++ === 0) return route.fulfill({ status: 500, json: { error: 'We could not save that match.' } });
      return route.fallback();
    });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Nothing to compare' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Match to inventory item for fresh parsley' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('radio', { name: 'Something new to add to Inventory' })).toBeChecked();
    await dialog.getByLabel('New item name').fill('Parsley');
    await dialog.getByLabel('How do you measure it?').selectOption('count:bunch');
    await dialog.getByRole('button', { name: 'Save match' }).click();
    await expect(dialog.getByRole('alert')).toContainText('We could not save that match.');
    await expect(dialog.getByLabel('New item name')).toHaveValue('Parsley');
    await dialog.getByRole('button', { name: 'Save match' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/inventory/items').map(call => call.body)).toEqual([{ name: 'Parsley', dim: 'count:bunch' }]);
    expect(api.ofPath('/api/inventory/aliases').at(-1)?.body).toEqual({ name: 'fresh parsley', itemId: 'item-new' });
  });

  test('skips optional lines by sending their indexes, and marks them as skipped by you', async ({ page }) => {
    const api = await mock(page, { availability: [{ json: sufficient() }, { json: sufficient() }] });
    await openRecipe(page);
    await panel(page).getByText('Skip optional lines').click();
    await panel(page).getByRole('checkbox', { name: 'Exclude from check: fresh parsley' }).check();
    await expect(panel(page).getByText('Optional — skipped by you')).toBeVisible();
    await expect(panel(page).getByText('Skip optional lines · 1 skipped')).toBeVisible();
    expect(api.calls.filter(call => call.path.startsWith('/api/inventory'))).toEqual([]);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    expect(api.ofPath('/api/inventory/availability')[0].body).toEqual({ recipeId: RECIPE_ID, servings: 4, exclude: [3] });
    // Changing a skip after the answer arrives marks it out of date instead of silently re-running.
    await panel(page).getByRole('checkbox', { name: 'Exclude from check: salt' }).check();
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await expect(panel(page)).not.toContainText('You have enough');
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(1);
    await runCheck(page);
    await expect.poll(() => api.ofPath('/api/inventory/availability').length).toBe(2);
    expect(api.ofPath('/api/inventory/availability')[1].body).toEqual({ recipeId: RECIPE_ID, servings: 4, exclude: [3, 4] });
  });

  test('a changed serving count makes the old answer out of date and the next check uses the new one', async ({ page }) => {
    const api = await mock(page, { availability: [{ json: insufficient() }, { json: result({ servings: 8 }) }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('button', { name: 'Copy shortages' })).toBeVisible();
    await page.getByLabel('Servings', { exact: true }).fill('8');
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Copy shortages' })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Add to Tasks' })).toHaveCount(0);
    await runCheck(page);
    await expect.poll(() => api.ofPath('/api/inventory/availability').length).toBe(2);
    expect(api.ofPath('/api/inventory/availability')[1].body).toEqual({ recipeId: RECIPE_ID, servings: 8, exclude: [] });
  });

  test('refuses to check while servings are invalid', async ({ page }) => {
    const api = await mock(page);
    await openRecipe(page);
    await page.getByLabel('Servings', { exact: true }).fill('0');
    await expect(panel(page).getByRole('button', { name: 'Check pantry' })).toBeDisabled();
    await expect(panel(page)).toContainText('Choose a whole number of servings from 1 to 1,000 first.');
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(0);
  });

  test('adds a conversion for a volume/weight mismatch, asking for the cup convention first', async ({ page }) => {
    const mismatch = result({ verdict: 'unknown', items: [item({ verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION'], need: exact(0) })] });
    const api = await mock(page, { availability: [{ json: mismatch }, { json: sufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await panel(page).getByRole('button', { name: 'Add conversion for Plain flour' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Add a conversion: Plain flour' })).toBeVisible();
    await expect(dialog.getByLabel('Recipe measure')).toBeFocused();
    await dialog.getByRole('button', { name: 'Save conversion' }).click();
    await expect(dialog.getByRole('alert').first()).toContainText('Enter one exact amount');
    await dialog.getByLabel('Recipe measure').fill('1');
    await dialog.getByLabel('Equals').fill('120');
    await dialog.getByRole('button', { name: 'Save conversion' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose a measuring convention first');
    expect(api.ofPath('/api/inventory/calibrations')).toHaveLength(0);
    await dialog.getByLabel('Measuring convention').selectOption('us-customary');
    await dialog.getByRole('button', { name: 'Save conversion' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.ofPath('/api/inventory/calibrations').map(call => call.body)).toEqual([
      { itemId: 'item-flour', fromAmount: '1', fromUnit: 'cup', fromProfile: 'us-customary', toAmount: '120', toUnit: 'g' },
    ]);
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Check again' })).toBeFocused();
  });

  test('a conversion needs units that measure different things, one of them how the item is tracked', async ({ page }) => {
    const mismatch = result({ verdict: 'unknown', items: [item({ verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION'], need: exact(0) })] });
    const api = await mock(page, { availability: [{ json: mismatch }] });
    await openRecipe(page);
    await runCheck(page);
    await panel(page).getByRole('button', { name: 'Add conversion for Plain flour' }).click();
    const dialog = dialogOf(page);
    await dialog.getByLabel('Recipe measure').fill('1');
    await dialog.getByLabel('Equals').fill('120');
    await dialog.getByLabel('Measuring convention').selectOption('us-customary');
    await dialog.getByLabel('Unit').nth(1).selectOption('kg');
    await dialog.getByLabel('Unit').nth(0).selectOption('g');
    await dialog.getByRole('button', { name: 'Save conversion' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Pick units that measure different things');
    expect(api.ofPath('/api/inventory/calibrations')).toHaveLength(0);
  });

  test('a failed check keeps the panel usable and a retry works', async ({ page }) => {
    const api = await mock(page, { availability: [{ status: 500, json: { error: 'The pantry check could not run right now.' } }, { json: sufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('alert')).toContainText('The pantry check could not run right now.');
    await expect(panel(page).getByRole('button', { name: 'Check pantry' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Sunday pancakes', level: 1 })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(2);
  });

  for (const [status, text] of [[403, 'Inventory is turned off'], [404, 'no longer in your family space'], [422, 'too large to check']] as const) {
    test(`explains a ${status} answer`, async ({ page }) => {
      await mock(page, { availability: [{ status, json: { error: 'raw server text' } }] });
      await openRecipe(page);
      await runCheck(page);
      await expect(panel(page).getByRole('alert')).toContainText(text);
      await expect(panel(page).getByRole('alert')).not.toContainText('raw server text');
    });
  }

  test('keeps nothing from the check in browser storage and leaves recipes read-only', async ({ page }) => {
    const api = await mock(page, { availability: [{ json: insufficient() }] });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      session: Object.entries(sessionStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      databases: (await indexedDB.databases()).map(database => database.name),
      caches: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    }));
    expect(stored.local + stored.session).not.toMatch(/Plain flour|availability|Short by/i);
    expect(stored.databases).toEqual([]);
    expect(stored.caches.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
    expect(api.calls.filter(call => call.path === '/api/records')).toEqual([]);
  });

  test('is hidden from print and leaves the printed recipe unchanged', async ({ page }) => {
    await mock(page, { availability: [{ json: insufficient() }] });
    await page.addInitScript(() => { window.print = () => undefined; });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(panel(page)).toBeHidden();
    const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
    await expect(sheet).toBeVisible();
    const printed = (await page.locator('body').innerText()).trim();
    expect(printed).toBe((await sheet.innerText()).trim());
    expect(printed).not.toMatch(/Pantry check|Short by|Copy shortages|Plain flour/);
    await page.emulateMedia({ media: 'screen' });
    await expect(panel(page)).toBeVisible();
  });

  test('sign-out removes the panel and a late answer cannot bring it back', async ({ page }) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await mock(page, { availability: [{ json: insufficient() }] });
    await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/inventory/availability', async route => { await gate; await route.fallback(); });
    await openRecipe(page);
    await runCheck(page);
    await expect(panel(page).getByRole('button', { name: 'Checking…' })).toBeVisible();
    await page.evaluate(() => { const channel = new BroadcastChannel('hearth-session'); channel.postMessage('logout'); channel.close(); });
    await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
    release?.();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Plain flour|Short by|Pantry check/);
  });

  for (const width of [390, 320]) {
    test(`fits a ${width}px phone, dialogs included, without horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mock(page, { inventory: stock({ items: [{ id: 'item-flour', name: 'Plain flour, an unusually long inventory item name that must wrap on a small phone', dim: 'mass', version: 1 }] }), availability: [{
        json: result({
          verdict: 'insufficient',
          items: [
            item({ verdict: 'insufficient', itemName: 'Plain flour, an unusually long inventory item name that must wrap on a small phone', need: exact(500 * G), have: { lo: 100 * G, hi: 120 * G }, short: { lo: 380 * G, hi: 400 * G }, reasons: ['ESTIMATED_STOCK'] }),
            item({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION', 'MEASURE_PROFILE_AMBIGUOUS'], need: exact(0), have: exact(1000 * ML) }),
          ],
          unmapped: [{ index: 3, name: 'fresh parsley' }], excluded: [4],
        }),
      }] });
      await openRecipe(page);
      await runCheck(page);
      await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      const small = await panel(page).locator('.button, select, summary, .pantry-toggle').evaluateAll(elements => elements.filter(element => { const box = element.getBoundingClientRect(); return box.height < 43.5; }).map(element => `${element.tagName}.${element.className}:${element.textContent?.slice(0, 30)}:${Math.round(element.getBoundingClientRect().height)}`));
      expect(small).toEqual([]);
      const dialog = dialogOf(page);
      for (const [button, title] of [['Match to inventory item for fresh parsley', 'Match to an inventory item'], [/^Add conversion for/, /^Add a conversion/], ['Add to Tasks', 'Add shortages to Tasks?']] as const) {
        await panel(page).getByRole('button', typeof button === 'string' ? { name: button, exact: true } : { name: button }).first().click();
        await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
        expect(await noOverflow(page), `${title} dialog`).toBe(true);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), `${title} dialog width`).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations at 390px in ${scheme} mode`, async ({ page }) => {
      test.setTimeout(90000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await mock(page, { availability: [{
        json: result({
          verdict: 'insufficient',
          items: [
            item({ verdict: 'insufficient', need: exact(500 * G), have: exact(250 * G), short: exact(250 * G) }),
            item({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION', 'MEASURE_PROFILE_AMBIGUOUS', 'ESTIMATED_STOCK'], need: exact(0), have: exact(1000 * ML) }),
            item({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], need: exact(2), have: exact(6) }),
            item({ itemId: 'item-salt', itemName: 'Salt', lineIndexes: [4], verdict: 'unknown', reasons: ['UNQUANTIFIED'], needComplete: false }),
          ],
          unmapped: [{ index: 3, name: 'fresh parsley' }],
        }),
      }] });
      await openRecipe(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await axe(page, '.pantry-check', `${scheme} idle panel`);
      await panel(page).getByText('Skip optional lines').click();
      await panel(page).getByRole('checkbox', { name: 'Exclude from check: fresh parsley' }).check();
      await runCheck(page);
      await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
      await axe(page, '.pantry-check', `${scheme} result`);
      await panel(page).getByRole('list', { name: 'Items checked' }).getByRole('checkbox', { name: 'Exclude from check: salt' }).check();
      await axe(page, '.pantry-check', `${scheme} out of date`);
      await runCheck(page);
      await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
      const dialog = dialogOf(page);
      await panel(page).getByRole('button', { name: 'Match to inventory item for fresh parsley' }).click();
      await dialog.getByRole('button', { name: 'Save match' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await axe(page, 'dialog', `${scheme} match dialog with an error`);
      await page.keyboard.press('Escape');
      await panel(page).getByRole('button', { name: 'Add conversion for Whole milk' }).click();
      await dialog.getByRole('button', { name: 'Save conversion' }).click();
      await expect(dialog.getByRole('alert').first()).toBeVisible();
      await axe(page, 'dialog', `${scheme} conversion dialog with errors`);
      await page.keyboard.press('Escape');
      await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
      await axe(page, 'dialog', `${scheme} tasks dialog`);
    });
  }
});

/* ------------------------------------------------------------------ Inventory page: Recipe matching */

test.describe('Recipe matching on the Inventory page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const matched = () => stock({
    settings: { measureProfile: 'us-label', version: 4 },
    aliases: [{ id: 'alias-1', name: 'AP flour', itemId: 'item-flour', version: 1 }, { id: 'alias-2', name: 'old thing', itemId: 'item-gone', version: 1 }],
    calibrations: [{ id: 'cal-1', itemId: 'item-flour', fromAmount: '1', fromUnit: 'cup', fromProfile: 'us-label', toAmount: '120', toUnit: 'g', toProfile: null, version: 1 }],
  });

  test('an administrator changes the convention and removes a match and a conversion', async ({ page }) => {
    const api = await mock(page, { inventory: matched() });
    await page.goto('/#inventory');
    const section = page.getByRole('region', { name: 'Recipe matching' });
    await expect(section.getByLabel('Measuring convention')).toHaveValue('us-label');
    await expect(section.getByRole('list', { name: 'Matched ingredient names' })).toContainText('AP flour');
    await expect(section.getByRole('list', { name: 'Matched ingredient names' })).toContainText('is Plain flour');
    await expect(section.getByRole('list', { name: 'Matched ingredient names' })).toContainText('is An item you archived');
    await expect(section.getByRole('list', { name: 'Accepted conversions' })).toContainText('1 cup (US nutrition label) = 120 g');
    await section.getByLabel('Measuring convention').selectOption('metric-250');
    await expect.poll(() => api.ofPath('/api/inventory/settings', 'PUT').length).toBe(1);
    expect(api.ofPath('/api/inventory/settings', 'PUT')[0].body).toEqual({ measureProfile: 'metric-250', version: 4 });
    await expect(page.getByRole('status').filter({ hasText: 'Measuring convention set to Metric (250 mL cup).' })).toBeVisible();
    await expect(section.getByLabel('Measuring convention')).toHaveValue('metric-250');

    await section.getByRole('button', { name: 'Remove the match for AP flour' }).click();
    await section.getByRole('button', { name: 'Yes, remove the match for AP flour' }).click();
    await expect.poll(() => api.ofPath('/api/inventory/aliases/alias-1/archive').length).toBe(1);
    expect(api.ofPath('/api/inventory/aliases/alias-1/archive')[0].body).toEqual({ version: 1 });
    await expect(section.getByText('AP flour')).toHaveCount(0);
    await section.getByRole('button', { name: /^Remove the conversion 1 cup/ }).click();
    await section.getByRole('button', { name: /^Yes, remove the conversion/ }).click();
    await expect.poll(() => api.ofPath('/api/inventory/calibrations/cal-1/archive').length).toBe(1);
    await expect(section.getByRole('list', { name: 'Accepted conversions' })).toHaveCount(0);
  });

  test('keeps keyboard focus in the list after a match or conversion is removed', async ({ page }) => {
    await mock(page, { inventory: matched() });
    await page.goto('/#inventory');
    const section = page.getByRole('region', { name: 'Recipe matching' });
    await section.getByRole('button', { name: 'Remove the match for AP flour' }).click();
    await section.getByRole('button', { name: 'Yes, remove the match for AP flour' }).click();
    await expect(section.getByText('AP flour')).toHaveCount(0);
    // The next row's Remove button, not the page body.
    await expect(section.getByRole('button', { name: 'Remove the match for old thing' })).toBeFocused();
    await section.getByRole('button', { name: 'Remove the match for old thing' }).click();
    await section.getByRole('button', { name: 'Yes, remove the match for old thing' }).click();
    await expect(section.getByRole('list', { name: 'Matched ingredient names' })).toHaveCount(0);
    await expect(section.getByRole('heading', { name: 'Ingredient names you matched' })).toBeFocused();
    await section.getByRole('button', { name: /^Remove the conversion 1 cup/ }).click();
    await section.getByRole('button', { name: /^Yes, remove the conversion/ }).click();
    await expect(section.getByRole('heading', { name: 'Conversions you accepted' })).toBeFocused();
  });

  test('other members see the convention read-only with an explanation', async ({ page }) => {
    const api = await mock(page, { inventory: matched(), role: 'member' });
    await page.goto('/#inventory');
    const section = page.getByRole('region', { name: 'Recipe matching' });
    await expect(section.getByText('US nutrition label', { exact: true })).toBeVisible();
    await expect(section.getByText('Only the family administrator can change this.')).toBeVisible();
    await expect(section.getByRole('combobox')).toHaveCount(0);
    expect(api.ofPath('/api/inventory/settings', 'PUT')).toHaveLength(0);
  });

  test('tolerates an older inventory response without the new fields', async ({ page }) => {
    const old = stock() as Partial<InventoryState>;
    delete old.aliases; delete old.calibrations; delete old.settings;
    await mock(page, { inventory: old as InventoryState });
    await page.goto('/#inventory');
    const section = page.getByRole('region', { name: 'Recipe matching' });
    await expect(section.getByLabel('Measuring convention')).toHaveValue('');
    await expect(section.getByText('Open a recipe and choose “Check pantry”')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plain flour', level: 2 })).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations or overflow at 390px and 320px in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await mock(page, { inventory: matched() });
      await page.goto('/#inventory');
      const section = page.getByRole('region', { name: 'Recipe matching' });
      await expect(section).toBeVisible();
      await section.getByRole('button', { name: 'Remove the match for AP flour' }).click();
      await axe(page, '#main-content', `${scheme} recipe matching`);
      await page.setViewportSize({ width: 320, height: 700 });
      expect(await noOverflow(page)).toBe(true);
      const small = await section.locator('.button, select').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height < 43.5).length);
      expect(small).toBe(0);
    });
  }
});

/* ------------------------------------------------------------------ real Worker + local D1 */

const ORIGIN = 'http://localhost:5173';
const authFile = new URL('../../.wrangler/e2e-auth.json', import.meta.url);
const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
const real = base.extend({
  storageState: async ({}, use) => {
    const { sessions } = JSON.parse(readFileSync(authFile, 'utf8')) as { sessions: Record<string, string> };
    await use({ cookies: [{ name: '__Host-hearth_session', value: sessions.alex, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' }], origins: [] });
  },
});

async function setModule(request: APIRequestContext, enabled: boolean) {
  expect((await request.patch('/api/modules/inventory', { headers, data: { enabled } })).status(), 'module toggle').toBe(200);
}
/** Leaves the disposable database with inventory off and nothing active in it. */
async function resetReal(request: APIRequestContext, created: { recordIds: string[] }) {
  await setModule(request, true);
  const state = await (await request.get('/api/inventory')).json() as InventoryState;
  for (const alias of state.aliases) expect((await request.post(`/api/inventory/aliases/${alias.id}/archive`, { headers, data: { version: alias.version } })).ok()).toBe(true);
  for (const cal of state.calibrations) expect((await request.post(`/api/inventory/calibrations/${cal.id}/archive`, { headers, data: { version: cal.version } })).ok()).toBe(true);
  for (const lot of state.lots) expect((await request.post(`/api/inventory/lots/${lot.id}/archive`, { headers, data: { txnId: `cleanup-${crypto.randomUUID()}`, version: lot.version, reason: 'Test cleanup' } })).ok()).toBe(true);
  for (const row of state.items) expect((await request.post(`/api/inventory/items/${row.id}/archive`, { headers, data: { version: row.version } })).ok()).toBe(true);
  if (state.settings.measureProfile) expect((await request.put('/api/inventory/settings', { headers, data: { measureProfile: null, version: state.settings.version } })).ok()).toBe(true);
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const mine = boot.records.filter(r => created.recordIds.includes(r.id) || (r.kind === 'task' && r.data.title.startsWith('Buy: Plain flour')));
  for (const r of mine) await request.delete(`/api/records/${r.id}`, { headers, data: { version: r.version } });
  await setModule(request, false);
}
async function seedItem(request: APIRequestContext, name: string, dim: string, lot?: [string, string]) {
  const made = await request.post('/api/inventory/items', { headers, data: { name, dim } });
  expect(made.status()).toBe(201);
  const row = await made.json() as { id: string };
  if (lot) expect((await request.post('/api/inventory/lots', { headers, data: { txnId: `seed-${crypto.randomUUID()}`, itemId: row.id, locationId: null, amount: lot[0], unit: lot[1], precision: 'exact', note: '' } })).status()).toBe(201);
  return row.id;
}
async function seedRecipe(request: APIRequestContext, created: { recordIds: string[] }, ingredients: Recipe['ingredients'], servings = 2) {
  const response = await request.post('/api/records', { headers, data: { kind: 'recipe', data: { ...recipe, title: 'Pantry check bread', servings, ingredients } } });
  expect(response.status()).toBe(201);
  const row = await response.json() as { id: string };
  created.recordIds.push(row.id);
  return row.id;
}

real.describe('Pantry check on the real Worker and local D1', () => {
  real.setTimeout(120000);
  const created = { recordIds: [] as string[] };
  real.beforeEach(async ({ request }) => { created.recordIds = []; await setModule(request, true); });
  real.afterEach(async ({ request }) => { await resetReal(request, created); });

  real('matches an ingredient, finds enough, then a shortage for more servings, and adds the shortage to Tasks', async ({ page, request }) => {
    await seedItem(request, 'Plain flour', 'mass', ['500', 'g']);
    await seedRecipe(request, created, [{ name: 'plain flour', quantity: 300, unit: 'g' }]);
    await page.goto('/#recipes');
    await page.getByRole('button', { name: 'View Pantry check bread', exact: true }).click();
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Nothing to compare' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Match to inventory item for plain flour' }).click();
    const dialog = dialogOf(page);
    await dialog.getByLabel('Inventory item').selectOption({ label: 'Plain flour (Weight)' });
    await dialog.getByRole('button', { name: 'Save match' }).click();
    await expect(dialog).toHaveCount(0);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    await expect(panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' })).toContainText('300 g');
    await page.getByLabel('Servings', { exact: true }).fill('4');
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Not enough yet' })).toBeVisible();
    await expect(panel(page)).toContainText('Short by 100 g');
    await panel(page).getByRole('button', { name: 'Add to Tasks' }).click();
    await expect(dialog).toContainText('Buy: Plain flour (100 g)');
    await dialog.getByRole('button', { name: 'Add 1 task' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Added to Tasks' })).toBeDisabled();
    const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
    expect(boot.records.filter(r => r.kind === 'task' && r.data.title === 'Buy: Plain flour (100 g)')).toHaveLength(1);
  });

  real('needs a measuring convention, then a conversion, before cups can be compared with weighed flour', async ({ page, request }) => {
    const flour = await seedItem(request, 'Plain flour', 'mass', ['500', 'g']);
    expect((await request.post('/api/inventory/aliases', { headers, data: { name: 'plain flour', itemId: flour } })).status()).toBe(201);
    await seedRecipe(request, created, [{ name: 'plain flour', quantity: 2, unit: 'cup' }]);
    await page.goto('/#recipes');
    await page.getByRole('button', { name: 'View Pantry check bread', exact: true }).click();
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'Can’t confirm' })).toBeVisible();
    await expect(panel(page)).toContainText('Cups and spoons differ by region — choose your measuring convention in Inventory');
    // The administrator picks a convention on the Inventory page.
    await panel(page).getByRole('link', { name: /Open Inventory/ }).click();
    await page.getByRole('region', { name: 'Recipe matching' }).getByLabel('Measuring convention').selectOption('us-label');
    await expect(page.getByRole('status').filter({ hasText: 'Measuring convention set to US nutrition label.' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Matched ingredient names' })).toContainText('plain flour');
    await page.goto('/#recipes');
    await page.getByRole('button', { name: 'View Pantry check bread', exact: true }).click();
    await runCheck(page);
    await expect(panel(page)).toContainText('add a conversion like 1 cup = 120 g');
    await panel(page).getByRole('button', { name: 'Add conversion for Plain flour' }).click();
    const dialog = dialogOf(page);
    await dialog.getByLabel('Recipe measure').fill('1');
    await dialog.getByLabel('Equals').fill('120');
    await dialog.getByLabel('Measuring convention').selectOption('us-label');
    await dialog.getByRole('button', { name: 'Save conversion' }).click();
    await expect(dialog).toHaveCount(0);
    await runCheck(page);
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    await expect(panel(page).getByRole('listitem').filter({ hasText: 'Plain flour' })).toContainText('240 g');
    // The conversion is listed on the Inventory page, and removing it brings the question back.
    await page.goto('/#inventory');
    const list = page.getByRole('list', { name: 'Accepted conversions' });
    await expect(list).toContainText('1 cup (US nutrition label) = 120 g');
    await list.getByRole('button', { name: /^Remove the conversion/ }).click();
    await list.getByRole('button', { name: /^Yes, remove the conversion/ }).click();
    await expect(page.getByRole('list', { name: 'Accepted conversions' })).toHaveCount(0);
  });

  real('a non-administrator sees the convention read-only', async ({ browser }) => {
    const { sessions } = JSON.parse(readFileSync(authFile, 'utf8')) as { sessions: Record<string, string> };
    const context = await browser.newContext({ storageState: { cookies: [{ name: '__Host-hearth_session', value: sessions.sam, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' }], origins: [] } });
    const page = await context.newPage();
    await page.goto('/#inventory');
    const section = page.getByRole('region', { name: 'Recipe matching' });
    await expect(section.getByText('Only the family administrator can change this.')).toBeVisible();
    await expect(section.getByRole('combobox')).toHaveCount(0);
    await context.close();
  });
});
