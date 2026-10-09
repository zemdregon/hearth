import { Hono } from 'hono';
import { z } from 'zod';
import { measurementProfiles, MAX_STOCK, stockDimensions, stockQuantity } from '../shared/inventory/stock';
import type { StockDimension } from '../shared/inventory/stock';
import type { InvItem, InvLedgerEntry, InvLedgerKind, InvLocation, InvLot, InventoryState } from '../shared/inventory/wire';
import { ApiError } from './env';
import type { Env, Variables } from './env';
import { dateSchema, parseInput, readJson } from './validation';
import { matchesSnapshot, snapshotTag } from './snapshot';

export const inventoryRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const txnId = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const version = z.number().int().positive().max(2_147_483_647);
// C0/C1 controls, zero-width and bidi formatting characters, and unpaired surrogates would let
// visually identical or unprintable text through the name-uniqueness key.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const clean = (value: string) => !UNSAFE_TEXT.test(value);
const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
// name_key is NFKC-expanded and capped by CHECK constraints (4 × the display limit), so refuse early.
const text = (max: number) => z.string().trim().min(1).max(max).refine(clean, 'Remove control or invisible characters').refine(value => nameKey(value).length <= max * 4, 'That name is too long once normalised');
const reason = z.string().trim().max(200).refine(clean, 'Remove control or invisible characters');
const profile = z.enum(measurementProfiles).optional();
const entry = { amount: z.string().min(1).max(64).refine(clean, 'Remove control or invisible characters'), unit: z.string().trim().min(1).max(50), profile };
const estimate = { precision: z.enum(['exact', 'estimated']), estBp: z.number().int().min(0).max(10000).optional() };
const note = z.string().trim().max(500).refine(clean, 'Remove control or invisible characters');

const schemas = {
  location: z.object({ name: text(100), kind: z.enum(['pantry', 'fridge', 'freezer', 'other']) }).strict(),
  item: z.object({ name: text(200), dim: z.enum(stockDimensions) }).strict(),
  rename: z.object({ name: text(200), version }).strict(),
  archive: z.object({ version }).strict(),
  addLot: z.object({ txnId, itemId: id, locationId: id.nullable(), ...entry, ...estimate, dateKind: z.enum(['best_by', 'use_by']).optional(), date: dateSchema.optional(), note }).strict(),
  adjust: z.object({ txnId, version, mode: z.enum(['add', 'remove', 'set']), ...entry, precision: estimate.precision.optional(), estBp: estimate.estBp, reason }).strict(),
  archiveLot: z.object({ txnId, version, reason }).strict(),
};

type LocationRow = { id: string; name: string; kind: InvLocation['kind']; version: number };
type ItemRow = { id: string; name: string; dim: StockDimension; version: number };
type LotRow = { id: string; item_id: string; location_id: string | null; qty: number; precision: 'exact' | 'estimated'; est_bp: number; entered_text: string; date_kind: InvLot['dateKind']; date: string | null; note: string; version: number; created_at: number; updated_at: number; archived_at: number | null };
type LedgerRow = { seq: number; txn_id: string; kind: InvLedgerKind; member_id: string; lot_id: string; item_id: string; delta: number; qty_after: number; reason: string; created_at: number };
type Db = D1Database;

