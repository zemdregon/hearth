import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './fixtures/api-harness';
import type { InvItem, InvLot, InvLocation, InvLotResult, InventoryState } from '../src/shared/inventory';

let h: ReturnType<typeof harness>;
beforeEach(() => { h = harness(); });
afterEach(() => h.close());

const enable = (on = true) => h.sqlite.exec(`UPDATE modules SET enabled = ${on ? 1 : 0} WHERE id = 'inventory'`);
const post = (path: string, body: unknown, user?: string) => h.request(`/api/inventory${path}`, { method: 'POST', body, user });
const state = async (user?: string) => (await h.request('/api/inventory', { user })).json() as Promise<InventoryState>;
let counter = 0;
const txn = () => `txn-${String(++counter).padStart(6, '0')}`;
async function item(name = 'Flour', dim = 'mass'): Promise<InvItem> {
  const response = await post('/items', { name, dim });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<InvItem>;
}
async function addLot(itemId: string, extra: Record<string, unknown> = {}, id = txn()) {
  return post('/lots', { txnId: id, itemId, locationId: null, amount: '2', unit: 'kg', precision: 'exact', note: '', ...extra });
}
async function stock(itemId: string, extra: Record<string, unknown> = {}): Promise<InvLot> {
  const response = await addLot(itemId, extra);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as InvLotResult).lots[0];
}

