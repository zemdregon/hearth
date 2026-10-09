import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './fixtures/api-harness';
import { checkRecipe, exactRational, ingredientKey } from '../src/shared/inventory';
import type { AvailabilityResult, InvAlias, InvCalibration, InvItem, InvLot, InvLotResult, InvSettings, InventoryExport, InventoryState } from '../src/shared/inventory';
import type { FamilyRecord, Recipe } from '../src/shared/types';

describe('exactRational', () => {
  it('recovers simple fractions instead of comparing with rounded decimals', () => {
    expect(exactRational(1 / 3)).toEqual({ n: 1n, d: 3n });
    expect(exactRational(0.375)).toEqual({ n: 3n, d: 8n });
    expect(exactRational(2.5)).toEqual({ n: 5n, d: 2n });
    expect(exactRational(2)).toEqual({ n: 2n, d: 1n });
    expect(exactRational(0)).toEqual({ n: 0n, d: 1n });
  });
  it('rounds unrecognised decimals up and rejects nonsense', () => {
    expect(exactRational(0.123456789)).toEqual({ n: 123457n, d: 1000000n });
    for (const bad of [-1, NaN, Infinity, 100_001]) expect(() => exactRational(bad)).toThrow(RangeError);
  });
  it('keys names case-, width- and space-insensitively', () => {
    expect(ingredientKey('  All-Purpose  Flour ')).toBe(ingredientKey('all-purpose flour'));
    expect(ingredientKey('ＦＬＯＵＲ')).toBe('flour');
  });
});

let h: ReturnType<typeof harness>;
beforeEach(() => { h = harness(); h.sqlite.exec("UPDATE modules SET enabled = 1 WHERE id = 'inventory'"); });
afterEach(() => h.close());

