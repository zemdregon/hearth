import { readFileSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';
import type { Bootstrap, FamilyRecord, Recipe } from '../../src/shared/types';
import type { AvailabilityResult, ConsumeAllocation, ConsumeLine, ConsumePreview, InvConsumption, InventoryState } from '../../src/shared/inventory/wire';

/* ------------------------------------------------------------------ fixtures */

const test = base.extend({});
const G = 1_000_000_000; // 1 g in the wire's integer ng
const ML = 1_000_000; // 1 mL in nL
const exact = (value: number) => ({ lo: value, hi: value });

const RECIPE_ID = 'recipe-pancakes-fixture';
const recipe: Recipe = {
  title: 'Sunday pancakes', description: 'Fluffy and quick.', servings: 4, prepMinutes: 10, cookMinutes: 15, tags: ['Breakfast'], favorite: false,
  ingredients: [
    { name: 'plain flour', quantity: 300, unit: 'g' }, { name: 'eggs', quantity: 2, unit: '' }, { name: 'whole milk', quantity: null, unit: '', note: 'a splash' },
    { name: 'fresh parsley', quantity: null, unit: '', note: 'to garnish' }, { name: 'salt', quantity: null, unit: '', note: 'to taste' },
  ],
  steps: ['Whisk everything together.', 'Cook on a hot pan.'],
};
const record: FamilyRecord<'recipe'> = { id: RECIPE_ID, kind: 'recipe', data: recipe, ownerId: 'alex', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const family = (): Bootstrap => ({ ...createDemo(), demo: false, modules: createDemo().modules.map(module => ({ ...module, enabled: true })), records: [...createDemo().records.filter(r => r.kind !== 'recipe'), record] });

const available: AvailabilityResult = {
  verdict: 'sufficient', servings: 4, recipeServings: 4, unmapped: [], excluded: [],
  items: [{ itemId: 'item-flour', itemName: 'Plain flour', dim: 'mass', lineIndexes: [0], verdict: 'sufficient', reasons: [], need: exact(300 * G), have: exact(1700 * G), needComplete: true, haveComplete: true, short: null }],
};

const lotA: ConsumeAllocation = { lotId: 'lot-flour-a', version: 3, enteredText: '200 g', locationId: 'loc-pantry', date: '2099-12-01', dateKind: 'best_by', precision: 'exact', available: 200 * G, take: 200 * G };
const lotB: ConsumeAllocation = { lotId: 'lot-flour-b', version: 2, enteredText: '500 g', locationId: 'loc-fridge', date: '2099-12-31', dateKind: 'use_by', precision: 'estimated', available: 500 * G, take: 100 * G };
const lotC: ConsumeAllocation = { lotId: 'lot-flour-c', version: 1, enteredText: '1 kg', locationId: null, date: null, dateKind: null, precision: 'exact', available: 1000 * G, take: 0 };
const lotEggs: ConsumeAllocation = { lotId: 'lot-eggs', version: 1, enteredText: '6 eggs', locationId: null, date: null, dateKind: null, precision: 'exact', available: 6, take: 2 };
const lotMilk: ConsumeAllocation = { lotId: 'lot-milk', version: 1, enteredText: '1 L', locationId: null, date: null, dateKind: null, precision: 'exact', available: 1000 * ML, take: 0 };

function flourLine(name = 'Plain flour', allocations = [lotA, lotB, lotC]): ConsumeLine {
  return { itemId: 'item-flour', itemName: name, dim: 'mass', lineIndexes: [0], reasons: [], need: exact(300 * G), needComplete: true, suggested: 300 * G, allocations, shortfall: 0 };
}
const eggsLine = (): ConsumeLine => ({ itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', lineIndexes: [1], reasons: [], need: exact(2), needComplete: true, suggested: 2, allocations: [lotEggs], shortfall: 0 });
const milkLine = (): ConsumeLine => ({ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', lineIndexes: [2], reasons: ['UNQUANTIFIED'], need: exact(0), needComplete: false, suggested: null, allocations: [lotMilk], shortfall: 0 });
function proposal(over: Partial<ConsumePreview> = {}): ConsumePreview {
  return { recipeId: RECIPE_ID, recipeTitle: 'Sunday pancakes', servings: 4, lines: [flourLine(), eggsLine(), milkLine()], unmapped: [{ index: 3, name: 'fresh parsley' }], excluded: [4], ...over };
}

function stock(): InventoryState {
  return {
    locations: [{ id: 'loc-pantry', name: 'Pantry shelf', kind: 'pantry', version: 1 }, { id: 'loc-fridge', name: 'Fridge', kind: 'fridge', version: 1 }],
    items: [{ id: 'item-flour', name: 'Plain flour', dim: 'mass', version: 1 }, { id: 'item-milk', name: 'Whole milk', dim: 'volume', version: 1 }, { id: 'item-eggs', name: 'Eggs', dim: 'count:egg', version: 1 }],
    lots: [], aliases: [], calibrations: [], settings: { measureProfile: null, version: 1 },
  };
}

const entry = (over: Partial<InvConsumption> & Pick<InvConsumption, 'txnId'>): InvConsumption => ({
  recipeId: RECIPE_ID, recipeTitle: 'Sunday pancakes', servings: 4, memberId: 'alex', createdAt: 1_760_000_000, lots: [], shortfalls: [], undoneBy: null, canUndo: false, reverses: null, ...over,
});
const COOK_1 = 'cook-one-aaaaaaaa';
const UNDO_2 = 'undo-two-bbbbbbbb';
const COOK_2 = 'cook-two-cccccccc';
const COOK_3 = 'cook-three-dddddddd';
const history = (): InvConsumption[] => [
  entry({ txnId: COOK_1, canUndo: true, createdAt: 1_760_000_900, lots: [{ lotId: 'lot-flour-a', itemId: 'item-flour', itemName: 'Plain flour', dim: 'mass', delta: -200 * G }, { lotId: 'lot-flour-b', itemId: 'item-flour', itemName: 'Plain flour', dim: 'mass', delta: -100 * G }, { lotId: 'lot-eggs', itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', delta: -2 }], shortfalls: [{ itemId: 'item-milk', itemName: 'Whole milk', dim: 'volume', amount: 1000 * ML }] }),
  entry({ txnId: UNDO_2, reverses: COOK_2, createdAt: 1_760_000_600, memberId: 'sam', lots: [{ lotId: 'lot-eggs', itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', delta: 3 }] }),
  entry({ txnId: COOK_2, undoneBy: UNDO_2, createdAt: 1_760_000_500, memberId: 'sam', lots: [{ lotId: 'lot-eggs', itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', delta: -3 }] }),
];
const olderHistory = (): InvConsumption[] => [entry({ txnId: COOK_3, recipeTitle: 'Weeknight omelette', servings: 1, createdAt: 1_759_000_000, lots: [{ lotId: 'lot-eggs', itemId: 'item-eggs', itemName: 'Eggs', dim: 'count:egg', delta: -2 }] })];

type Reply = { status?: number; json: unknown };
type Call = { method: string; path: string; search: string; body: Record<string, any> | null };
type Replies = (Reply | ((body: Record<string, any>) => Reply))[];
type MockOptions = { preview?: Replies; consume?: Replies; undo?: Replies; entries?: InvConsumption[]; older?: InvConsumption[]; inventory?: InventoryState; availability?: Replies };

/** A small in-memory stand-in for the inventory, records and cooking routes; every request is recorded. */
async function mock(page: Page, options: MockOptions = {}) {
  const calls: Call[] = [];
  const inventory = options.inventory ?? stock();
  const world = { entries: options.entries ?? [], older: options.older ?? [], bootstraps: 0, off: false };
  const counters: Record<string, number> = {};
  const answer = (name: string, replies: Replies, body: Record<string, any>, fallback: Reply): Reply => {
    const reply = replies.length ? replies[Math.min(counters[name] = (counters[name] ?? -1) + 1, replies.length - 1)] : fallback;
    return typeof reply === 'function' ? reply(body) : reply;
  };
  // Once the server has answered 403 the module really is off, so a later bootstrap says so (and the panel goes away).
  await page.route('**/api/bootstrap', route => { world.bootstraps++; return route.fulfill({ json: world.off ? { ...family(), modules: family().modules.map(module => ({ ...module, enabled: module.id !== 'inventory' })) } : family() }); });
  await page.route(url => url.pathname.startsWith('/api/inventory'), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: Record<string, any> | null = null;
    try { body = request.postDataJSON() as Record<string, any> | null; } catch { body = null; }
    calls.push({ method: request.method(), path, search: url.search, body });
    const method = request.method();
    const send = (reply: Reply) => { if (reply.status === 403) world.off = true; return route.fulfill({ status: reply.status ?? 200, json: reply.json }); };
    if (method === 'GET' && path === '/api/inventory') return route.fulfill({ json: inventory });
    if (method === 'POST' && path === '/api/inventory/availability') return send(answer('availability', options.availability ?? [], body ?? {}, { json: available }));
    if (method === 'POST' && path === '/api/inventory/consume/preview') return send(answer('preview', options.preview ?? [], body ?? {}, { json: proposal() }));
    if (method === 'POST' && path === '/api/inventory/consume') return send(answer('consume', options.consume ?? [], body ?? {}, { status: 201, json: { lots: [], replayed: false, txnId: body?.txnId } }));
    if (method === 'POST' && /^\/api\/inventory\/txns\/[^/]+\/undo$/.test(path)) {
      const reply = answer('undo', options.undo ?? [], body ?? {}, { status: 201, json: { lots: [], replayed: false, txnId: body?.txnId } });
      if ((reply.status ?? 200) < 300) {
        const target = path.split('/')[4];
        const original = world.entries.find(row => row.txnId === target);
        if (original) {
          original.canUndo = false; original.undoneBy = 'undo-new-eeeeeeee';
          world.entries.unshift(entry({ txnId: 'undo-new-eeeeeeee', reverses: target, createdAt: 1_760_001_000, lots: original.lots.map(lot => ({ ...lot, delta: -lot.delta })) }));
        }
      } else if (reply.status === 409) { const original = world.entries.find(row => row.txnId === path.split('/')[4]); if (original) original.canUndo = false; }
      return send(reply);
    }
    if (method === 'GET' && path === '/api/inventory/consumptions') {
      const before = url.searchParams.get('before');
      return route.fulfill({ json: before ? { entries: world.older, next: null } : { entries: world.entries, next: world.older.length ? 3 : null } });
    }
    return route.fulfill({ status: 404, json: { error: 'Not mocked.' } });
  });
  return { calls, inventory, world, ofPath: (path: string, method = 'POST') => calls.filter(call => call.path === path && call.method === method) };
}

const dialogOf = (page: Page) => page.getByRole('dialog');
const panel = (page: Page) => page.getByRole('region', { name: 'Pantry check' });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function openRecipe(page: Page) {
  await page.goto('/#recipes');
  await page.getByRole('button', { name: 'View Sunday pancakes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sunday pancakes', level: 1 })).toBeVisible();
}
async function checkPantry(page: Page) {
  await panel(page).getByRole('button', { name: /^Check (pantry|again)$/ }).click();
  await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
}
/** Opens the recipe, runs the pantry check and opens the cooking dialog; milk (no exact amount) is left for the cook to fill. */
// Cooking history is append-only, so real-Worker tests use titles that are unique to each run.
const RUN = Math.random().toString(36).slice(2, 8);
const LOAF = `Cooking test loaf ${RUN}`;
const STALE_LOAF = `Cooking stale loaf ${RUN}`;

async function openCook(page: Page) {
  await openRecipe(page);
  await checkPantry(page);
  await panel(page).getByRole('button', { name: 'Cook this' }).click();
  await expect(dialogOf(page).getByRole('heading', { name: 'Cook this' })).toBeVisible();
  await expect(dialogOf(page).locator('.cook-line')).toHaveCount(3);
}
const line = (page: Page, name: string) => dialogOf(page).locator('.cook-line').filter({ hasText: name });
const used = (page: Page, name: string) => line(page, name).getByLabel(`Actually used: ${name}`, { exact: true });
const unit = (page: Page, name: string) => line(page, name).getByLabel(`Unit for ${name}`, { exact: true });
const take = (page: Page, name: string, lot: string) => line(page, name).getByLabel(`Take from ${lot}`, { exact: true });
const confirm = (page: Page) => dialogOf(page).getByRole('button', { name: 'Use these ingredients' });
async function axe(page: Page, selector: string, label: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical'), `${label}: serious or critical`).toEqual([]);
  expect(results.violations, `${label}: all violations`).toEqual([]);
}
const tooSmall = (area: Locator) => area.locator('.button, select, input:not([type="checkbox"]), .pantry-toggle').evaluateAll(elements => elements.filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height < 43.5; }).map(element => `${element.tagName}.${element.className}:${Math.round(element.getBoundingClientRect().height)}`));

/** The default cook: flour 300 g from two lots, 2 eggs, 200 mL of milk the cook types in. */
async function fillMilk(page: Page, amount = '200') { await used(page, 'Whole milk').fill(amount); }

/* ------------------------------------------------------------------ the cooking dialog */

test.describe('Cook this: review and confirm', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks the server nothing on its own, then once with only ids and numbers when the cook asks', async ({ page }) => {
    const api = await mock(page);
    await openRecipe(page);
    await page.getByLabel('Servings', { exact: true }).fill('6');
    await page.waitForTimeout(300);
    expect(api.calls.filter(call => call.path.startsWith('/api/inventory'))).toEqual([]);
    await expect(panel(page).getByRole('button', { name: 'Cook this' })).toHaveCount(0);
    await checkPantry(page);
    await page.waitForTimeout(300);
    expect(api.ofPath('/api/inventory/consume/preview')).toHaveLength(0);
    await panel(page).getByText('Skip optional lines').click();
    await panel(page).getByRole('checkbox', { name: 'Exclude from check: fresh parsley' }).check();
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Cook this' })).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Check again' }).click();
    await expect(panel(page).getByRole('heading', { name: 'You have enough' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    await expect(dialogOf(page).locator('.cook-line')).toHaveCount(3);
    expect(api.ofPath('/api/inventory/consume/preview')).toHaveLength(1);
    expect(api.ofPath('/api/inventory/consume/preview')[0].body).toEqual({ recipeId: RECIPE_ID, servings: 6, exclude: [3] });
    expect(api.ofPath('/api/inventory/consume')).toHaveLength(0);
  });

  test('prefills the suggested amounts, shows the lots earliest first, and asks for what is not exact', async ({ page }) => {
    const api = await mock(page);
    await openCook(page);
    const dialog = dialogOf(page);
    await expect(used(page, 'Plain flour')).toBeFocused();
    await expect(used(page, 'Plain flour')).toHaveValue('300');
    await expect(unit(page, 'Plain flour')).toHaveValue('g');
    await expect(used(page, 'Eggs')).toHaveValue('2');
    await expect(unit(page, 'Eggs')).toHaveValue('egg');
    await expect(used(page, 'Whole milk')).toHaveValue('');
    await expect(line(page, 'Whole milk')).toContainText('The recipe doesn’t give an exact amount here, so enter what you actually used.');
    await expect(line(page, 'Plain flour').locator('dt', { hasText: 'Suggested' }).locator('xpath=following-sibling::dd')).toHaveText('300 g');
    await expect(line(page, 'Whole milk').locator('dt', { hasText: 'Suggested' }).locator('xpath=following-sibling::dd')).toHaveText('You choose');
    const lots = line(page, 'Plain flour').locator('.cook-lot');
    await expect(lots).toHaveCount(3);
    await expect(lots.nth(0)).toContainText('200 g');
    await expect(lots.nth(0)).toContainText('Pantry shelf');
    await expect(lots.nth(0)).toContainText('Best by Dec 1, 2099');
    await expect(lots.nth(0)).toContainText('200 g available');
    await expect(lots.nth(1)).toContainText('About 500 g');
    await expect(lots.nth(1)).toContainText('Estimated');
    await expect(lots.nth(1)).toContainText('Fridge');
    await expect(lots.nth(1)).toContainText('Use by Dec 31, 2099');
    await expect(lots.nth(2)).toContainText('No set place');
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toHaveValue('200');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('100');
    await expect(take(page, 'Plain flour', '1 kg, No set place')).toHaveValue('0');
    await expect(dialog.getByRole('list', { name: 'Not deducted' })).toContainText('fresh parsley');
    await expect(dialog.getByRole('list', { name: 'Not deducted' })).toContainText('Not matched to your inventory');
    await expect(dialog.getByRole('list', { name: 'Not deducted' })).toContainText('salt');
    await expect(dialog.getByRole('list', { name: 'Not deducted' })).toContainText('Skipped by you');
    // The amount nobody could suggest must be typed in; nothing is sent until it is.
    await confirm(page).click();
    await expect(line(page, 'Whole milk').getByRole('alert')).toContainText('Enter one exact amount');
    await expect(used(page, 'Whole milk')).toBeFocused();
    expect(api.ofPath('/api/inventory/consume')).toHaveLength(0);
    await fillMilk(page);
    await expect(dialog.locator('.cook-summary-text')).toContainText('This will take stock from 4 lots across 3 items.');
    // Changing only the unit of a suggested amount re-states it instead of silently changing it.
    await unit(page, 'Plain flour').selectOption('kg');
    await expect(used(page, 'Plain flour')).toHaveValue('0.3');
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toHaveValue('0.2');
  });

  test('editing the used amount refills the lots in the proposed order, and a lot can be set by hand', async ({ page }) => {
    const api = await mock(page);
    await openCook(page);
    await fillMilk(page);
    await used(page, 'Plain flour').fill('450');
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toHaveValue('200');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('250');
    await expect(take(page, 'Plain flour', '1 kg, No set place')).toHaveValue('0');
    await used(page, 'Plain flour').fill('900');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('500');
    await expect(take(page, 'Plain flour', '1 kg, No set place')).toHaveValue('200');
    await used(page, 'Plain flour').fill('450');
    // A hand-set lot keeps its amount and the rest refills around it.
    await take(page, 'Plain flour', '200 g, Pantry shelf').fill('150');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('300');
    await expect(line(page, 'Plain flour').getByRole('button', { name: 'Go back to the suggested split' })).toBeVisible();
    // More than the lot holds, or not a number: refused, with nothing sent.
    await take(page, 'Plain flour', '200 g, Pantry shelf').fill('250');
    await expect(line(page, 'Plain flour').getByRole('alert')).toContainText('That is more than the 200 g in this lot.');
    await confirm(page).click();
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toBeFocused();
    await take(page, 'Plain flour', '200 g, Pantry shelf').fill('lots');
    await expect(line(page, 'Plain flour').getByRole('alert')).toContainText('Enter one exact amount');
    await take(page, 'Plain flour', '200 g, Pantry shelf').fill('-5');
    await expect(line(page, 'Plain flour').getByRole('alert')).toBeVisible();
    expect(api.ofPath('/api/inventory/consume')).toHaveLength(0);
    await line(page, 'Plain flour').getByRole('button', { name: 'Go back to the suggested split' }).click();
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toHaveValue('200');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('250');
    await expect(line(page, 'Plain flour').getByRole('alert')).toHaveCount(0);
    // A typed amount that is not an exact quantity is refused as in the add-stock dialog.
    await used(page, 'Plain flour').fill('1 or 2');
    await expect(line(page, 'Plain flour').getByRole('alert')).toContainText('Enter one exact amount');
    await line(page, 'Plain flour').getByRole('button', { name: 'Use the suggested amount' }).click();
    await expect(used(page, 'Plain flour')).toHaveValue('300');
  });

  test('says plainly when more was used than recorded, and sends the excess as a shortfall without touching stock', async ({ page }) => {
    const api = await mock(page);
    await openCook(page);
    await fillMilk(page, '2000');
    const note = line(page, 'Whole milk').locator('.cook-note');
    await expect(note).toHaveText('Recorded stock only covers 1 L — the extra 1 L will be noted as used beyond what was recorded; nothing goes negative.');
    await expect(take(page, 'Whole milk', '1 L, No set place')).toHaveValue('1000');
    await expect(dialogOf(page).locator('.cook-summary-text')).toContainText('1 item has amounts noted as used beyond what was recorded.');
    await confirm(page).click();
    await expect(dialogOf(page).getByRole('heading', { name: 'Done. Your stock is updated' })).toBeFocused();
    const sent = api.ofPath('/api/inventory/consume');
    expect(sent).toHaveLength(1);
    const body = sent[0].body!;
    expect(Object.keys(body).sort()).toEqual(['recipeId', 'servings', 'shortfalls', 'takes', 'txnId']);
    expect(body.txnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.recipeId).toBe(RECIPE_ID);
    expect(body.servings).toBe(4);
    expect(body.takes).toEqual([
      { lotId: 'lot-flour-a', version: 3, take: 200 * G }, { lotId: 'lot-flour-b', version: 2, take: 100 * G },
      { lotId: 'lot-eggs', version: 1, take: 2 }, { lotId: 'lot-milk', version: 1, take: 1000 * ML },
    ]);
    expect(body.shortfalls).toEqual([{ itemId: 'item-milk', amount: 1000 * ML }]);
    await expect(dialogOf(page)).toContainText('Taken from 4 lots:');
    await expect(dialogOf(page).locator('.cook-summary')).toContainText('Plain flour: 300 g');
    await expect(dialogOf(page).locator('.cook-summary')).toContainText('Eggs: 2 eggs');
    await expect(dialogOf(page)).toContainText('Also used beyond what was recorded');
    await expect(dialogOf(page)).toContainText('Whole milk: 1 L');
  });

  test('an unticked ingredient is not deducted, and with nothing left to deduct the button explains itself', async ({ page }) => {
    const api = await mock(page);
    await openCook(page);
    await fillMilk(page);
    await line(page, 'Eggs').getByRole('checkbox').uncheck();
    await expect(line(page, 'Eggs')).toContainText('Not deducted');
    await expect(line(page, 'Eggs')).toContainText('Nothing will be taken out of stock for Eggs.');
    await expect(used(page, 'Eggs')).toHaveCount(0);
    await expect(dialogOf(page).locator('.cook-summary-text')).toContainText('This will take stock from 3 lots across 2 items.');
    await line(page, 'Plain flour').getByRole('checkbox').uncheck();
    await line(page, 'Whole milk').getByRole('checkbox').uncheck();
    await expect(confirm(page)).toBeDisabled();
    await expect(dialogOf(page).locator('.cook-summary-text')).toHaveText('Tick at least one ingredient to take it out of stock.');
    await line(page, 'Whole milk').getByRole('checkbox').check();
    await expect(confirm(page)).toBeEnabled();
    await line(page, 'Plain flour').getByRole('checkbox').check();
    await line(page, 'Eggs').getByRole('checkbox').check();
    await line(page, 'Eggs').getByRole('checkbox').uncheck();
    await confirm(page).click();
    await expect(dialogOf(page).getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    const body = api.ofPath('/api/inventory/consume')[0].body!;
    expect(body.takes.map((row: { lotId: string }) => row.lotId)).toEqual(['lot-flour-a', 'lot-flour-b', 'lot-milk']);
    expect(body.shortfalls).toEqual([]);
  });

  test('stock that cannot be taken from means nothing can be recorded, and says so', async ({ page }) => {
    await mock(page, { preview: [{ json: proposal({ lines: [flourLine('Plain flour', []), { ...eggsLine(), allocations: [] }], unmapped: [], excluded: [] }) }] });
    await openRecipe(page);
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    const dialog = dialogOf(page);
    await expect(line(page, 'Plain flour')).toContainText('There is no recorded stock of Plain flour to take from.');
    await expect(line(page, 'Plain flour').locator('.cook-note')).toContainText('Recorded stock only covers 0 g — the extra 300 g will be noted');
    await expect(confirm(page)).toBeDisabled();
    await expect(dialog.locator('.cook-summary-text')).toContainText('There is no recorded stock to take from for what is ticked, so nothing can be deducted.');
    await expect(confirm(page)).toHaveAccessibleDescription(/no recorded stock to take from/);
  });

  test('with no matched ingredients there is nothing to take out of stock', async ({ page }) => {
    await mock(page, { preview: [{ json: proposal({ lines: [], unmapped: [{ index: 0, name: 'plain flour' }], excluded: [] }) }] });
    await openRecipe(page);
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    await expect(dialogOf(page).locator('.cook-summary-text')).toContainText('None of this recipe’s ingredients are matched to your inventory yet');
    await expect(confirm(page)).toBeDisabled();
    await expect(dialogOf(page).getByRole('list', { name: 'Not deducted' })).toContainText('plain flour');
  });

  test('success offers undo and marks the pantry check out of date; undo puts it back and says so', async ({ page }) => {
    const api = await mock(page);
    await openCook(page);
    await fillMilk(page);
    await confirm(page).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Done. Your stock is updated' })).toBeFocused();
    await expect(dialog.getByRole('status').filter({ hasText: 'Recorded. The ingredients were taken out of stock.' })).toBeAttached();
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeAttached();
    const cooked = api.ofPath('/api/inventory/consume')[0].body!.txnId as string;
    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog.getByRole('heading', { name: 'Everything is back where it was' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    const undo = api.calls.filter(call => /\/txns\/.+\/undo$/.test(call.path));
    expect(undo).toHaveLength(1);
    expect(undo[0].path).toBe(`/api/inventory/txns/${cooked}/undo`);
    expect(Object.keys(undo[0].body!)).toEqual(['txnId']);
    expect(undo[0].body!.txnId).not.toBe(cooked);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Check again' })).toBeFocused();
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Cook this' })).toHaveCount(0);
    // Nothing else re-ran on its own.
    expect(api.ofPath('/api/inventory/availability')).toHaveLength(1);
    expect(api.ofPath('/api/inventory/consume/preview')).toHaveLength(1);
  });

  test('a refused undo shows the server’s reason and stops offering undo', async ({ page }) => {
    await mock(page, { undo: [{ status: 409, json: { error: 'This was already undone.' } }] });
    await openCook(page);
    await fillMilk(page);
    await confirm(page).click();
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog.getByRole('alert')).toContainText('This was already undone.');
    await expect(dialog.getByRole('alert')).toContainText('If the shelf looks different now, recount');
    await expect(dialog.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(dialog).toContainText('You can recount them from Inventory.');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  });

  test('a 409 keeps the dialog and the edited amounts, rechecks the pantry, and a new payload gets a new id', async ({ page }) => {
    const moved = proposal({ lines: [flourLine('Plain flour', [{ ...lotA, version: 4, available: 150 * G, take: 150 * G }, { ...lotB, take: 100 * G }, lotC]), eggsLine(), milkLine()] });
    const api = await mock(page, {
      preview: [{ json: proposal() }, { json: moved }],
      consume: [{ status: 409, json: { error: 'Inventory changed. Refresh and try again.' } }, { status: 201, json: { lots: [], replayed: false, txnId: 'x' } }],
    });
    await openCook(page);
    await fillMilk(page);
    await used(page, 'Plain flour').fill('250');
    await confirm(page).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('alert')).toContainText('Inventory changed. Refresh and try again. We checked your pantry again.');
    await expect(dialog.getByRole('alert')).toContainText('Your amounts are still here');
    await expect(dialog.getByRole('heading', { name: 'Cook this' })).toBeVisible();
    await expect.poll(() => api.ofPath('/api/inventory/consume/preview').length).toBe(2);
    await expect(used(page, 'Plain flour')).toHaveValue('250');
    await expect(used(page, 'Whole milk')).toHaveValue('200');
    await expect(line(page, 'Plain flour').locator('.cook-lot').nth(0)).toContainText('150 g available');
    await expect(line(page, 'Plain flour').locator('.cook-lot').nth(0)).toContainText('Changed just now');
    await expect(line(page, 'Plain flour').locator('.cook-lot').nth(1)).not.toContainText('Changed just now');
    await expect(take(page, 'Plain flour', '200 g, Pantry shelf')).toHaveValue('150');
    await expect(take(page, 'Plain flour', '500 g, Fridge')).toHaveValue('100');
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect(dialog.getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    const [first, second] = api.ofPath('/api/inventory/consume').map(call => call.body!);
    expect(first.takes[0]).toEqual({ lotId: 'lot-flour-a', version: 3, take: 200 * G });
    expect(second.takes[0]).toEqual({ lotId: 'lot-flour-a', version: 4, take: 150 * G });
    expect(second.txnId).not.toBe(first.txnId);
  });

  test('a refusal for stock past its use-by date shows the server’s message and keeps the dialog', async ({ page }) => {
    const message = 'Some of this stock is past its use-by date. Archive it instead of cooking with it.';
    const api = await mock(page, { consume: [{ status: 409, json: { error: message } }] });
    await openCook(page);
    await fillMilk(page);
    await confirm(page).click();
    await expect(dialogOf(page).getByRole('alert')).toContainText(message);
    await expect(dialogOf(page).getByRole('heading', { name: 'Cook this' })).toBeVisible();
    await expect(used(page, 'Whole milk')).toHaveValue('200');
    await expect.poll(() => api.ofPath('/api/inventory/consume/preview').length).toBe(2);
  });

  test('a retry of the same payload reuses its id; an edited payload gets a new one', async ({ page }) => {
    const api = await mock(page, { consume: [{ status: 500, json: { error: 'We could not record that right now.' } }, { status: 500, json: { error: 'We could not record that right now.' } }, { status: 500, json: { error: 'We could not record that right now.' } }] });
    await openCook(page);
    await fillMilk(page);
    await confirm(page).click();
    await expect(dialogOf(page).getByRole('alert')).toContainText('We could not record that right now.');
    await confirm(page).click();
    await expect.poll(() => api.ofPath('/api/inventory/consume').length).toBe(2);
    await used(page, 'Eggs').fill('3');
    await expect(line(page, 'Eggs').locator('.cook-lot').first().getByRole('textbox')).toHaveValue('3');
    await confirm(page).click();
    await expect.poll(() => api.ofPath('/api/inventory/consume').length).toBe(3);
    const [one, two, three] = api.ofPath('/api/inventory/consume').map(call => call.body!);
    expect(two.txnId).toBe(one.txnId);
    expect(two).toEqual(one);
    expect(three.txnId).not.toBe(one.txnId);
    expect(three.takes.find((row: { lotId: string }) => row.lotId === 'lot-eggs').take).toBe(3);
    // The dialog is still open and fully usable after a failure.
    await expect(dialogOf(page).getByRole('heading', { name: 'Cook this' })).toBeVisible();
    await expect(confirm(page)).toBeEnabled();
  });

  test('a double click sends one request', async ({ page }) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/inventory/consume') posts.push(request.postData() ?? ''); });
    await mock(page);
    await openCook(page);
    await fillMilk(page);
    await page.route('**/api/inventory/consume', async route => { await gate; await route.fallback(); });
    await confirm(page).dblclick();
    await expect(confirm(page)).toBeDisabled();
    await page.waitForTimeout(300);
    release?.();
    await expect(dialogOf(page).getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  test('a paused module is explained inside the dialog, and the family settings refresh only after it is dismissed', async ({ page }) => {
    const api = await mock(page, { consume: [{ status: 403, json: { error: 'This module is disabled.' } }] });
    await openCook(page);
    await fillMilk(page);
    const loaded = api.world.bootstraps;
    await confirm(page).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('alert')).toContainText('Inventory is turned off right now, so nothing was taken out of stock.');
    await expect(dialog.getByRole('alert')).not.toContainText('This module is disabled.');
    await expect(confirm(page)).toHaveCount(0);
    // The explanation stays put: nothing refreshed the family (which would switch the panel off under it), and the pantry was not asked again.
    await page.waitForTimeout(500);
    expect(api.world.bootstraps).toBe(loaded);
    expect(api.ofPath('/api/inventory/consume/preview')).toHaveLength(1);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' }).last()).toBeFocused();
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.world.bootstraps).toBeGreaterThan(loaded);
    await expect(panel(page)).toHaveCount(0);
  });

  test('a preview refused because inventory is off keeps its explanation until the dialog is dismissed', async ({ page }) => {
    const api = await mock(page, { preview: [{ status: 403, json: { error: 'This module is disabled.' } }] });
    await openRecipe(page);
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('alert')).toContainText('Inventory is turned off right now, so nothing can be taken out of stock.');
    const loaded = api.world.bootstraps;
    await page.waitForTimeout(500);
    expect(api.world.bootstraps).toBe(loaded);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.world.bootstraps).toBeGreaterThan(loaded);
    await expect(panel(page)).toHaveCount(0);
  });

  test('lot labels read as people write them, never as internal unit tokens', async ({ page }) => {
    const lot = (lotId: string, enteredText: string, available: number): ConsumeAllocation => ({ lotId, version: 1, enteredText, locationId: null, date: null, dateKind: null, precision: 'exact', available, take: 0 });
    const lines = [
      flourLine('Plain flour', [lot('f1', '2 oz-mass', 56_699_000_000), lot('f2', '1 lb', 453_592_000_000)]),
      { ...eggsLine(), allocations: [lot('e1', '12 egg', 12), lot('e2', '1 egg', 1)] },
      { ...milkLine(), allocations: [lot('m1', '1 l', 1000 * ML), lot('m2', '1 fl oz', 29_573_000), lot('m3', '2 ml', 2 * ML)] },
    ];
    await mock(page, { preview: [{ json: proposal({ lines }) }] });
    await openCook(page);
    const flour = line(page, 'Plain flour');
    await expect(flour.locator('.cook-lot-top strong').nth(0)).toHaveText('2 oz');
    await expect(flour.locator('.cook-lot-top strong').nth(1)).toHaveText('1 lb');
    await expect(take(page, 'Plain flour', '2 oz, No set place')).toBeVisible();
    await expect(line(page, 'Eggs').locator('.cook-lot-top strong').nth(0)).toHaveText('12 eggs');
    await expect(line(page, 'Eggs').locator('.cook-lot-top strong').nth(1)).toHaveText('1 egg');
    await expect(line(page, 'Whole milk').locator('.cook-lot-top strong').nth(0)).toHaveText('1 L');
    await expect(line(page, 'Whole milk').locator('.cook-lot-top strong').nth(1)).toHaveText('1 fl oz');
    await expect(line(page, 'Whole milk').locator('.cook-lot-top strong').nth(2)).toHaveText('2 mL');
    await expect(dialogOf(page)).not.toContainText(/oz-mass|\b\d+ l\b|\b12 egg\b/);
  });

  test('a preview that fails or is paused says why and can be retried', async ({ page }) => {
    await mock(page, { preview: [{ status: 500, json: { error: 'We could not work that out.' } }, { json: proposal() }] });
    await openRecipe(page);
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    await expect(dialogOf(page).getByRole('alert')).toContainText('We could not work that out.');
    await dialogOf(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialogOf(page).locator('.cook-line')).toHaveCount(3);
  });

  test('is absent in the demo and when inventory is off', async ({ page }) => {
    await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...family(), modules: family().modules.map(module => ({ ...module, enabled: module.id !== 'inventory' })) } }));
    await openRecipe(page);
    await expect(page.getByText('Pantry check')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cook this' })).toHaveCount(0);
  });

  test('item choices in the match dialog name how each is measured without repeating the name', async ({ page }) => {
    await mock(page, { availability: [{ json: { ...available, verdict: 'unknown', unmapped: [{ index: 3, name: 'fresh parsley' }] } }] });
    await openRecipe(page);
    await panel(page).getByRole('button', { name: 'Check pantry' }).click();
    await panel(page).getByRole('button', { name: 'Match to inventory item for fresh parsley' }).click();
    const options = await dialogOf(page).getByLabel('Inventory item').locator('option').allTextContents();
    expect(options).toEqual(['Choose an item…', 'Eggs (counted in eggs)', 'Plain flour (Weight)', 'Whole milk (Volume)']);
  });

  test('keeps nothing from cooking in browser storage', async ({ page }) => {
    await mock(page);
    await openCook(page);
    await fillMilk(page);
    await confirm(page).click();
    await expect(dialogOf(page).getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    await dialogOf(page).getByRole('button', { name: 'Undo' }).click();
    await expect(dialogOf(page).getByRole('heading', { name: 'Everything is back where it was' })).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      session: Object.entries(sessionStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
      databases: (await indexedDB.databases()).map(database => database.name),
      caches: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    }));
    expect(stored.local + stored.session).not.toMatch(/Plain flour|consume|lot-flour|Sunday pancakes/i);
    expect(stored.databases).toEqual([]);
    expect(stored.caches.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
  });

  for (const width of [390, 320]) {
    test(`fits a ${width}px phone without horizontal scrolling, with comfortable targets`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const longName = 'Plain flour, an unusually long inventory item name that must wrap on a small phone';
      await mock(page, { preview: [{ json: proposal({ lines: [flourLine(longName), eggsLine(), milkLine()] }) }], consume: [{ status: 500, json: { error: 'We could not record that right now, and this message is deliberately long so that it has to wrap.' } }] });
      await openCook(page);
      const dialog = dialogOf(page);
      await fillMilk(page, '2000');
      await unit(page, 'Whole milk').selectOption('cup');
      await expect(dialog.getByLabel('Measuring convention')).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), 'dialog width').toBe(true);
      expect(await tooSmall(dialog)).toEqual([]);
      await dialog.getByLabel('Measuring convention').selectOption('us-customary');
      await confirm(page).click();
      await expect(dialog.getByRole('alert')).toContainText('We could not record that right now');
      expect(await noOverflow(page)).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), 'dialog width after an error').toBe(true);
      await dialog.getByRole('heading', { name: 'Cook this' }).scrollIntoViewIfNeeded();
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations at 390px in ${scheme} mode`, async ({ page }) => {
      test.setTimeout(90000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await mock(page, { consume: [{ status: 500, json: { error: 'We could not record that right now.' } }, { status: 201, json: { lots: [], replayed: false, txnId: 'x' } }] });
      await openRecipe(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await checkPantry(page);
      await axe(page, '.pantry-check', `${scheme} panel with Cook this`);
      await panel(page).getByRole('button', { name: 'Cook this' }).click();
      await expect(dialogOf(page).locator('.cook-line')).toHaveCount(3);
      await axe(page, 'dialog', `${scheme} dialog before any input`);
      await confirm(page).click();
      await expect(line(page, 'Whole milk').getByRole('alert')).toBeVisible();
      await axe(page, 'dialog', `${scheme} dialog with a field error`);
      await fillMilk(page, '2000');
      await line(page, 'Eggs').getByRole('checkbox').uncheck();
      await take(page, 'Plain flour', '500 g, Fridge').fill('300');
      await expect(line(page, 'Whole milk').locator('.cook-note')).toBeVisible();
      await axe(page, 'dialog', `${scheme} dialog with a shortfall, an unticked item and a hand-set lot`);
      await dialogOf(page).evaluate(element => { element.scrollTop = 0; });
      await confirm(page).scrollIntoViewIfNeeded();
      await confirm(page).click();
      await expect(dialogOf(page).getByRole('alert')).toContainText('We could not record that right now.');
      await axe(page, 'dialog', `${scheme} dialog with a server error`);
      await confirm(page).click();
      await expect(dialogOf(page).getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
      await axe(page, 'dialog', `${scheme} done`);
    });
  }
});

/* ------------------------------------------------------------------ Cooking history on the Inventory page */

test.describe('Cooking history', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const section = (page: Page) => page.getByRole('region', { name: 'Cooking history' });
  const list = (page: Page) => section(page).getByRole('list', { name: 'Cooking history' });
  const row = (page: Page, text: string | RegExp) => list(page).getByRole('listitem').filter({ hasText: text });

  test('loads only when asked, lists what each cooking took, and pages with Load more', async ({ page }) => {
    const api = await mock(page, { entries: history(), older: olderHistory() });
    await page.goto('/#inventory');
    await expect(section(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(api.ofPath('/api/inventory/consumptions', 'GET')).toHaveLength(0);
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(3);
    const requests = api.ofPath('/api/inventory/consumptions', 'GET');
    expect(requests).toHaveLength(1);
    expect(requests[0].search).toBe('?limit=20');
    const first = row(page, /^Sunday pancakes/).first();
    await expect(first).toContainText('4 servings');
    await expect(first).toContainText('Alex');
    await expect(first).toContainText('Taken: Plain flour 300 g, Eggs 2 eggs');
    await expect(first).toContainText('Used beyond what was recorded (stock unchanged): Whole milk 1 L');
    await expect(first.getByRole('button', { name: /^Undo Sunday pancakes/ })).toBeVisible();
    await expect(row(page, /^Undo of Sunday pancakes/)).toContainText('Put back: Eggs 3 eggs');
    await expect(row(page, /^Undo of Sunday pancakes/)).toContainText('Sam');
    await expect(row(page, /^Undo of Sunday pancakes/).getByRole('button')).toHaveCount(0);
    const undone = list(page).getByRole('listitem').nth(2);
    await expect(undone).toContainText('Undone');
    await expect(undone.getByRole('button')).toHaveCount(0);
    await expect(list(page).getByRole('button')).toHaveCount(1);
    await section(page).getByRole('button', { name: 'Load more' }).click();
    await expect(row(page, 'Weeknight omelette')).toContainText('1 serving');
    await expect(row(page, 'Weeknight omelette').getByRole('button')).toHaveCount(0);
    await expect(list(page).getByRole('listitem')).toHaveCount(4);
    expect(api.ofPath('/api/inventory/consumptions', 'GET')[1].search).toBe('?limit=20&before=3');
    await expect(section(page).getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test('names come with each entry, so an item that has left the list still reads properly', async ({ page }) => {
    const gone = entry({ txnId: 'cook-gone-ffffffff', recipeTitle: 'Porridge', lots: [{ lotId: 'lot-oats', itemId: 'item-oats', itemName: 'Rolled oats', dim: 'mass', delta: -80 * G }], shortfalls: [{ itemId: 'item-honey', itemName: 'Honey', dim: 'volume', amount: 15 * ML }] });
    await mock(page, { entries: [gone] });
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await expect(row(page, /^Porridge/)).toContainText('Taken: Rolled oats 80 g');
    await expect(row(page, /^Porridge/)).toContainText('Honey 15 mL');
    await expect(section(page)).not.toContainText(/no longer on your list|some$/);
  });

  test('an empty history says what to do', async ({ page }) => {
    await mock(page);
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await expect(section(page)).toContainText('Nothing cooked yet.');
  });

  test('undo asks first, says what it puts back, sends one request, then refreshes the list and the stock', async ({ page }) => {
    const api = await mock(page, { entries: history(), older: olderHistory() });
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await row(page, /^Sunday pancakes/).first().getByRole('button', { name: /^Undo Sunday pancakes/ }).click();
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Undo Sunday pancakes?' })).toBeVisible();
    await expect(dialog).toContainText('Puts back exactly what was taken. If anything about these lots changed since, undo is refused and you can recount instead.');
    const putBack = dialog.getByRole('list', { name: 'This will put back:' });
    await expect(putBack.getByRole('listitem')).toHaveCount(2);
    await expect(putBack.getByRole('listitem').filter({ hasText: 'Plain flour' })).toContainText('300 g');
    await expect(putBack.getByRole('listitem').filter({ hasText: 'Eggs' })).toContainText('2 eggs');
    await expect(dialog).toContainText('never changed your stock, so nothing is added for them');
    expect(api.calls.filter(call => /undo$/.test(call.path))).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.calls.filter(call => /undo$/.test(call.path))).toHaveLength(0);
    const stateReads = api.ofPath('/api/inventory', 'GET').length;
    await row(page, /^Sunday pancakes/).first().getByRole('button', { name: /^Undo Sunday pancakes/ }).click();
    await dialog.getByRole('button', { name: 'Yes, put it back' }).dblclick();
    await expect(dialog).toHaveCount(0);
    const undo = api.calls.filter(call => /undo$/.test(call.path));
    expect(undo).toHaveLength(1);
    expect(undo[0].path).toBe(`/api/inventory/txns/${COOK_1}/undo`);
    expect(Object.keys(undo[0].body!)).toEqual(['txnId']);
    await expect(page.getByRole('status').filter({ hasText: 'Put back what was used for Sunday pancakes.' })).toBeVisible();
    expect(api.ofPath('/api/inventory', 'GET').length).toBeGreaterThan(stateReads);
    await expect(row(page, /^Undo of Sunday pancakes/).first()).toContainText('Put back: Plain flour 300 g, Eggs 2 eggs');
    await expect(list(page).getByRole('button')).toHaveCount(0);
    await expect(row(page, /^Sunday pancakes/).first()).toContainText('Undone');
    await expect(section(page).getByRole('heading', { name: 'Cooking history' })).toBeFocused();
  });

  test('a refused undo shows the server’s reason, refreshes the list and offers no second try', async ({ page }) => {
    const api = await mock(page, { entries: history(), undo: [{ status: 409, json: { error: 'A lot changed since this was cooked.' } }] });
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await row(page, /^Sunday pancakes/).first().getByRole('button', { name: /^Undo Sunday pancakes/ }).click();
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Yes, put it back' }).click();
    await expect(dialog.getByRole('alert')).toContainText('A lot changed since this was cooked.');
    await expect(dialog.getByRole('alert')).toContainText('Nothing was changed. If the shelf looks different now, recount the lot in Inventory instead.');
    await expect(dialog.getByRole('button', { name: 'Yes, put it back' })).toHaveCount(0);
    await expect.poll(() => api.ofPath('/api/inventory/consumptions', 'GET').length).toBe(2);
    await expect(dialog.getByRole('button', { name: 'Close' }).last()).toBeFocused();
    await expect(row(page, /^Sunday pancakes/).first()).toContainText('Can’t be undone: stock has changed since.');
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(list(page).getByRole('button')).toHaveCount(0);
  });

  test('says why an entry can no longer be undone, and says “about” for amounts from estimated lots', async ({ page }) => {
    const inventory = stock();
    inventory.lots = [{ id: 'lot-flour-b', itemId: 'item-flour', locationId: null, qty: 400 * G, precision: 'estimated', estBp: 2500, enteredText: '500 g', dateKind: null, date: null, note: '', version: 2, createdAt: 1, updatedAt: 1 }];
    await mock(page, { entries: history(), older: olderHistory(), inventory });
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await expect(row(page, /^Sunday pancakes/).first()).toContainText('Taken: Plain flour about 300 g, Eggs 2 eggs');
    await expect(row(page, /^Sunday pancakes/).first()).not.toContainText('Can’t be undone');
    await section(page).getByRole('button', { name: 'Load more' }).click();
    await expect(row(page, 'Weeknight omelette')).toContainText('Can’t be undone: stock has changed since.');
    // Undone entries and undo entries need no such note.
    await expect(row(page, /^Undo of Sunday pancakes/)).not.toContainText('Can’t be undone');
    await expect(list(page).getByRole('listitem').nth(2)).not.toContainText('Can’t be undone');
  });

  test('keeps nothing from the history in browser storage', async ({ page }) => {
    await mock(page, { entries: history() });
    await page.goto('/#inventory');
    await section(page).getByRole('button', { name: 'Show cooking history' }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(3);
    const stored = await page.evaluate(async () => ({
      web: Object.entries(localStorage).concat(Object.entries(sessionStorage)).map(([key, value]) => `${key}=${value}`).join('\n'),
      databases: (await indexedDB.databases()).map(database => database.name),
      caches: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    }));
    expect(stored.web).not.toMatch(/Sunday pancakes|consumptions|cook-one/i);
    expect(stored.databases).toEqual([]);
    expect(stored.caches.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
  });

  for (const width of [390, 320]) {
    test(`fits a ${width}px phone, the undo dialog included`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const long = history();
      long[0].recipeTitle = 'A very long recipe title that has to wrap neatly on a small phone without any sideways scrolling';
      await mock(page, { entries: long, older: olderHistory() });
      await page.goto('/#inventory');
      await section(page).getByRole('button', { name: 'Show cooking history' }).click();
      await section(page).getByRole('button', { name: 'Load more' }).click();
      await expect(list(page).getByRole('listitem')).toHaveCount(4);
      expect(await noOverflow(page)).toBe(true);
      expect(await tooSmall(section(page))).toEqual([]);
      await list(page).getByRole('button', { name: /^Undo A very long/ }).click();
      const dialog = dialogOf(page);
      expect(await noOverflow(page)).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await tooSmall(dialog)).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no accessibility violations at 390px in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await mock(page, { entries: history(), older: olderHistory(), undo: [{ status: 409, json: { error: 'A lot changed since this was cooked.' } }] });
      await page.goto('/#inventory');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await axe(page, '.inventory-cooking', `${scheme} history before loading`);
      await section(page).getByRole('button', { name: 'Show cooking history' }).click();
      await section(page).getByRole('button', { name: 'Load more' }).click();
      await expect(list(page).getByRole('listitem')).toHaveCount(4);
      await axe(page, '.inventory-cooking', `${scheme} history`);
      await section(page).scrollIntoViewIfNeeded();
      await list(page).getByRole('button', { name: /^Undo Sunday pancakes/ }).click();
      await axe(page, 'dialog', `${scheme} undo dialog`);
      await dialogOf(page).getByRole('button', { name: 'Yes, put it back' }).click();
      await expect(dialogOf(page).getByRole('alert')).toBeVisible();
      await axe(page, 'dialog', `${scheme} undo dialog refused`);
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
  for (const lot of state.lots) expect((await request.post(`/api/inventory/lots/${lot.id}/archive`, { headers, data: { txnId: `cleanup-${crypto.randomUUID()}`, version: lot.version, reason: 'Test cleanup' } })).ok()).toBe(true);
  for (const item of state.items) expect((await request.post(`/api/inventory/items/${item.id}/archive`, { headers, data: { version: item.version } })).ok()).toBe(true);
  const boot = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  for (const found of boot.records.filter(r => created.recordIds.includes(r.id))) await request.delete(`/api/records/${found.id}`, { headers, data: { version: found.version } });
  await setModule(request, false);
}
async function seedItem(request: APIRequestContext, name: string, dim: string) {
  const made = await request.post('/api/inventory/items', { headers, data: { name, dim } });
  expect(made.status()).toBe(201);
  const body = await made.json() as { id: string };
  expect((await request.post('/api/inventory/aliases', { headers, data: { name: name.toLowerCase(), itemId: body.id } })).status()).toBe(201);
  return body.id;
}
async function seedLot(request: APIRequestContext, itemId: string, amount: string, unitName: string, extra: Record<string, unknown> = {}) {
  const made = await request.post('/api/inventory/lots', { headers, data: { txnId: `seed-${crypto.randomUUID()}`, itemId, locationId: null, amount, unit: unitName, precision: 'exact', note: '', ...extra } });
  expect(made.status()).toBe(201);
  return ((await made.json()) as { lots: { id: string }[] }).lots[0].id;
}
async function seedRecipe(request: APIRequestContext, created: { recordIds: string[] }, title: string, ingredients: Recipe['ingredients']) {
  const made = await request.post('/api/records', { headers, data: { kind: 'recipe', data: { ...recipe, title, servings: 2, ingredients } } });
  expect(made.status()).toBe(201);
  const body = await made.json() as { id: string };
  created.recordIds.push(body.id);
  return body.id;
}
const quantities = async (request: APIRequestContext) => Object.fromEntries(((await (await request.get('/api/inventory')).json()) as InventoryState).lots.map(lot => [lot.id, lot.qty]));

real.describe('Cooking on the real Worker and local D1', () => {
  real.setTimeout(120000);
  const created = { recordIds: [] as string[] };
  real.beforeEach(async ({ request }) => { created.recordIds = []; await setModule(request, true); });
  real.afterEach(async ({ request }) => { await resetReal(request, created); });

  real('cooks a recipe end to end: stock drops, history shows it, undo restores the exact quantities and is offered once', async ({ page, request }) => {
    const flour = await seedItem(request, 'Cooking flour', 'mass');
    const eggs = await seedItem(request, 'Cooking eggs', 'count:egg');
    const early = await seedLot(request, flour, '200', 'g', { dateKind: 'best_by', date: '2099-12-01' });
    const late = await seedLot(request, flour, '500', 'g', { dateKind: 'best_by', date: '2099-12-31' });
    const dozen = await seedLot(request, eggs, '6', 'eggs');
    await seedRecipe(request, created, LOAF, [{ name: 'cooking flour', quantity: 300, unit: 'g' }, { name: 'cooking eggs', quantity: 2, unit: '' }]);
    const before = await quantities(request);
    expect(before).toEqual({ [early]: 200 * G, [late]: 500 * G, [dozen]: 6 });

    await page.goto('/#recipes');
    await page.getByRole('button', { name: `View ${LOAF}`, exact: true }).click();
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    const dialog = dialogOf(page);
    await expect(used(page, 'Cooking flour')).toHaveValue('300');
    await expect(used(page, 'Cooking eggs')).toHaveValue('2');
    await expect(take(page, 'Cooking flour', '200 g, No set place')).toHaveValue('200');
    await expect(take(page, 'Cooking flour', '500 g, No set place')).toHaveValue('100');
    await confirm(page).click();
    await expect(dialog.getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(panel(page).getByRole('heading', { name: 'This check is out of date' })).toBeVisible();
    expect(await quantities(request)).toEqual({ [early]: 0, [late]: 400 * G, [dozen]: 4 });

    // The Inventory page shows the new totals and the cooking.
    await page.goto('/#inventory');
    await expect(page.getByText('400 g in total')).toBeVisible();
    const section = page.getByRole('region', { name: 'Cooking history' });
    await section.getByRole('button', { name: 'Show cooking history' }).click();
    const cooked = section.getByRole('list', { name: 'Cooking history' }).getByRole('listitem').filter({ hasText: LOAF });
    await expect(cooked).toHaveCount(1);
    await expect(cooked).toContainText('Alex');
    await expect(cooked).toContainText('Cooking flour 300 g');
    await expect(cooked).toContainText('Cooking eggs 2 eggs');
    await cooked.getByRole('button', { name: new RegExp(`^Undo ${LOAF}`) }).click();
    await dialog.getByRole('button', { name: 'Yes, put it back' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('700 g in total')).toBeVisible();
    expect(await quantities(request)).toEqual(before);

    // Undone: the original says so, the reversal is listed, and neither offers undo again.
    const entries = section.getByRole('list', { name: 'Cooking history' }).getByRole('listitem').filter({ hasText: LOAF });
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: new RegExp(`^Undo of ${LOAF}`) })).toContainText('Put back:');
    await expect(entries.filter({ hasText: new RegExp(`^Undo of ${LOAF}`) })).toContainText('Cooking flour 300 g');
    await expect(entries.filter({ hasText: new RegExp(`^Undo of ${LOAF}`) })).toContainText('Cooking eggs 2 eggs');
    await expect(entries.filter({ hasText: 'Undone' })).toHaveCount(1);
    await expect(entries.getByRole('button')).toHaveCount(0);
    const target = ((await (await request.get('/api/inventory/consumptions')).json()) as { entries: InvConsumption[] }).entries.find(row => row.recipeTitle === LOAF && row.reverses === null)!;
    expect(target.undoneBy).not.toBeNull();
    expect(target.canUndo).toBe(false);
    expect((await request.post(`/api/inventory/txns/${target.txnId}/undo`, { headers, data: { txnId: `again-${crypto.randomUUID()}` } })).status()).toBe(409);
    expect(await quantities(request)).toEqual(before);
  });

  real('a lot that changes after the preview is refused with a message and no stock moves; confirming again then works', async ({ page, request }) => {
    const flour = await seedItem(request, 'Stale flour', 'mass');
    const lot = await seedLot(request, flour, '500', 'g');
    await seedRecipe(request, created, STALE_LOAF, [{ name: 'stale flour', quantity: 300, unit: 'g' }]);
    await page.goto('/#recipes');
    await page.getByRole('button', { name: `View ${STALE_LOAF}`, exact: true }).click();
    await checkPantry(page);
    await panel(page).getByRole('button', { name: 'Cook this' }).click();
    const dialog = dialogOf(page);
    await expect(used(page, 'Stale flour')).toHaveValue('300');
    await expect(line(page, 'Stale flour').locator('.cook-lot')).toHaveCount(1);

    // Someone else adds a little to the same lot while the dialog is open.
    const current = (await (await request.get('/api/inventory')).json() as InventoryState).lots.find(row => row.id === lot)!;
    expect((await request.post(`/api/inventory/lots/${lot}/adjust`, { headers, data: { txnId: `bump-${crypto.randomUUID()}`, version: current.version, mode: 'add', amount: '1', unit: 'g', reason: '' } })).ok()).toBe(true);

    await confirm(page).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/changed|less in stock|refresh/i);
    await expect(alert).toContainText('Your amounts are still here');
    expect(await quantities(request)).toEqual({ [lot]: 501 * G });
    const none = ((await (await request.get('/api/inventory/consumptions')).json()) as { entries: InvConsumption[] }).entries.filter(row => row.recipeTitle === STALE_LOAF);
    expect(none).toEqual([]);

    // The dialog looked again: the lot is flagged as changed, the cook's amount is still there, and confirming now succeeds.
    await expect(line(page, 'Stale flour').locator('.cook-lot').first()).toContainText('Changed just now');
    await expect(line(page, 'Stale flour').locator('.cook-lot').first()).toContainText('501 g available');
    await expect(used(page, 'Stale flour')).toHaveValue('300');
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect(dialog.getByRole('heading', { name: 'Done. Your stock is updated' })).toBeVisible();
    expect(await quantities(request)).toEqual({ [lot]: 201 * G });
  });
});