describe('inventory module gating', () => {
  it('ships disabled: every route is forbidden and rows are not exposed', async () => {
    for (const [method, path] of [['GET', ''], ['GET', '/ledger'], ['POST', '/items'], ['POST', '/lots']] as const) {
      const response = await h.request(`/api/inventory${path}`, { method, body: method === 'POST' ? {} : undefined });
      expect(response.status, path).toBe(403);
    }
    const bootstrap = await (await h.request('/api/bootstrap')).json() as { modules: { id: string; enabled: boolean }[] };
    expect(bootstrap.modules.find(module => module.id === 'inventory')).toEqual({ id: 'inventory', enabled: false });
    expect(h.sqlite.prepare("SELECT enabled FROM modules WHERE id = 'inventory'").get()).toEqual({ enabled: 0 });
  });
  it('treats a missing module row as disabled, and keeps data when paused', async () => {
    enable();
    const created = await item();
    await stock(created.id);
    enable(false);
    expect((await h.request('/api/inventory')).status).toBe(403);
    expect((await addLot(created.id)).status).toBe(403);
    h.sqlite.exec("DELETE FROM modules WHERE id = 'inventory'");
    expect((await h.request('/api/inventory')).status).toBe(403);
    h.sqlite.exec("INSERT INTO modules VALUES ('inventory', 1)");
    expect((await state()).lots).toHaveLength(1);
  });
  it('requires a session and rejects cross-origin writes', async () => {
    enable();
    expect((await h.request('/api/inventory', { user: 'outsider' })).status).toBe(401);
    expect((await h.request('/api/inventory/items', { method: 'POST', body: { name: 'X', dim: 'mass' }, headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
  });
  it('lets an administrator enable the module through the existing endpoint; members cannot', async () => {
    expect((await h.request('/api/modules/inventory', { method: 'PATCH', body: { enabled: true }, user: 'sam' })).status).toBe(403);
    expect((await h.request('/api/modules/inventory', { method: 'PATCH', body: { enabled: true } })).status).toBe(200);
    expect((await h.request('/api/inventory', { user: 'sam' })).status).toBe(200);
  });
});

const count = (table: string) => Number((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const error = async (response: Response) => ((await response.json()) as { error: string }).error;
const lotRow = (id: string) => h.sqlite.prepare('SELECT * FROM inv_lots WHERE id = ?').get(id) as Record<string, unknown>;
const adjust = (lot: InvLot, body: Record<string, unknown>, id = txn()) => post(`/lots/${lot.id}/adjust`, { txnId: id, version: lot.version, mode: 'add', amount: '1', unit: 'kg', reason: '', ...body });

describe('stock entry converts to exact integer base units', () => {
  beforeEach(enable);
  it('stores weights in ng and volumes in nL exactly', async () => {
    const flour = await item();
    expect((await stock(flour.id, { amount: '1 1/2', unit: 'lb' })).qty).toBe(680_388_555_000);
    expect((await stock(flour.id, { amount: '3', unit: 'oz-mass' })).qty).toBe(85_048_569_375);
    expect((await stock(flour.id, { amount: '250', unit: 'g' })).qty).toBe(250_000_000_000);
    const milk = await item('Milk', 'volume');
    expect((await stock(milk.id, { amount: '2', unit: 'cup', profile: 'us-customary' })).qty).toBe(473_176_473);
    expect((await stock(milk.id, { amount: '2', unit: 'cup', profile: 'us-label' })).qty).toBe(480_000_000);
    expect((await stock(milk.id, { amount: '1', unit: 'L' })).qty).toBe(1_000_000_000);
    const eggs = await item('Eggs', 'count:egg');
    expect((await stock(eggs.id, { amount: '12', unit: 'eggs' })).qty).toBe(12);
  });
  it('rejects ambiguity, mismatch, ranges, zero and unrepresentable amounts instead of guessing', async () => {
    const flour = await item();
    const milk = await item('Milk', 'volume');
    const eggs = await item('Eggs', 'count:egg');
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [milk.id, { amount: '1', unit: 'cup' }, /convention/],
      [flour.id, { amount: '1', unit: 'oz' }, /weight/],
      [flour.id, { amount: '1', unit: 'ml' }, /weight/],
      [eggs.id, { amount: '1', unit: 'clove' }, /egg/],
      [flour.id, { amount: '1-2', unit: 'kg' }, /range/],
      [flour.id, { amount: '0', unit: 'kg' }, /greater than zero/],
      [flour.id, { amount: 'a lot', unit: 'kg' }, /exact amount/],
      [flour.id, { amount: '1', unit: 'handful' }, /not recognised/],
      [flour.id, { amount: '9999999999', unit: 'kg' }, /too large/],
    ];
    for (const [itemId, extra, message] of cases) {
      const response = await addLot(itemId, extra);
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await error(response), JSON.stringify(extra)).toMatch(message);
    }
    expect(count('inv_lots') + count('inv_txns') + count('inv_ledger')).toBe(0);
  });
  it('rounds only up to the next base unit, for exact and estimated stock alike', async () => {
    const spice = await item('Cumin', 'volume');
    expect((await stock(spice.id, { amount: '1', unit: 'tsp', profile: 'us-customary' })).qty).toBe(4_928_922); // 4,928,921.59375 nL
    expect((await stock(spice.id, { amount: '1', unit: 'cup', profile: 'us-customary' })).qty).toBe(236_588_237); // 236,588,236.5 nL, rounded up
    const lot = await stock(spice.id, { amount: '1', unit: 'tsp', profile: 'us-customary', precision: 'estimated', estBp: 2500 });
    expect(lot).toMatchObject({ qty: 4_928_922, precision: 'estimated', estBp: 2500 });
  });
  it('validates precision, dates, notes and identifiers', async () => {
    const flour = await item();
    for (const extra of [{ precision: 'estimated' }, { precision: 'exact', estBp: 100 }, { precision: 'estimated', estBp: 10001 }, { dateKind: 'use_by' }, { date: '2026-01-01' }, { dateKind: 'use_by', date: '2026-02-30' },
      { note: 'x'.repeat(501) }, { note: 'bad\u0000' }, { unit: '' }, { amount: '1'.repeat(65) }, { extra: 1 }, { txnId: 'short' }, { txnId: 'has space in it' }]) {
      expect((await addLot(flour.id, extra)).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await addLot('missing', {})).status).toBe(404);
    expect((await addLot(flour.id, { locationId: 'missing' })).status).toBe(409);
    expect((await addLot(flour.id, { dateKind: 'best_by', date: '2027-03-01', note: 'back shelf' })).status).toBe(201);
    expect(count('inv_lots')).toBe(1);
  });
});

describe('catalog', () => {
  beforeEach(enable);
  it('keeps names unique among active rows, case and spacing insensitive', async () => {
    await item('Olive  Oil');
    for (const name of ['olive oil', ' OLIVE OIL ', 'ｏｌｉｖｅ ｏｉｌ']) expect((await post('/items', { name, dim: 'volume' })).status, name).toBe(409);
    expect((await post('/locations', { name: 'Pantry', kind: 'pantry' })).status).toBe(201);
    expect((await post('/locations', { name: 'pantry', kind: 'other' })).status).toBe(409);
    expect((await post('/items', { name: 'x', dim: 'weight' })).status).toBe(400);
    expect((await post('/items', { name: '   ', dim: 'mass' })).status).toBe(400);
    expect((await post('/items', { name: 'a'.repeat(201), dim: 'mass' })).status).toBe(400);
  });
  it('renames with an optimistic version and archives only when nothing live uses it', async () => {
    const flour = await item();
    const lot = await stock(flour.id);
    const stale = await h.request(`/api/inventory/items/${flour.id}`, { method: 'PATCH', body: { name: 'Plain flour', version: 7 } });
    expect(stale.status).toBe(409);
    const renamed = await h.request(`/api/inventory/items/${flour.id}`, { method: 'PATCH', body: { name: 'Plain flour', version: 1 } });
    expect(await renamed.json()).toMatchObject({ name: 'Plain flour', version: 2 });
    const blocked = await post(`/items/${flour.id}/archive`, { version: 2 });
    expect(blocked.status).toBe(409);
    expect(await error(blocked)).toMatch(/Use up or archive/);
    expect((await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: lot.version, reason: '' })).status).toBe(200);
    expect((await post(`/items/${flour.id}/archive`, { version: 2 })).status).toBe(200);
    expect((await state()).items).toEqual([]);
    expect((await item('Flour')).id).not.toBe(flour.id); // archived names are reusable
    expect((await addLot(flour.id)).status).toBe(404);
  });
  it('protects locations the same way and refuses stock in an archived location', async () => {
    const shelf = await (await post('/locations', { name: 'Shelf', kind: 'pantry' })).json() as InvLocation;
    const flour = await item();
    const lot = await stock(flour.id, { locationId: shelf.id });
    expect((await post(`/locations/${shelf.id}/archive`, { version: 1 })).status).toBe(409);
    await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: 1, reason: '' });
    expect((await post(`/locations/${shelf.id}/archive`, { version: 1 })).status).toBe(200);
    expect((await addLot(flour.id, { locationId: shelf.id })).status).toBe(409);
  });
});