const post = (path: string, body: unknown, user?: string) => h.request(`/api/inventory${path}`, { method: 'POST', body, user });
const state = async () => (await h.request('/api/inventory')).json() as Promise<InventoryState>;
let counter = 0;
const txn = () => `avail-${String(++counter).padStart(6, '0')}`;
async function item(name: string, dim: string): Promise<InvItem> { return (await (await post('/items', { name, dim })).json()) as InvItem; }
async function stock(itemId: string, amount: string, unit: string, extra: Record<string, unknown> = {}): Promise<InvLot> {
  const response = await post('/lots', { txnId: txn(), itemId, locationId: null, amount, unit, precision: 'exact', note: '', ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as InvLotResult).lots[0];
}
async function map(name: string, itemId: string): Promise<InvAlias> {
  const response = await post('/aliases', { name, itemId });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<InvAlias>;
}
async function recipe(ingredients: Recipe['ingredients'], servings = 2): Promise<FamilyRecord<'recipe'>> {
  const data: Recipe = { title: 'Pancakes', description: '', servings, prepMinutes: 5, cookMinutes: 5, ingredients, steps: ['Cook'], tags: [], favorite: false };
  const response = await h.request('/api/records', { method: 'POST', body: { kind: 'recipe', data } });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FamilyRecord<'recipe'>>;
}
const check = async (r: FamilyRecord, servings = 2, exclude: number[] = []) => {
  const response = await post('/availability', { recipeId: r.id, servings, exclude });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<AvailabilityResult>;
};
const setProfile = async (measureProfile: string | null) => {
  const { settings } = await state();
  const response = await h.request('/api/inventory/settings', { method: 'PUT', body: { measureProfile, version: settings.version } });
  expect(response.status).toBe(200);
  return (await response.json()) as InvSettings;
};

describe('availability against a recipe', () => {
  it('reports sufficient, insufficient and unmapped lines and scales servings', async () => {
    const flour = await item('Flour', 'mass');
    const milk = await item('Milk', 'volume');
    await stock(flour.id, '500', 'g');
    await stock(milk.id, '1', 'L');
    await map('Plain flour', flour.id); await map('whole milk', milk.id);
    const r = await recipe([
      { name: 'Plain flour', quantity: 250, unit: 'g' },
      { name: 'Whole milk', quantity: 300, unit: 'ml' },
      { name: 'Vanilla', quantity: 1, unit: 'tsp' },
    ]);
    let result = await check(r, 2);
    expect(result.verdict).toBe('unknown'); // an unmapped line blocks "sufficient"
    expect(result.unmapped).toEqual([{ index: 2, name: 'Vanilla' }]);
    expect(result.items.map(row => [row.itemName, row.verdict])).toEqual([['Flour', 'sufficient'], ['Milk', 'sufficient']]);
    result = await check(r, 2, [2]);
    expect(result).toMatchObject({ verdict: 'sufficient', excluded: [2], unmapped: [] });
    result = await check(r, 6, [2]); // ×3: 750 g flour vs 500 g
    expect(result.verdict).toBe('insufficient');
    const short = result.items.find(row => row.itemName === 'Flour')!;
    expect(short).toMatchObject({ verdict: 'insufficient', needComplete: true, haveComplete: true });
    expect(short.need).toEqual({ lo: 750_000_000_000, hi: 750_000_000_000 });
    expect(short.short).toEqual({ lo: 250_000_000_000, hi: 250_000_000_000 });
  });
  it('treats exactly enough as sufficient, including US cups of an exact-rounded lot', async () => {
    const milk = await item('Milk', 'volume');
    await stock(milk.id, '2', 'tsp', { profile: 'us-customary' }); // 9,857,843.1875 nL stored rounded UP
    await map('milk', milk.id);
    await setProfile('us-customary');
    const r = await recipe([{ name: 'Milk', quantity: 2, unit: 'tsp' }], 1);
    expect((await check(r, 1)).verdict).toBe('sufficient');
    expect((await check(r, 2)).verdict).toBe('insufficient');
  });
  it('never calls an unclear measurement enough', async () => {
    const flour = await item('Flour', 'mass');
    const milk = await item('Milk', 'volume');
    await stock(flour.id, '1', 'kg'); await stock(milk.id, '1', 'L');
    await map('flour', flour.id); await map('milk', milk.id);
    const reasons = async (ingredients: Recipe['ingredients']) => {
      const result = await check(await recipe(ingredients, 1), 1);
      return { verdict: result.verdict, reasons: result.items.flatMap(row => row.reasons) };
    };
    expect(await reasons([{ name: 'milk', quantity: 1, unit: 'cup' }])).toEqual({ verdict: 'unknown', reasons: ['MEASURE_PROFILE_AMBIGUOUS'] }); // no household convention yet
    // A bare “oz” on an item the cook tracks by weight is a weight ounce (and says so); on a
    // volume-tracked item it stays ambiguous and unknown.
    expect(await reasons([{ name: 'flour', quantity: 2, unit: 'oz' }])).toEqual({ verdict: 'sufficient', reasons: ['OZ_ASSUMED_WEIGHT'] });
    expect(await reasons([{ name: 'flour', quantity: 100, unit: 'ounces' }])).toEqual({ verdict: 'insufficient', reasons: ['OZ_ASSUMED_WEIGHT'] }); // 2.8 kg of 1 kg
    expect(await reasons([{ name: 'milk', quantity: 1, unit: 'oz' }])).toEqual({ verdict: 'unknown', reasons: ['AMBIGUOUS_OUNCE'] });
    expect((await reasons([{ name: 'flour', quantity: 1, unit: 'cup' }])).reasons).toContain('MEASURE_PROFILE_AMBIGUOUS');
    await setProfile('us-label');
    expect(await reasons([{ name: 'flour', quantity: 1, unit: 'cup' }])).toEqual({ verdict: 'unknown', reasons: ['DIM_MISMATCH_NO_CONVERSION'] });
    expect((await reasons([{ name: 'flour', quantity: null, unit: '' }])).reasons).toEqual(['UNQUANTIFIED']);
    expect((await reasons([{ name: 'flour', quantity: 2, unit: 'handful' }])).reasons).toEqual(['UNKNOWN_UNIT']);
  });
  it('lets a proven shortage win over an unknown line', async () => {
    const flour = await item('Flour', 'mass'); const sugar = await item('Sugar', 'mass');
    await stock(flour.id, '100', 'g'); await stock(sugar.id, '1', 'kg');
    await map('flour', flour.id); await map('sugar', sugar.id);
    const result = await check(await recipe([{ name: 'flour', quantity: 500, unit: 'g' }, { name: 'sugar', quantity: 1, unit: 'handful' }], 1), 1);
    expect(result.verdict).toBe('insufficient');
    expect(result.items.find(row => row.itemName === 'Sugar')).toMatchObject({ verdict: 'unknown', needComplete: false });
  });
  it('widens estimated stock and range demand into unknown', async () => {
    const rice = await item('Rice', 'mass');
    await stock(rice.id, '500', 'g', { precision: 'estimated', estBp: 2000 }); // 400–600 g
    await map('rice', rice.id);
    expect(await check(await recipe([{ name: 'rice', quantity: 350, unit: 'g' }], 1), 1)).toMatchObject({ verdict: 'sufficient' });
    const overlap = await check(await recipe([{ name: 'rice', quantity: 450, unit: 'g' }], 1), 1);
    expect(overlap.verdict).toBe('unknown');
    expect(overlap.items[0].reasons).toEqual(expect.arrayContaining(['ESTIMATED_STOCK', 'INTERVAL_OVERLAP']));
    expect((await check(await recipe([{ name: 'rice', quantity: 700, unit: 'g' }], 1), 1)).verdict).toBe('insufficient');
    expect((await check(await recipe([{ name: 'rice', quantity: 300, quantityMax: 450, unit: 'g' }], 1), 1)).items[0].reasons).toContain('RANGE_DEMAND');
  });
  it('treats a bare count as the item\'s own count unit and aggregates repeated lines', async () => {
    const eggs = await item('Eggs', 'count:egg');
    await stock(eggs.id, '6', 'eggs'); await map('eggs', eggs.id); await map('egg', eggs.id);
    const r = await recipe([{ name: 'Eggs', quantity: 2, unit: '' }, { name: 'egg', quantity: 1, unit: 'egg', note: 'to glaze' }], 1);
    const result = await check(r, 2); // (2 + 1) × 2 = 6 of 6
    expect(result).toMatchObject({ verdict: 'sufficient' });
    expect(result.items[0]).toMatchObject({ lineIndexes: [0, 1], need: { lo: 6, hi: 6 }, have: { lo: 6, hi: 6 } });
    expect((await check(r, 3)).verdict).toBe('insufficient');
  });
  it('ignores archived stock and unrelated lots', async () => {
    const flour = await item('Flour', 'mass'); const rice = await item('Rice', 'mass');
    const lot = await stock(flour.id, '1', 'kg'); await stock(rice.id, '9', 'kg');
    await map('flour', flour.id);
    await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: lot.version, reason: '' });
    const result = await check(await recipe([{ name: 'flour', quantity: 100, unit: 'g' }], 1), 1);
    expect(result.items[0]).toMatchObject({ verdict: 'insufficient', have: { lo: 0, hi: 0 } });
  });
});

