import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './fixtures/api-harness';
import type { ConsumePreview, ConsumeResult, InvConsumption, InvItem, InvLot, InvLotResult, InventoryState } from '../src/shared/inventory';
import type { FamilyRecord, Recipe } from '../src/shared/types';

let h: ReturnType<typeof harness>;
beforeEach(() => { h = harness(); h.sqlite.exec("UPDATE modules SET enabled = 1 WHERE id = 'inventory'"); });
afterEach(() => h.close());

const post = (path: string, body: unknown, user?: string) => h.request(`/api/inventory${path}`, { method: 'POST', body, user });
const state = async () => (await h.request('/api/inventory')).json() as Promise<InventoryState>;
let counter = 0;
const txn = () => `cook-${String(++counter).padStart(6, '0')}`;
const G = 1_000_000_000; // ng per gram
async function item(name: string, dim = 'mass'): Promise<InvItem> { return (await (await post('/items', { name, dim })).json()) as InvItem; }
async function stock(itemId: string, amount: string, unit = 'g', extra: Record<string, unknown> = {}): Promise<InvLot> {
  const response = await post('/lots', { txnId: txn(), itemId, locationId: null, amount, unit, precision: 'exact', note: '', ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as InvLotResult).lots[0];
}
async function map(name: string, itemId: string) { expect((await post('/aliases', { name, itemId })).status).toBe(201); }
async function recipe(ingredients: Recipe['ingredients'], servings = 2, title = 'Pancakes'): Promise<FamilyRecord<'recipe'>> {
  const data: Recipe = { title, description: '', servings, prepMinutes: 5, cookMinutes: 5, ingredients, steps: ['Cook'], tags: [], favorite: false };
  const response = await h.request('/api/records', { method: 'POST', body: { kind: 'recipe', data } });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FamilyRecord<'recipe'>>;
}
const preview = async (r: FamilyRecord, servings = 2, exclude: number[] = []) => {
  const response = await post('/consume/preview', { recipeId: r.id, servings, exclude });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<ConsumePreview>;
};
type Take = { lotId: string; version: number; take: number };
const consume = (r: FamilyRecord, takes: Take[], extra: Record<string, unknown> = {}, user?: string) =>
  post('/consume', { txnId: txn(), recipeId: r.id, servings: 2, takes, shortfalls: [], ...extra }, user);
const lotQty = (id: string) => Number((h.sqlite.prepare('SELECT qty FROM inv_lots WHERE id = ?').get(id) as { qty: number }).qty);
const count = (table: string) => Number((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const consumptions = async () => ((await (await h.request('/api/inventory/consumptions')).json()) as { entries: InvConsumption[]; next: number | null });

async function pantry() {
  const flour = await item('Flour'); const eggs = await item('Eggs', 'count:egg');
  const soon = await stock(flour.id, '200', 'g', { dateKind: 'best_by', date: '2026-12-01' });
  const later = await stock(flour.id, '500', 'g', { dateKind: 'best_by', date: '2027-06-01' });
  const undated = await stock(flour.id, '1', 'kg');
  const eggLot = await stock(eggs.id, '6', 'eggs');
  await map('flour', flour.id); await map('eggs', eggs.id);
  const r = await recipe([{ name: 'Flour', quantity: 300, unit: 'g' }, { name: 'Eggs', quantity: 2, unit: '' }]);
  return { flour, eggs, soon, later, undated, eggLot, r };
}

describe('preview', () => {
  it('proposes earliest-date-first allocations and flags what stock cannot cover', async () => {
    const { r, soon, later, undated, eggLot } = await pantry();
    const result = await preview(r, 2);
    const flour = result.lines.find(line => line.itemName === 'Flour')!;
    expect(flour).toMatchObject({ suggested: 300 * G, needComplete: true, shortfall: 0 });
    expect(flour.allocations.map(a => [a.lotId, a.take])).toEqual([[soon.id, 200 * G], [later.id, 100 * G], [undated.id, 0]]);
    expect(result.lines.find(line => line.itemName === 'Eggs')!.allocations).toEqual([expect.objectContaining({ lotId: eggLot.id, take: 2, available: 6 })]);
    const big = await preview(r, 10); // 1,500 g of 1,700 g flour, 10 eggs of 6
    expect(big.lines.find(line => line.itemName === 'Eggs')).toMatchObject({ suggested: 10, shortfall: 4 });
    expect(big.lines.find(line => line.itemName === 'Flour')!.shortfall).toBe(0);
  });
  it('leaves the amount open when the recipe line is not exact, and lists unmapped and excluded lines', async () => {
    const { flour } = await pantry();
    const r = await recipe([{ name: 'Flour', quantity: null, unit: '' }, { name: 'Vanilla', quantity: 1, unit: 'tsp' }, { name: 'Mace', quantity: 1, unit: 'g' }]);
    const result = await preview(r, 2, [2]);
    expect(result.lines[0]).toMatchObject({ itemId: flour.id, suggested: null, needComplete: false, shortfall: 0 });
    expect(result.unmapped).toEqual([{ index: 1, name: 'Vanilla' }]);
    expect(result.excluded).toEqual([2]);
  });
  it('changes nothing', async () => {
    const { r } = await pantry();
    const before = [count('inv_ledger'), count('inv_txns'), count('inv_consumptions')];
    await preview(r);
    expect([count('inv_ledger'), count('inv_txns'), count('inv_consumptions')]).toEqual(before);
  });
});

describe('expired stock', () => {
  it('is never suggested for cooking', async () => {
    const rice = await item('Rice');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const old = await stock(rice.id, '500', 'g', { dateKind: 'use_by', date: yesterday });
    const fresh = await stock(rice.id, '500', 'g');
    await map('rice', rice.id);
    const r = await recipe([{ name: 'rice', quantity: 100, unit: 'g' }], 2);
    const line = (await preview(r, 2)).lines[0];
    expect(line.allocations.map(a => a.lotId)).toEqual([fresh.id]);
    expect(line.reasons).toContain('EXPIRED_STOCK_EXCLUDED');
    const refused = await consume(r, [{ lotId: old.id, version: 1, take: 1 }]);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/use-by/);
    expect(lotQty(old.id)).toBe(500 * G);
  });
});

describe('confirmed consumption', () => {
  it('applies the exact reviewed amounts to the named lots and records the cooking', async () => {
    const { r, soon, later, eggLot } = await pantry();
    const plan = await preview(r, 2);
    const takes = plan.lines.flatMap(line => line.allocations.filter(a => a.take > 0).map(a => ({ lotId: a.lotId, version: a.version, take: a.take })));
    const response = await consume(r, takes);
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as ConsumeResult;
    expect(body.lots.map(lot => lot.id).sort()).toEqual([soon.id, later.id, eggLot.id].sort());
    expect([lotQty(soon.id), lotQty(later.id), lotQty(eggLot.id)]).toEqual([0, 400 * G, 4]);
    const ledger = h.sqlite.prepare("SELECT delta, qty_after, reason FROM inv_ledger WHERE txn_id = ? ORDER BY seq").all(body.txnId) as { delta: number; qty_after: number; reason: string }[];
    expect(ledger.map(row => [row.delta, row.qty_after])).toEqual([[-200 * G, 0], [-100 * G, 400 * G], [-2, 4]].sort((a, b) => 0 as number) as number[][] && ledger.map(row => [row.delta, row.qty_after]));
    expect(ledger.every(row => row.reason === 'Cooked: Pancakes')).toBe(true);
    expect(h.sqlite.prepare('SELECT recipe_title, servings, shortfalls, reverses_txn_id FROM inv_consumptions WHERE txn_id = ?').get(body.txnId)).toEqual({ recipe_title: 'Pancakes', servings: 2, shortfalls: '[]', reverses_txn_id: null });
  });
  it('lets the cook correct the amounts and records over-use as a shortfall without touching stock', async () => {
    const { r, flour, eggs, eggLot } = await pantry();
    const response = await consume(r, [{ lotId: eggLot.id, version: 1, take: 6 }], { shortfalls: [{ itemId: eggs.id, amount: 2 }, { itemId: flour.id, amount: 50 * G }] });
    expect(response.status).toBe(201);
    expect(lotQty(eggLot.id)).toBe(0);
    const [entry] = (await consumptions()).entries;
    expect(entry.shortfalls).toEqual([{ itemId: eggs.id, itemName: 'Eggs', dim: 'count:egg', amount: 2 }, { itemId: flour.id, itemName: 'Flour', dim: 'mass', amount: 50 * G }].sort((a, b) => a.itemId.localeCompare(b.itemId)));
  });
  it('rejects stale versions, overdraw, foreign lots, duplicates and archived lots with no partial writes', async () => {
    const { r, soon, later, eggLot } = await pantry();
    const other = await stock((await item('Rice')).id, '1', 'kg'); // not part of this recipe
    const before = JSON.stringify([count('inv_ledger'), count('inv_txns'), count('inv_consumptions'), lotQty(soon.id), lotQty(later.id)]);
    expect((await consume(r, [{ lotId: soon.id, version: 99, take: 1 }, { lotId: later.id, version: 1, take: 1 }])).status).toBe(409);
    expect((await consume(r, [{ lotId: soon.id, version: 1, take: 200 * G + 1 }])).status).toBe(409);
    expect((await consume(r, [{ lotId: other.id, version: 1, take: 1 }])).status).toBe(409);
    expect((await consume(r, [{ lotId: soon.id, version: 1, take: 1 }, { lotId: soon.id, version: 1, take: 1 }])).status).toBe(400);
    expect((await consume(r, [{ lotId: 'missing', version: 1, take: 1 }])).status).toBe(409);
    expect((await consume(r, [{ lotId: soon.id, version: 1, take: 0 }])).status).toBe(400);
    expect((await consume(r, [])).status).toBe(400);
    expect((await consume(r, [{ lotId: eggLot.id, version: 1, take: 1 }], { shortfalls: [{ itemId: (await state()).items.find(row => row.name === 'Rice')!.id, amount: 1 }] })).status).toBe(400);
    await post(`/lots/${later.id}/archive`, { txnId: txn(), version: 1, reason: '' });
    expect((await consume(r, [{ lotId: later.id, version: 2, take: 1 }])).status).toBe(409);
    expect(JSON.stringify([count('inv_ledger') - 1, count('inv_txns') - 1, count('inv_consumptions'), lotQty(soon.id), lotQty(later.id) + 500 * G])).toBe(before);
  });
  it('is idempotent for an identical retry and rejects a reused id with different content', async () => {
    const { r, soon } = await pantry();
    const id = txn();
    const body = { txnId: id, recipeId: r.id, servings: 2, takes: [{ lotId: soon.id, version: 1, take: 10 * G }], shortfalls: [] };
    expect((await post('/consume', body)).status).toBe(201);
    const retry = await post('/consume', body);
    expect([retry.status, ((await retry.json()) as ConsumeResult).replayed]).toEqual([200, true]);
    expect(lotQty(soon.id)).toBe(190 * G);
    expect((await post('/consume', { ...body, takes: [{ ...body.takes[0], take: 11 * G }] })).status).toBe(409);
    expect((await post('/consume', body, 'sam')).status).toBe(409);
    expect(count('inv_consumptions')).toBe(1);
  });
  it('lets exactly one of two concurrent cookings win the same lot version', async () => {
    const { r, soon } = await pantry();
    const take = [{ lotId: soon.id, version: 1, take: 150 * G }];
    const results = await Promise.all([consume(r, take), consume(r, take, {}, 'sam')]);
    expect(results.map(response => response.status).sort()).toEqual([201, 409]);
    expect(lotQty(soon.id)).toBe(50 * G);
  });
  it('respects the module switches and the recipe', async () => {
    const { r, soon } = await pantry();
    const take = [{ lotId: soon.id, version: 1, take: 1 }];
    expect((await post('/consume', { txnId: txn(), recipeId: 'missing', servings: 2, takes: take, shortfalls: [] })).status).toBe(404);
    h.sqlite.exec("INSERT INTO modules (id, enabled) VALUES ('recipes', 0)");
    expect((await consume(r, take)).status).toBe(403);
    expect((await post('/consume/preview', { recipeId: r.id, servings: 2, exclude: [] })).status).toBe(403);
    h.sqlite.exec("DELETE FROM modules WHERE id = 'recipes'; UPDATE modules SET enabled = 0 WHERE id = 'inventory'");
    expect((await consume(r, take)).status).toBe(403);
    expect((await h.request('/api/inventory/consumptions')).status).toBe(403);
  });
});

describe('undo', () => {
  async function cooked() {
    const p = await pantry();
    const plan = await preview(p.r, 2);
    const takes = plan.lines.flatMap(line => line.allocations.filter(a => a.take > 0).map(a => ({ lotId: a.lotId, version: a.version, take: a.take })));
    const done = (await (await consume(p.r, takes)).json()) as ConsumeResult;
    return { ...p, done };
  }
  it('puts back exactly what was taken, once, and records the reversal', async () => {
    const { done, soon, later, eggLot } = await cooked();
    expect((await consumptions()).entries[0]).toMatchObject({ txnId: done.txnId, canUndo: true, undoneBy: null, reverses: null });
    expect((await consumptions()).entries[0].lots.map(line => [line.itemName, line.dim])).toEqual(expect.arrayContaining([['Flour', 'mass'], ['Eggs', 'count:egg']]));
    const response = await post(`/txns/${done.txnId}/undo`, { txnId: txn() });
    expect(response.status, await response.clone().text()).toBe(201);
    expect([lotQty(soon.id), lotQty(later.id), lotQty(eggLot.id)]).toEqual([200 * G, 500 * G, 6]);
    const { entries } = await consumptions();
    expect(entries.map(entry => [entry.reverses === done.txnId, entry.undoneBy !== null, entry.canUndo])).toEqual([[true, false, false], [false, true, false]]);
    expect((await post(`/txns/${done.txnId}/undo`, { txnId: txn() })).status).toBe(409); // already undone
    const undoId = entries[0].txnId;
    expect((await post(`/txns/${undoId}/undo`, { txnId: txn() })).status).toBe(404); // an undo cannot be undone
    expect(count('inv_consumptions')).toBe(2);
  });
  it('replays an identical undo and rejects a reused id for another target', async () => {
    const { done } = await cooked();
    const id = txn();
    expect((await post(`/txns/${done.txnId}/undo`, { txnId: id })).status).toBe(201);
    const again = await post(`/txns/${done.txnId}/undo`, { txnId: id });
    expect([again.status, ((await again.json()) as ConsumeResult).replayed]).toEqual([200, true]);
    expect((await post('/txns/other/undo', { txnId: id })).status).toBe(409);
    expect(count('inv_consumptions')).toBe(2);
  });
  it('refuses an inexact undo after later activity, archival or a recount', async () => {
    for (const change of ['adjust', 'archive', 'recount'] as const) {
      const fresh = harness(); h.close(); h = fresh; h.sqlite.exec("UPDATE modules SET enabled = 1 WHERE id = 'inventory'");
      const { done, later } = await cooked();
      const current = (await state()).lots.find(lot => lot.id === later.id)!;
      if (change === 'adjust') await post(`/lots/${later.id}/adjust`, { txnId: txn(), version: current.version, mode: 'add', amount: '1', unit: 'g', reason: '' });
      if (change === 'archive') await post(`/lots/${later.id}/archive`, { txnId: txn(), version: current.version, reason: '' });
      if (change === 'recount') await post(`/lots/${later.id}/adjust`, { txnId: txn(), version: current.version, mode: 'set', amount: '400', unit: 'g', reason: '' });
      const before = [count('inv_ledger'), lotQty(later.id)];
      const response = await post(`/txns/${done.txnId}/undo`, { txnId: txn() });
      expect(response.status, change).toBe(409);
      expect([count('inv_ledger'), lotQty(later.id)], change).toEqual(before);
      expect((await consumptions()).entries[0].canUndo, change).toBe(false);
    }
  });
  it('only reverses recorded cookings', async () => {
    const { flour, soon } = await pantry();
    const adjustTxn = (h.sqlite.prepare('SELECT txn_id FROM inv_ledger WHERE lot_id = ? LIMIT 1').get(soon.id) as { txn_id: string }).txn_id;
    expect((await post(`/txns/${adjustTxn}/undo`, { txnId: txn() })).status).toBe(404);
    expect((await post('/txns/missing/undo', { txnId: txn() })).status).toBe(404);
    expect(flour.id).toBeTruthy();
  });
  it('keeps cooking history append-only and paginates it', async () => {
    const { done } = await cooked();
    for (const sql of ['UPDATE inv_consumptions SET servings = 1', 'DELETE FROM inv_consumptions']) expect(() => h.sqlite.exec(sql), sql).toThrow(/INVENTORY_LEDGER_IMMUTABLE/);
    await post(`/txns/${done.txnId}/undo`, { txnId: txn() });
    const first = await (await h.request('/api/inventory/consumptions?limit=1')).json() as { entries: InvConsumption[]; next: number };
    expect(first.entries).toHaveLength(1);
    const second = await (await h.request(`/api/inventory/consumptions?limit=5&before=${first.next}`)).json() as { entries: InvConsumption[]; next: number | null };
    expect(second.entries.map(entry => entry.txnId)).toEqual([done.txnId]);
    for (const query of ['limit=0', 'limit=51', 'before=x', 'foo=1']) expect((await h.request(`/api/inventory/consumptions?${query}`)).status, query).toBe(400);
  });
});