describe('adjustments and the ledger', () => {
  beforeEach(enable);
  it('applies add, remove and recount with exact deltas and an audit trail', async () => {
    const flour = await item();
    let lot = await stock(flour.id, { amount: '2', unit: 'kg' });
    lot = ((await (await adjust(lot, { mode: 'remove', amount: '500', unit: 'g', reason: 'Baked bread' })).json()) as InvLotResult).lots[0];
    expect(lot).toMatchObject({ qty: 1_500_000_000_000, version: 2 });
    lot = ((await (await adjust(lot, { mode: 'add', amount: '250', unit: 'g' })).json()) as InvLotResult).lots[0];
    expect(lot.qty).toBe(1_750_000_000_000);
    lot = ((await (await adjust(lot, { mode: 'set', amount: '1.2', unit: 'kg', precision: 'estimated', estBp: 1000 })).json()) as InvLotResult).lots[0];
    expect(lot).toMatchObject({ qty: 1_200_000_000_000, precision: 'estimated', estBp: 1000, enteredText: '1.2 kg' });
    const ledger = await (await h.request('/api/inventory/ledger', { user: 'sam' })).json() as { entries: { kind: string; delta: number; qtyAfter: number; reason: string; memberId: string }[]; next: null };
    expect(ledger.entries[0]).toMatchObject({ itemName: 'Flour', dim: 'mass' }); // names and units travel with history, even for archived items
    expect(ledger.entries.map(entry => [entry.kind, entry.delta, entry.qtyAfter, entry.reason, entry.memberId])).toEqual([
      ['count', -550_000_000_000, 1_200_000_000_000, 'Recounted', 'alex'],
      ['adjust', 250_000_000_000, 1_750_000_000_000, 'Added stock', 'alex'],
      ['adjust', -500_000_000_000, 1_500_000_000_000, 'Baked bread', 'alex'],
      ['add', 2_000_000_000_000, 2_000_000_000_000, 'Added', 'alex'],
    ]);
  });
  it('never goes negative, overflows, or applies a stale or foreign-dimension change', async () => {
    const flour = await item();
    const lot = await stock(flour.id, { amount: '1', unit: 'kg' });
    const before = JSON.stringify([lotRow(lot.id), count('inv_ledger'), count('inv_txns')]);
    expect((await adjust(lot, { mode: 'remove', amount: '1001', unit: 'g' })).status).toBe(409);
    expect((await adjust(lot, { mode: 'add', amount: '9000', unit: 'kg' })).status).toBe(400);
    expect((await adjust(lot, { mode: 'add', amount: '1', unit: 'L' })).status).toBe(400);
    expect((await adjust(lot, { mode: 'add', amount: '1', unit: 'kg', precision: 'estimated', estBp: 100 })).status).toBe(400);
    expect((await adjust({ ...lot, version: 9 }, { mode: 'add' })).status).toBe(409);
    expect((await adjust(lot, { mode: 'set', amount: '1', unit: 'kg', estBp: 100 })).status).toBe(400);
    expect(JSON.stringify([lotRow(lot.id), count('inv_ledger'), count('inv_txns')])).toBe(before);
    expect((await adjust(lot, { mode: 'set', amount: '0', unit: 'kg' })).status).toBe(200);
    expect((await adjust({ ...lot, version: 2 }, { mode: 'remove', amount: '1', unit: 'g' })).status).toBe(409);
  });
  it('archives a lot into a zero balance, records it, and refuses further changes', async () => {
    const flour = await item();
    const lot = await stock(flour.id, { amount: '1', unit: 'kg' });
    const archived = await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: 1, reason: 'Thrown out' });
    expect(((await archived.json()) as InvLotResult).lots[0]).toMatchObject({ qty: 0 });
    expect((await state()).lots).toEqual([]);
    expect((await adjust({ ...lot, version: 2 }, {})).status).toBe(404);
    expect(h.sqlite.prepare("SELECT delta, qty_after, reason FROM inv_ledger WHERE reason = 'Thrown out'").get()).toEqual({ delta: -1_000_000_000_000, qty_after: 0, reason: 'Thrown out' });
  });
  it('rolls back every table when a late statement fails', async () => {
    const flour = await item();
    h.sqlite.exec('UPDATE inv_storage SET ledger_count = 100000');
    const response = await addLot(flour.id);
    expect(response.status).toBe(409);
    expect(await error(response)).toMatch(/full/);
    expect(count('inv_lots') + count('inv_txns') + count('inv_ledger')).toBe(0);
  });
  it('paginates the ledger newest first with bounded pages', async () => {
    const flour = await item();
    for (let index = 0; index < 5; index++) await stock(flour.id);
    const first = await (await h.request('/api/inventory/ledger?limit=2')).json() as { entries: { seq: number }[]; next: number };
    expect(first.entries).toHaveLength(2);
    const second = await (await h.request(`/api/inventory/ledger?limit=3&before=${first.next}`)).json() as { entries: { seq: number }[]; next: number | null };
    expect(second.entries.map(entry => entry.seq)).toEqual([3, 2, 1]);
    for (const query of ['limit=0', 'limit=101', 'before=-1', 'before=x', 'foo=1']) expect((await h.request(`/api/inventory/ledger?${query}`)).status, query).toBe(400);
  });
});