describe('expiry', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  it('excludes stock past its use-by date, keeps best-by stock, and says so', async () => {
    const milk = await item('Milk', 'volume');
    await stock(milk.id, '500', 'ml', { dateKind: 'use_by', date: day(-1) });
    await stock(milk.id, '300', 'ml', { dateKind: 'best_by', date: day(-30) });
    await stock(milk.id, '200', 'ml', { dateKind: 'use_by', date: day(0) }); // last day still counts
    await map('milk', milk.id);
    const r = await recipe([{ name: 'milk', quantity: 400, unit: 'ml' }], 1);
    const result = await check(r, 1);
    expect(result.items[0]).toMatchObject({ verdict: 'sufficient', have: { lo: 500_000_000, hi: 500_000_000 } });
    expect(result.items[0].reasons).toContain('EXPIRED_STOCK_EXCLUDED');
    expect((await check(r, 2)).verdict).toBe('insufficient'); // 800 ml of 500 ml, not 1 L
  });
});

describe('conversions between measurement kinds', () => {
  it('uses one accepted calibration to bridge volume to weight', async () => {
    const flour = await item('Flour', 'mass');
    await stock(flour.id, '300', 'g'); await map('flour', flour.id);
    const r = await recipe([{ name: 'flour', quantity: 2, unit: 'cup' }], 1);
    await setProfile('us-label');
    expect((await check(r, 1)).items[0].reasons).toEqual(['DIM_MISMATCH_NO_CONVERSION']);
    const response = await post('/calibrations', { itemId: flour.id, fromAmount: '1', fromUnit: 'cup', fromProfile: 'us-label', toAmount: '120', toUnit: 'g' });
    expect(response.status, await response.clone().text()).toBe(201);
    const calibration = (await response.json()) as InvCalibration;
    const result = await check(r, 1); // 2 cups × 120 g = 240 g of 300 g
    expect(result).toMatchObject({ verdict: 'sufficient' });
    expect(result.items[0].reasons).toEqual(['ACCEPTED_CALIBRATION']);
    expect((await check(r, 2)).verdict).toBe('insufficient'); // 480 g
    expect((await post(`/calibrations/${calibration.id}/archive`, { version: 1 })).status).toBe(200);
    expect((await check(r, 1)).verdict).toBe('unknown');
  });
  it('validates both sides and allows only one conversion per item and pair', async () => {
    const flour = await item('Flour', 'mass'); const eggs = await item('Eggs', 'count:egg');
    const base = { itemId: flour.id, fromAmount: '1', fromUnit: 'cup', fromProfile: 'us-label', toAmount: '120', toUnit: 'g' };
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ fromUnit: 'kg', fromProfile: undefined }, /different kinds/],
      [{ fromUnit: 'cup', fromProfile: undefined }, /convention/],
      [{ fromUnit: 'bushel' }, /not recognised/],
      [{ fromAmount: '0' }, /above zero/],
      [{ toAmount: '1-2' }, /one exact amount/],
      [{ toAmount: '1', toUnit: 'egg' }, /stored/],
      [{ itemId: 'missing' }, /no longer exists/],
    ];
    for (const [change, message] of bad) {
      const response = await post('/calibrations', { ...base, ...change });
      expect([400, 404], JSON.stringify(change)).toContain(response.status);
      expect(((await response.json()) as { error: string }).error, JSON.stringify(change)).toMatch(message);
    }
    expect((await post('/calibrations', base)).status).toBe(201);
    const duplicate = await post('/calibrations', { ...base, fromAmount: '2', toAmount: '240' });
    expect(duplicate.status).toBe(409);
    expect((await post('/calibrations', { itemId: eggs.id, fromAmount: '1', fromUnit: 'egg', toAmount: '50', toUnit: 'g' })).status).toBe(201);
  });
  it('blocks archiving an item that still has mappings or conversions, naming the real reason', async () => {
    const flour = await item('Flour', 'mass');
    const alias = await map('flour', flour.id);
    const blocked = await post(`/items/${flour.id}/archive`, { version: 1 });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/recipe matches or conversions/);
    await post(`/aliases/${alias.id}/archive`, { version: 1 });
    expect((await post(`/items/${flour.id}/archive`, { version: 1 })).status).toBe(200);
    expect((await post('/aliases', { name: 'again', itemId: flour.id })).status).toBe(404);
  });
});