const MODULE_ENABLED = "COALESCE((SELECT enabled FROM modules WHERE id = 'inventory'), 0) = 1";
const location = (row: LocationRow): InvLocation => ({ id: row.id, name: row.name, kind: row.kind, version: row.version });
const item = (row: ItemRow): InvItem => ({ id: row.id, name: row.name, dim: row.dim, version: row.version });
const lot = (row: LotRow): InvLot => ({ id: row.id, itemId: row.item_id, locationId: row.location_id, qty: row.qty, precision: row.precision, estBp: row.est_bp, enteredText: row.entered_text, dateKind: row.date_kind, date: row.date, note: row.note, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
const now = () => Math.floor(Date.now() / 1000);

async function requireInventory(db: Db): Promise<void> {
  const row = await db.prepare('SELECT enabled FROM modules WHERE id = ?').bind('inventory').first<{ enabled: number }>();
  if (row?.enabled !== 1) throw new ApiError(403, 'This module is disabled.');
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof ApiError) throw error;
  if (/INVENTORY_LEDGER_FULL/.test(message)) throw new ApiError(409, 'The inventory history is full. Export your data before making more changes.');
  if (/INVENTORY_LIMIT/.test(message)) throw new ApiError(409, 'Inventory is full. Archive items, locations or lots you no longer use.');
  if (/INVENTORY_IN_USE/.test(message)) throw new ApiError(409, 'Use up or archive the stock stored here first.');
  if (/UNIQUE constraint failed.*(name_key)/is.test(message)) throw new ApiError(409, 'That name is already in use. Refresh to see it.');
  if (/INVENTORY_REFERENCE|FOREIGN KEY|CHECK constraint failed|INVENTORY_LEDGER_IMMUTABLE|UNIQUE constraint failed/i.test(message)) throw new ApiError(409, 'Inventory changed. Refresh and try again.');
  throw error;
}

function guarded(db: Db, sql: string, ...values: unknown[]) {
  return db.prepare(`INSERT INTO inv_assert (ok) SELECT 0 WHERE ${sql}`).bind(...values);
}

export async function readInventoryState(db: Db): Promise<InventoryState> {
  const [locations, items, lots] = await db.batch([
    db.prepare('SELECT id, name, kind, version FROM inv_locations WHERE archived_at IS NULL ORDER BY name_key, id'),
    db.prepare('SELECT id, name, dim, version FROM inv_items WHERE archived_at IS NULL ORDER BY name_key, id'),
    db.prepare('SELECT * FROM inv_lots WHERE archived_at IS NULL ORDER BY created_at, id'),
  ]);
  return { locations: (locations.results as LocationRow[]).map(location), items: (items.results as ItemRow[]).map(item), lots: (lots.results as LotRow[]).map(lot) };
}

async function mutate(db: Db, statements: D1PreparedStatement[]): Promise<void> {
  try { await db.batch(statements); } catch (error) { translate(error); }
}

/** Looks up an earlier transaction. Same actor + same canonical request replays; anything else conflicts. */
async function priorTransaction(db: Db, txn: string, memberId: string, hash: string): Promise<InvLot[] | null> {
  const row = await db.prepare('SELECT member_id, request_hash FROM inv_txns WHERE id = ?').bind(txn).first<{ member_id: string; request_hash: string }>();
  if (!row) return null;
  if (row.member_id !== memberId || row.request_hash !== hash) throw new ApiError(409, 'This request id was already used for a different change. Refresh and try again.');
  const rows = await db.prepare('SELECT l.* FROM inv_lots l WHERE l.id IN (SELECT lot_id FROM inv_ledger WHERE txn_id = ?) ORDER BY l.id').bind(txn).all<LotRow>();
  return rows.results.map(lot);
}

async function runLotTransaction(db: Db, txn: string, memberId: string, hash: string, build: () => Promise<D1PreparedStatement[]>, lotId: string): Promise<{ lots: InvLot[]; replayed: boolean }> {
  const earlier = await priorTransaction(db, txn, memberId, hash);
  if (earlier) return { lots: earlier, replayed: true };
  try { await db.batch(await build()); } catch (error) {
    // A concurrent identical retry may have committed first; guards fail before the txn insert is visible.
    const raced = await priorTransaction(db, txn, memberId, hash);
    if (raced) return { lots: raced, replayed: true };
    translate(error);
  }
  const row = await db.prepare('SELECT * FROM inv_lots WHERE id = ?').bind(lotId).first<LotRow>();
  if (!row) throw new ApiError(409, 'Inventory changed. Refresh and try again.');
  return { lots: [lot(row)], replayed: false };
}

export async function readLedger(db: Db, before: number | null, limit: number): Promise<InvLedgerEntry[]> {
  const rows = await db.prepare(`SELECT g.seq, g.txn_id, t.kind, t.member_id, g.lot_id, g.item_id, g.delta, g.qty_after, g.reason, g.created_at
    FROM inv_ledger g JOIN inv_txns t ON t.id = g.txn_id WHERE (? IS NULL OR g.seq < ?) ORDER BY g.seq DESC LIMIT ?`).bind(before, before, limit).all<LedgerRow>();
  return rows.results.map(row => ({ seq: row.seq, txnId: row.txn_id, kind: row.kind, memberId: row.member_id, lotId: row.lot_id, itemId: row.item_id, delta: row.delta, qtyAfter: row.qty_after, reason: row.reason, createdAt: row.created_at }));
}

export async function inventoryEnabled(db: Db): Promise<boolean> {
  return (await db.prepare('SELECT enabled FROM modules WHERE id = ?').bind('inventory').first<{ enabled: number }>())?.enabled === 1;
}

inventoryRoutes.use('*', async (c, next) => { await requireInventory(c.env.DB); await next(); });

inventoryRoutes.get('/', async c => {
  const json = JSON.stringify(await readInventoryState(c.env.DB));
  const tag = await snapshotTag(json);
  c.header('ETag', tag);
  if (matchesSnapshot(c.req.header('If-None-Match'), tag)) return c.body(null, 304);
  return c.body(json, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
});

inventoryRoutes.get('/ledger', async c => {
  const query = parseInput(z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(), c.req.query());
  const entries = await readLedger(c.env.DB, query.before ?? null, query.limit);
  return c.json({ entries, next: entries.length === query.limit ? entries[entries.length - 1].seq : null });
});

inventoryRoutes.post('/locations', async c => {
  const input = parseInput(schemas.location, await readJson(c.req.raw));
  const created = { id: crypto.randomUUID(), name: input.name, kind: input.kind, version: 1 };
  const time = now();
  await mutate(c.env.DB, [
    guarded(c.env.DB, `NOT (${MODULE_ENABLED})`),
    c.env.DB.prepare('INSERT INTO inv_locations (id, name, name_key, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(created.id, input.name, nameKey(input.name), input.kind, time, time),
  ]);
  return c.json(created satisfies InvLocation, 201);
});

inventoryRoutes.post('/locations/:id/archive', async c => {
  const input = parseInput(schemas.archive, await readJson(c.req.raw));
  const result = await archive(c.env.DB, 'inv_locations', c.req.param('id'), input.version);
  return c.json(result);
});

inventoryRoutes.post('/items', async c => {
  const input = parseInput(schemas.item, await readJson(c.req.raw));
  const created = { id: crypto.randomUUID(), name: input.name, dim: input.dim, version: 1 };
  const time = now();
  await mutate(c.env.DB, [
    guarded(c.env.DB, `NOT (${MODULE_ENABLED})`),
    c.env.DB.prepare('INSERT INTO inv_items (id, name, name_key, dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(created.id, input.name, nameKey(input.name), input.dim, time, time),
  ]);
  return c.json(created satisfies InvItem, 201);
});

inventoryRoutes.patch('/items/:id', async c => {
  const input = parseInput(schemas.rename, await readJson(c.req.raw));
  const itemId = c.req.param('id');
  try {
    const row = await c.env.DB.prepare(`UPDATE inv_items SET name = ?, name_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND archived_at IS NULL AND ${MODULE_ENABLED} RETURNING id, name, dim, version`)
      .bind(input.name, nameKey(input.name), now(), itemId, input.version).first<ItemRow>();
    if (!row) throw new ApiError(409, 'Someone changed this item. Refresh to see the latest version.');
    return c.json(item(row));
  } catch (error) { return translate(error); }
});

inventoryRoutes.post('/items/:id/archive', async c => {
  const input = parseInput(schemas.archive, await readJson(c.req.raw));
  return c.json(await archive(c.env.DB, 'inv_items', c.req.param('id'), input.version));
});

async function archive(db: Db, table: 'inv_items' | 'inv_locations', rowId: string, expected: number): Promise<{ id: string }> {
  try {
    const row = await db.prepare(`UPDATE ${table} SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND archived_at IS NULL AND ${MODULE_ENABLED} RETURNING id`)
      .bind(now(), now(), rowId, expected).first<{ id: string }>();
    if (!row) throw new ApiError(409, 'Someone changed this. Refresh to see the latest version.');
    return row;
  } catch (error) { return translate(error); }
}

// Archived rows still load so an identical retry can replay its stored result; the
// writing batch rejects archived rows itself.
async function loadItem(db: Db, itemId: string): Promise<ItemRow & { archived_at: number | null }> {
  const row = await db.prepare('SELECT id, name, dim, version, archived_at FROM inv_items WHERE id = ?').bind(itemId).first<ItemRow & { archived_at: number | null }>();
  if (!row) throw new ApiError(404, 'This item no longer exists.');
  return row;
}

function checkEstimate(precision: 'exact' | 'estimated', estBp: number | undefined): number {
  if (precision === 'exact') {
    if (estBp) throw new ApiError(400, 'Exact stock cannot have an estimate range.');
    return 0;
  }
  if (!estBp || estBp < 1) throw new ApiError(400, 'Choose how approximate this amount is.');
  return estBp;
}

inventoryRoutes.post('/lots', async c => {
  const input = parseInput(schemas.addLot, await readJson(c.req.raw));
  const target = await loadItem(c.env.DB, input.itemId);
  const quantity = stockQuantity(input, target.dim);
  if (!quantity.ok) throw new ApiError(400, quantity.message);
  if ((input.dateKind === undefined) !== (input.date === undefined)) throw new ApiError(400, 'Choose both a date type and a date, or neither.');
  const estBp = checkEstimate(input.precision, input.estBp);
  const user = c.get('user');
  const lotId = crypto.randomUUID();
  const time = now();
  const hash = await digest({ op: 'add', itemId: input.itemId, locationId: input.locationId, qty: quantity.qty, text: quantity.text, precision: input.precision, estBp, dateKind: input.dateKind ?? null, date: input.date ?? null, note: input.note });
  const db = c.env.DB;
  const result = await runLotTransaction(db, input.txnId, user.id, hash, async () => {
    if (target.archived_at) throw new ApiError(404, 'This item no longer exists.');
    return [
    db.prepare("INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) VALUES (?, 'add', ?, ?, ?)").bind(input.txnId, user.id, hash, time),
    guarded(db, `NOT (${MODULE_ENABLED}) OR NOT EXISTS (SELECT 1 FROM inv_items WHERE id = ? AND dim = ? AND archived_at IS NULL)`, input.itemId, target.dim),
    db.prepare(`INSERT INTO inv_lots (id, item_id, location_id, qty, precision, est_bp, entered_text, date_kind, date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(lotId, input.itemId, input.locationId, quantity.qty, input.precision, estBp, quantity.text, input.dateKind ?? null, input.date ?? null, input.note, time, time),
    db.prepare("INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at) VALUES (?, ?, ?, ?, ?, 'Added', ?)").bind(input.txnId, lotId, input.itemId, quantity.qty, quantity.qty, time),
    ];
  }, lotId);
  return c.json(result, result.replayed ? 200 : 201);
});

async function loadLot(db: Db, lotId: string): Promise<LotRow> {
  const row = await db.prepare('SELECT * FROM inv_lots WHERE id = ?').bind(lotId).first<LotRow>();
  if (!row) throw new ApiError(404, 'This stock no longer exists.');
  return row;
}

inventoryRoutes.post('/lots/:id/adjust', async c => {
  const input = parseInput(schemas.adjust, await readJson(c.req.raw));
  const current = await loadLot(c.env.DB, c.req.param('id'));
  const target = await loadItem(c.env.DB, current.item_id);
  if (input.mode !== 'set' && (input.precision !== undefined || input.estBp !== undefined)) throw new ApiError(400, 'Only a recount can change how approximate stock is.');
  const quantity = stockQuantity(input, target.dim, { allowZero: input.mode === 'set' });
  if (!quantity.ok) throw new ApiError(400, quantity.message);
  // Derived from the lot's current state, so it is checked only after an identical earlier
  // attempt has had its chance to replay.
  const resultingQty = () => {
    const next = input.mode === 'add' ? current.qty + quantity.qty : input.mode === 'remove' ? current.qty - quantity.qty : quantity.qty;
    if (next < 0) throw new ApiError(409, 'There is less than that recorded. Use a recount if the shelf differs.');
    if (next > MAX_STOCK) throw new ApiError(400, 'That amount is too large.');
    return next;
  };
  if (input.estBp !== undefined && input.precision === undefined) throw new ApiError(400, 'Choose whether the recount is exact or estimated.');
  const precision = input.mode === 'set' ? input.precision ?? current.precision : current.precision;
  const estBp = input.mode === 'set' ? checkEstimate(precision, input.precision === undefined ? (precision === 'estimated' ? current.est_bp : undefined) : input.estBp) : current.est_bp;
  const entered = input.mode === 'set' ? quantity.text : current.entered_text;
  const user = c.get('user');
  const time = now();
  const kind = input.mode === 'set' ? 'count' : 'adjust';
  const label = input.reason || (input.mode === 'add' ? 'Added stock' : input.mode === 'remove' ? 'Removed stock' : 'Recounted');
  const hash = await digest({ op: kind, lotId: current.id, version: input.version, mode: input.mode, qty: quantity.qty, precision, estBp, reason: label });
  const db = c.env.DB;
  const result = await runLotTransaction(db, input.txnId, user.id, hash, async () => {
    if (current.archived_at) throw new ApiError(404, 'This stock no longer exists.');
    const next = resultingQty();
    return [
    db.prepare('INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(input.txnId, kind, user.id, hash, time),
    guarded(db, `NOT (${MODULE_ENABLED}) OR NOT EXISTS (SELECT 1 FROM inv_lots WHERE id = ? AND version = ? AND qty = ? AND archived_at IS NULL)`, current.id, input.version, current.qty),
    db.prepare('UPDATE inv_lots SET qty = ?, precision = ?, est_bp = ?, entered_text = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(next, precision, estBp, entered, time, current.id, input.version),
    db.prepare('INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(input.txnId, current.id, current.item_id, next - current.qty, next, label, time),
    ];
  }, current.id);
  return c.json(result);
});

inventoryRoutes.post('/lots/:id/archive', async c => {
  const input = parseInput(schemas.archiveLot, await readJson(c.req.raw));
  const current = await loadLot(c.env.DB, c.req.param('id'));
  const user = c.get('user');
  const time = now();
  const label = input.reason || 'Archived';
  const hash = await digest({ op: 'archive', lotId: current.id, version: input.version, reason: label });
  const db = c.env.DB;
  const result = await runLotTransaction(db, input.txnId, user.id, hash, async () => {
    if (current.archived_at) throw new ApiError(404, 'This stock no longer exists.');
    return [
    db.prepare("INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) VALUES (?, 'archive', ?, ?, ?)").bind(input.txnId, user.id, hash, time),
    guarded(db, `NOT (${MODULE_ENABLED}) OR NOT EXISTS (SELECT 1 FROM inv_lots WHERE id = ? AND version = ? AND qty = ? AND archived_at IS NULL)`, current.id, input.version, current.qty),
    db.prepare('UPDATE inv_lots SET qty = 0, archived_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(time, time, current.id, input.version),
    db.prepare('INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').bind(input.txnId, current.id, current.item_id, -current.qty, label, time),
    ];
  }, current.id);
  return c.json(result);
});