describe('idempotency and concurrency', () => {
  beforeEach(enable);
  it('replays an identical authorized retry once, and rejects reuse for anything else', async () => {
    const flour = await item();
    const id = txn();
    const first = await addLot(flour.id, {}, id);
    const lot = ((await first.json()) as InvLotResult).lots[0];
    const retry = await addLot(flour.id, {}, id);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ lots: [lot], replayed: true });
    expect(count('inv_lots')).toBe(1);
    expect(count('inv_ledger')).toBe(1);
    expect((await addLot(flour.id, { amount: '3' }, id)).status).toBe(409);
    expect((await post('/lots', { txnId: id, itemId: flour.id, locationId: null, amount: '2', unit: 'kg', precision: 'exact', note: '' }, 'sam')).status).toBe(409);
    expect(count('inv_lots')).toBe(1);
  });
  it('replays a completed change even after later edits made its version stale', async () => {
    const flour = await item();
    const lot = await stock(flour.id);
    const id = txn();
    expect((await adjust(lot, { mode: 'add' }, id)).status).toBe(200);
    expect((await adjust(lot, { mode: 'add' }, id)).status).toBe(200);
    expect(count('inv_ledger')).toBe(2);
    expect((await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: 2, reason: '' }, 'sam')).status).toBe(200);
    expect(await (await adjust(lot, { mode: 'add' }, id)).json()).toMatchObject({ replayed: true });
    const archiveId = txn();
    expect((await post(`/lots/${lot.id}/archive`, { txnId: archiveId, version: 5, reason: '' })).status).toBe(404);
  });
  it('lets exactly one of two concurrent changes win the same version', async () => {
    const flour = await item();
    const lot = await stock(flour.id, { amount: '10', unit: 'kg' });
    const attempts = await Promise.all([adjust(lot, { mode: 'remove', amount: '1', unit: 'kg' }), adjust(lot, { mode: 'remove', amount: '2', unit: 'kg' })]);
    expect(attempts.map(response => response.status).sort()).toEqual([200, 409]);
    expect(count('inv_ledger')).toBe(2);
  });
  it('applies concurrent identical retries once', async () => {
    const flour = await item();
    const lot = await stock(flour.id);
    const id = txn();
    const results = await Promise.all([adjust(lot, { mode: 'remove', amount: '100', unit: 'g' }, id), adjust(lot, { mode: 'remove', amount: '100', unit: 'g' }, id)]);
    expect(results.map(response => response.status)).toEqual([200, 200]);
    expect(lotRow(lot.id).qty).toBe(1_900_000_000_000);
    expect(count('inv_ledger')).toBe(2);
  });
});