describe('mappings, settings and access', () => {
  it('keeps one active mapping per name and frees it when archived', async () => {
    const flour = await item('Flour', 'mass'); const spelt = await item('Spelt', 'mass');
    const alias = await map('Plain  Flour', flour.id);
    expect((await post('/aliases', { name: 'plain flour', itemId: spelt.id })).status).toBe(409);
    expect((await post(`/aliases/${alias.id}/archive`, { version: 9 })).status).toBe(409);
    expect((await post(`/aliases/${alias.id}/archive`, { version: 1 })).status).toBe(200);
    expect((await post('/aliases', { name: 'plain flour', itemId: spelt.id })).status).toBe(201);
    for (const name of ['', 'a\u0000b', 'x'.repeat(201)]) expect((await post('/aliases', { name, itemId: spelt.id })).status).toBe(400);
  });
  it('lets only an administrator change the convention, with an optimistic version', async () => {
    const stale = await h.request('/api/inventory/settings', { method: 'PUT', body: { measureProfile: 'metric-250', version: 9 } });
    expect(stale.status).toBe(409);
    expect((await h.request('/api/inventory/settings', { method: 'PUT', body: { measureProfile: 'metric-250', version: 1 }, user: 'sam' })).status).toBe(403);
    expect(await setProfile('metric-250')).toEqual({ measureProfile: 'metric-250', version: 2 });
    expect((await h.request('/api/inventory/settings', { method: 'PUT', body: { measureProfile: 'martian', version: 2 } })).status).toBe(400);
    expect((await state()).settings).toEqual({ measureProfile: 'metric-250', version: 2 });
    expect(await setProfile(null)).toEqual({ measureProfile: null, version: 3 });
  });
  it('validates the request, the recipe and the module state', async () => {
    const flour = await item('Flour', 'mass'); await map('flour', flour.id);
    const r = await recipe([{ name: 'flour', quantity: 1, unit: 'g' }], 1);
    for (const body of [{ recipeId: r.id, servings: 0, exclude: [] }, { recipeId: r.id, servings: 1001, exclude: [] }, { recipeId: r.id, servings: 1.5, exclude: [] }, { recipeId: r.id, servings: 1 }, { recipeId: r.id, servings: 1, exclude: [-1] }, { recipeId: r.id, servings: 1, exclude: [], text: 'x' }]) {
      expect((await post('/availability', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post('/availability', { recipeId: r.id, servings: 1, exclude: [5] })).status).toBe(400);
    expect((await post('/availability', { recipeId: 'missing', servings: 1, exclude: [] })).status).toBe(404);
    const task = await h.request('/api/records', { method: 'POST', body: { kind: 'task', data: { title: 'x', done: false } } });
    expect((await post('/availability', { recipeId: ((await task.json()) as { id: string }).id, servings: 1, exclude: [] })).status).toBe(404);
    h.sqlite.exec("INSERT INTO modules (id, enabled) VALUES ('recipes', 0)");
    expect((await post('/availability', { recipeId: r.id, servings: 1, exclude: [] })).status).toBe(403);
    h.sqlite.exec("DELETE FROM modules WHERE id = 'recipes'; UPDATE modules SET enabled = 0 WHERE id = 'inventory'");
    expect((await post('/availability', { recipeId: r.id, servings: 1, exclude: [] })).status).toBe(403);
    expect((await h.request('/api/inventory/settings', { method: 'PUT', body: { measureProfile: null, version: 1 } })).status).toBe(403);
  });
  it('is included in the export and the inventory read', async () => {
    const flour = await item('Flour', 'mass'); await map('flour', flour.id);
    const exported = await (await h.request('/api/export')).json() as { inventory: InventoryExport };
    expect(exported.inventory.aliases).toHaveLength(1);
    expect(exported.inventory.cookings).toEqual([]);
    expect(exported.inventory.settings).toEqual({ measureProfile: null, version: 1 });
  });
});

describe('checkRecipe bounds', () => {
  it('turns oversize inputs into RangeError, never a verdict', () => {
    const items: InvItem[] = [{ id: 'i', name: 'Flour', dim: 'mass', version: 1 }];
    const lots: InvLot[] = Array.from({ length: 1001 }, (_, index) => ({ id: `l${index}`, itemId: 'i', locationId: null, qty: 1, precision: 'exact', estBp: 0, enteredText: '1 g', dateKind: null, date: null, note: '', version: 1, createdAt: 0, updatedAt: 0 }));
    expect(() => checkRecipe({ recipe: { servings: 1, ingredients: [{ name: 'flour', quantity: 1, unit: 'g' }] }, servings: 1, exclude: [], names: new Map([['flour', 'i']]), items, lots, calibrations: [], profile: null, today: '2026-10-09' })).toThrow(RangeError);
  });
});