describe('database guards', () => {
  beforeEach(enable);
  it('makes the audit trail append-only', async () => {
    const flour = await item();
    await stock(flour.id);
    for (const sql of ["UPDATE inv_ledger SET delta = 0", 'DELETE FROM inv_ledger', "UPDATE inv_txns SET kind = 'add'", 'DELETE FROM inv_txns']) {
      expect(() => h.sqlite.exec(sql), sql).toThrow(/INVENTORY_LEDGER_IMMUTABLE/);
    }
    h.sqlite.exec('CREATE TABLE mutable_copy AS SELECT * FROM inv_ledger');
    expect(() => h.sqlite.exec('DELETE FROM mutable_copy')).not.toThrow(); // negative control: the trigger is what blocks deletion
    expect(count('inv_ledger')).toBe(1);
  });
  it('enforces caps and the integer/bounds constraints in SQL', async () => {
    h.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO inv_items (id, name, name_key, dim, created_at, updated_at) SELECT 'i' || i, 'Item ' || i, 'item ' || i, 'mass', 1, 1 FROM n`);
    const response = await post('/items', { name: 'One more', dim: 'mass' });
    expect(response.status).toBe(409);
    expect(await error(response)).toMatch(/full/);
    const insert = (qty: unknown) => h.sqlite.prepare("INSERT INTO inv_lots (id, item_id, qty, precision, entered_text, created_at, updated_at) VALUES ('x', 'i1', ?, 'exact', '', 1, 1)").run(qty as number);
    expect(() => insert(-1)).toThrow(/CHECK/);
    expect(() => insert(9_000_000_000_000_001)).toThrow(/CHECK/);
    expect(() => insert(1.5)).toThrow(/CHECK/);
    expect(() => insert('abc')).toThrow(/CHECK/);
    h.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO inv_lots (id, item_id, qty, precision, entered_text, created_at, updated_at) SELECT 'l' || i, 'i1', 1, 'exact', '', 1, 1 FROM n`);
    expect(() => insert(1)).toThrow(/INVENTORY_LIMIT/);
  });
  it('keeps the existing family storage accounting untouched by inventory writes', async () => {
    const before = h.sqlite.prepare('SELECT data_bytes, record_count FROM family_storage').get();
    await stock((await item()).id);
    expect(h.sqlite.prepare('SELECT data_bytes, record_count FROM family_storage').get()).toEqual(before);
  });
});

describe('reads', () => {
  beforeEach(enable);
  it('is household-shared, private, conditional and omitted from bootstrap', async () => {
    const flour = await item();
    await stock(flour.id);
    const read = await h.request('/api/inventory', { user: 'sam' });
    expect(read.headers.get('Cache-Control')).toBe('no-store, private');
    const tag = read.headers.get('ETag')!;
    expect(((await read.json()) as InventoryState).lots).toHaveLength(1);
    expect((await h.request('/api/inventory', { user: 'sam', headers: { 'If-None-Match': tag } })).status).toBe(304);
    await stock(flour.id);
    expect((await h.request('/api/inventory', { user: 'sam', headers: { 'If-None-Match': tag } })).status).toBe(200);
    const bootstrap = JSON.stringify(await (await h.request('/api/bootstrap')).json());
    expect(bootstrap).not.toContain('Flour');
    expect(bootstrap).not.toContain('inv_');
  });
});

describe('export', () => {
  it('includes inventory only while the module is enabled, and keeps data across a pause', async () => {
    const exported = async () => (await h.request('/api/export')).json() as Promise<{ schemaVersion: number; inventory?: { items: InvItem[]; lots: InvLot[]; ledger: unknown[]; ledgerTruncated: boolean } }>;
    expect(await exported()).toMatchObject({ schemaVersion: 1 });
    enable();
    await stock((await item()).id);
    const full = await exported();
    expect(full.schemaVersion).toBe(2);
    expect(full.inventory).toMatchObject({ ledgerTruncated: false });
    expect([full.inventory!.items.length, full.inventory!.lots.length, full.inventory!.ledger.length]).toEqual([1, 1, 1]);
    enable(false);
    const paused = await exported();
    expect(paused.schemaVersion).toBe(1);
    expect('inventory' in paused).toBe(false);
    enable();
    expect((await exported()).inventory!.lots).toHaveLength(1);
  });
});

describe('review regressions', () => {
  beforeEach(enable);
  it('replays a completed removal or addition whose result would now be invalid', async () => {
    const flour = await item();
    const lot = await stock(flour.id, { amount: '10', unit: 'g' });
    const id = txn();
    expect((await adjust(lot, { mode: 'remove', amount: '6', unit: 'g' }, id)).status).toBe(200);
    const replay = await adjust(lot, { mode: 'remove', amount: '6', unit: 'g' }, id);
    expect([replay.status, ((await replay.json()) as InvLotResult).replayed]).toEqual([200, true]);
    const big = await stock((await item('Rice')).id, { amount: '4500', unit: 'kg' });
    const again = txn();
    expect((await adjust(big, { mode: 'add', amount: '4500', unit: 'kg' }, again)).status).toBe(200);
    expect((await adjust(big, { mode: 'add', amount: '4500', unit: 'kg' }, again)).status).toBe(200);
    expect(count('inv_ledger')).toBe(4);
  });
  it('still lets stock be archived when the history is at its cap, but not changed', async () => {
    const flour = await item();
    const lot = await stock(flour.id);
    h.sqlite.exec('UPDATE inv_storage SET ledger_count = 100000');
    const blocked = await adjust(lot, { mode: 'remove', amount: '1', unit: 'g' });
    expect(blocked.status).toBe(409);
    expect(await error(blocked)).toMatch(/history is full/);
    expect((await post(`/lots/${lot.id}/archive`, { txnId: txn(), version: 1, reason: '' })).status).toBe(200);
    h.sqlite.exec('UPDATE inv_storage SET ledger_count = 101000');
    const second = await stock((await item('Sugar')).id.valueOf()).catch(() => null);
    expect(second).toBeNull();
  });
  it('rounds a positive amount up to at least one base unit, and rejects control characters in amounts', async () => {
    const flour = await item();
    const tiny = await stock(flour.id, { amount: '0.000000000001', unit: 'g' });
    expect(tiny.qty).toBe(1); // 0.001 ng rounds UP, so a positive entry is never silently zero
    expect((await addLot(flour.id, { amount: '1\n/\n2', unit: 'kg' })).status).toBe(400);
    const lot = await stock(flour.id, { amount: '1  1/2', unit: 'kg' });
    expect(lot.enteredText).toBe('1 1/2 kg');
    expect((await adjust(lot, { mode: 'set', amount: '0', unit: 'kg' })).status).toBe(200);
  });
  it('rejects names that expand past the key limit or hide look-alike characters', async () => {
    expect((await post('/items', { name: 'ﷺ'.repeat(45), dim: 'mass' })).status).toBe(400);
    expect((await post('/items', { name: 'ﷺ'.repeat(44), dim: 'mass' })).status).toBe(201);
    expect((await post('/locations', { name: 'ﷺ'.repeat(30), kind: 'other' })).status).toBe(400);
    for (const name of ['Fl\u200Bour', 'Flo\u202Eur', 'Flour\u0085', 'Flo\ufeffur', 'bad\ud800name']) expect((await post('/items', { name, dim: 'mass' })).status, JSON.stringify(name)).toBe(400);
  });
  it('flags a truncated export only when entries were actually left out', async () => {
    const flour = await item();
    await stock(flour.id);
    h.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
      INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) SELECT 'filler-' || printf('%05d', i), 'adjust', 'alex', printf('%064d', i), 1 FROM n`);
    h.sqlite.exec(`INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at)
      SELECT t.id, l.id, l.item_id, 0, l.qty, 'filler', 1 FROM inv_txns t, inv_lots l WHERE t.id LIKE 'filler-%'`);
    const exported = async () => ((await (await h.request('/api/export')).json()) as { inventory: { ledger: unknown[]; ledgerTruncated: boolean } }).inventory;
    expect(await exported()).toMatchObject({ ledgerTruncated: false });
    expect((await exported()).ledger).toHaveLength(1000);
    await stock(flour.id);
    expect(await exported()).toMatchObject({ ledgerTruncated: true });
  });
});
