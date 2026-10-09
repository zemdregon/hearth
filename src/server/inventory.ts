import { Hono } from 'hono';
import { z } from 'zod';
import { measurementProfiles, MAX_STOCK, stockDimensions, stockQuantity } from '../shared/inventory/stock';
import { todayInTimezone } from '../shared/calendar';
import { checkRecipe, ingredientKey, isExpired } from '../shared/inventory/recipe';
import { parseQuantity } from '../shared/inventory/quantity';
import { resolveUnit } from '../shared/inventory/units';
import type { StockDimension } from '../shared/inventory/stock';
import type { ConsumeLine, ConsumePreview, ConsumeResult, InvAlias, InvCalibration, InvConsumption, InvItem, InvLedgerEntry, InvLedgerKind, InvLocation, InvLot, InvSettings, InventoryState } from '../shared/inventory/wire';
import type { Recipe } from '../shared/types';
import { ApiError } from './env';
import type { Env, Variables } from './env';
import { dateSchema, parseInput, readJson } from './validation';
import { matchesSnapshot, snapshotTag } from './snapshot';
import { getRecord, requireModule } from './db';

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
  settings: z.object({ measureProfile: z.enum(measurementProfiles).nullable(), version }).strict(),
  alias: z.object({ name: text(200), itemId: id }).strict(),
  calibration: z.object({
    itemId: id, fromAmount: entry.amount, fromUnit: entry.unit, fromProfile: profile, toAmount: entry.amount, toUnit: entry.unit, toProfile: profile,
  }).strict(),
  consume: z.object({
    txnId, recipeId: id, servings: z.number().int().min(1).max(1000),
    takes: z.array(z.object({ lotId: id, version, take: z.number().int().min(1).max(MAX_STOCK) }).strict()).min(1).max(100),
    shortfalls: z.array(z.object({ itemId: id, amount: z.number().int().min(1).max(MAX_STOCK) }).strict()).max(100),
  }).strict(),
  undo: z.object({ txnId }).strict(),
  availability: z.object({ recipeId: id, servings: z.number().int().min(1).max(1000), exclude: z.array(z.number().int().min(0).max(99)).max(100) }).strict(),
};

type LocationRow = { id: string; name: string; kind: InvLocation['kind']; version: number };
type ItemRow = { id: string; name: string; dim: StockDimension; version: number };
type LotRow = { id: string; item_id: string; location_id: string | null; qty: number; precision: 'exact' | 'estimated'; est_bp: number; entered_text: string; date_kind: InvLot['dateKind']; date: string | null; note: string; version: number; created_at: number; updated_at: number; archived_at: number | null };
type LedgerRow = { seq: number; txn_id: string; kind: InvLedgerKind; member_id: string; lot_id: string; item_id: string; item_name: string; dim: StockDimension; delta: number; qty_after: number; reason: string; created_at: number };
type AliasRow = { id: string; name: string; item_id: string; version: number };
type CalibrationRow = { id: string; item_id: string; from_amount: string; from_unit: string; from_profile: InvCalibration['fromProfile']; to_amount: string; to_unit: string; to_profile: InvCalibration['toProfile']; version: number };
type SettingsRow = { measure_profile: InvSettings['measureProfile']; version: number };
type Db = D1Database;

const MODULE_ENABLED = "COALESCE((SELECT enabled FROM modules WHERE id = 'inventory'), 0) = 1";
const location = (row: LocationRow): InvLocation => ({ id: row.id, name: row.name, kind: row.kind, version: row.version });
const item = (row: ItemRow): InvItem => ({ id: row.id, name: row.name, dim: row.dim, version: row.version });
const alias = (row: AliasRow): InvAlias => ({ id: row.id, name: row.name, itemId: row.item_id, version: row.version });
const calibration = (row: CalibrationRow): InvCalibration => ({ id: row.id, itemId: row.item_id, fromAmount: row.from_amount, fromUnit: row.from_unit, fromProfile: row.from_profile, toAmount: row.to_amount, toUnit: row.to_unit, toProfile: row.to_profile, version: row.version });
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
  if (/UNIQUE constraint failed.*(dims)/is.test(message)) throw new ApiError(409, 'This item already has a conversion between these kinds of measurement. Remove it first.');
  if (/UNIQUE constraint failed.*(name_key)/is.test(message)) throw new ApiError(409, 'That name is already in use. Refresh to see it.');
  if (/INVENTORY_REFERENCE|FOREIGN KEY|CHECK constraint failed|INVENTORY_LEDGER_IMMUTABLE|UNIQUE constraint failed/i.test(message)) throw new ApiError(409, 'Inventory changed. Refresh and try again.');
  throw error;
}

function guarded(db: Db, sql: string, ...values: unknown[]) {
  return db.prepare(`INSERT INTO inv_assert (ok) SELECT 0 WHERE ${sql}`).bind(...values);
}

export async function readInventoryState(db: Db): Promise<InventoryState> {
  const [locations, items, lots, aliases, calibrations, settings] = await db.batch([
    db.prepare('SELECT id, name, kind, version FROM inv_locations WHERE archived_at IS NULL ORDER BY name_key, id'),
    db.prepare('SELECT id, name, dim, version FROM inv_items WHERE archived_at IS NULL ORDER BY name_key, id'),
    db.prepare('SELECT * FROM inv_lots WHERE archived_at IS NULL ORDER BY created_at, id'),
    db.prepare('SELECT id, name, item_id, version FROM inv_aliases WHERE archived_at IS NULL ORDER BY name_key, id'),
    db.prepare('SELECT * FROM inv_calibrations WHERE archived_at IS NULL ORDER BY item_id, id'),
    db.prepare('SELECT measure_profile, version FROM inv_settings WHERE id = 1'),
  ]);
  const setting = (settings.results as SettingsRow[])[0];
  return {
    locations: (locations.results as LocationRow[]).map(location), items: (items.results as ItemRow[]).map(item), lots: (lots.results as LotRow[]).map(lot),
    aliases: (aliases.results as AliasRow[]).map(alias), calibrations: (calibrations.results as CalibrationRow[]).map(calibration),
    settings: { measureProfile: setting?.measure_profile ?? null, version: setting?.version ?? 1 },
  };
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
  const rows = await db.prepare(`SELECT g.seq, g.txn_id, t.kind, t.member_id, g.lot_id, g.item_id, i.name AS item_name, i.dim, g.delta, g.qty_after, g.reason, g.created_at
    FROM inv_ledger g JOIN inv_txns t ON t.id = g.txn_id JOIN inv_items i ON i.id = g.item_id WHERE (? IS NULL OR g.seq < ?) ORDER BY g.seq DESC LIMIT ?`).bind(before, before, limit).all<LedgerRow>();
  return rows.results.map(row => ({ seq: row.seq, txnId: row.txn_id, kind: row.kind, memberId: row.member_id, lotId: row.lot_id, itemId: row.item_id, itemName: row.item_name, dim: row.dim, delta: row.delta, qtyAfter: row.qty_after, reason: row.reason, createdAt: row.created_at }));
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

async function archive(db: Db, table: 'inv_items' | 'inv_locations' | 'inv_aliases' | 'inv_calibrations', rowId: string, expected: number): Promise<{ id: string }> {
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

inventoryRoutes.put('/settings', async c => {
  if (c.get('user').role !== 'admin') throw new ApiError(403, 'Only a family administrator can change the measuring convention.');
  const input = parseInput(schemas.settings, await readJson(c.req.raw));
  try {
    const row = await c.env.DB.prepare(`UPDATE inv_settings SET measure_profile = ?, version = version + 1 WHERE id = 1 AND version = ? AND ${MODULE_ENABLED} RETURNING measure_profile, version`)
      .bind(input.measureProfile, input.version).first<SettingsRow>();
    if (!row) throw new ApiError(409, 'Someone changed this. Refresh to see the latest version.');
    return c.json({ measureProfile: row.measure_profile, version: row.version } satisfies InvSettings);
  } catch (error) { return translate(error); }
});

inventoryRoutes.post('/aliases', async c => {
  const input = parseInput(schemas.alias, await readJson(c.req.raw));
  const target = await loadItem(c.env.DB, input.itemId);
  if (target.archived_at) throw new ApiError(404, 'This item no longer exists.');
  const created: InvAlias = { id: crypto.randomUUID(), name: input.name, itemId: input.itemId, version: 1 };
  await mutate(c.env.DB, [
    guarded(c.env.DB, `NOT (${MODULE_ENABLED})`),
    c.env.DB.prepare('INSERT INTO inv_aliases (id, name, name_key, item_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(created.id, input.name, nameKey(input.name), input.itemId, c.get('user').id, now(), now()),
  ]);
  return c.json(created, 201);
});

inventoryRoutes.post('/aliases/:id/archive', async c => {
  const input = parseInput(schemas.archive, await readJson(c.req.raw));
  return c.json(await archive(c.env.DB, 'inv_aliases', c.req.param('id'), input.version));
});

inventoryRoutes.post('/calibrations', async c => {
  const input = parseInput(schemas.calibration, await readJson(c.req.raw));
  const target = await loadItem(c.env.DB, input.itemId);
  if (target.archived_at) throw new ApiError(404, 'This item no longer exists.');
  const sides = [['from', input.fromAmount, input.fromUnit, input.fromProfile], ['to', input.toAmount, input.toUnit, input.toProfile]] as const;
  const dims: string[] = [];
  for (const [side, amount, unitText, unitProfile] of sides) {
    const parsed = parseQuantity(amount);
    if (!parsed.ok || parsed.value.lo.n === 0n || parsed.value.lo.n * parsed.value.hi.d !== parsed.value.hi.n * parsed.value.lo.d) throw new ApiError(400, `Enter one exact amount above zero for the ${side} side.`);
    const unit = resolveUnit(unitText, unitProfile);
    if (!unit.ok) throw new ApiError(400, unit.reason === 'UNKNOWN_UNIT' ? 'This unit is not recognised.' : 'Cups, spoons and fluid ounces need a measuring convention; “oz” must be written as oz-mass or fl oz.');
    dims.push(unit.unit.dimension);
  }
  if (dims[0] === dims[1]) throw new ApiError(400, 'A conversion links different kinds of measurement, such as a cup (volume) to grams (weight).');
  if (!dims.includes(target.dim)) throw new ApiError(400, `One side must be measured the way this item is stored (${target.dim.startsWith('count:') ? target.dim.slice(6) + ' counts' : target.dim === 'mass' ? 'weight' : 'volume'}).`);
  const created: InvCalibration = { id: crypto.randomUUID(), itemId: input.itemId, fromAmount: input.fromAmount.trim(), fromUnit: input.fromUnit, fromProfile: input.fromProfile ?? null, toAmount: input.toAmount.trim(), toUnit: input.toUnit, toProfile: input.toProfile ?? null, version: 1 };
  await mutate(c.env.DB, [
    guarded(c.env.DB, `NOT (${MODULE_ENABLED})`),
    c.env.DB.prepare(`INSERT INTO inv_calibrations (id, item_id, from_amount, from_unit, from_profile, to_amount, to_unit, to_profile, dims, accepted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(created.id, created.itemId, created.fromAmount, created.fromUnit, created.fromProfile, created.toAmount, created.toUnit, created.toProfile, [...dims].sort().join('|'), c.get('user').id, now(), now()),
  ]);
  return c.json(created, 201);
});

inventoryRoutes.post('/calibrations/:id/archive', async c => {
  const input = parseInput(schemas.archive, await readJson(c.req.raw));
  return c.json(await archive(c.env.DB, 'inv_calibrations', c.req.param('id'), input.version));
});

inventoryRoutes.post('/availability', async c => {
  const input = parseInput(schemas.availability, await readJson(c.req.raw));
  await requireModule(c.env.DB, 'recipes');
  const record = await getRecord(c.env.DB, input.recipeId);
  if (record.kind !== 'recipe') throw new ApiError(404, 'This recipe no longer exists.');
  const recipe = record.data as Recipe;
  if (input.exclude.some(index => index >= recipe.ingredients.length)) throw new ApiError(400, 'Choose ingredients that are in this recipe.');
  const state = await readInventoryState(c.env.DB);
  try {
    return c.json(checkRecipe({
      recipe, servings: input.servings, exclude: input.exclude, items: state.items, lots: state.lots, calibrations: state.calibrations,
      names: new Map(state.aliases.map(row => [nameKey(row.name), row.itemId])), profile: state.settings.measureProfile, today: todayInTimezone(c.get('family').timezone),
    }));
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(422, 'This recipe or pantry is too large to check exactly. Exclude some ingredients and try again.');
    throw error;
  }
});

/** Lots of one item in consumption order: earliest date first, then oldest, then smaller remainders. */
function consumptionOrder(lots: InvLot[]): InvLot[] {
  return [...lots].sort((a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99') || a.createdAt - b.createdAt || a.qty - b.qty || a.id.localeCompare(b.id));
}

async function recipeForConsumption(db: Db, recipeId: string): Promise<{ title: string; recipe: Recipe }> {
  await requireModule(db, 'recipes');
  const record = await getRecord(db, recipeId);
  if (record.kind !== 'recipe') throw new ApiError(404, 'This recipe no longer exists.');
  return { title: (record.data as Recipe).title, recipe: record.data as Recipe };
}

inventoryRoutes.post('/consume/preview', async c => {
  const input = parseInput(schemas.availability, await readJson(c.req.raw));
  const { title, recipe } = await recipeForConsumption(c.env.DB, input.recipeId);
  if (input.exclude.some(index => index >= recipe.ingredients.length)) throw new ApiError(400, 'Choose ingredients that are in this recipe.');
  const state = await readInventoryState(c.env.DB);
  let result;
  try {
    result = checkRecipe({
      recipe, servings: input.servings, exclude: input.exclude, items: state.items, lots: state.lots, calibrations: state.calibrations,
      names: new Map(state.aliases.map(row => [nameKey(row.name), row.itemId])), profile: state.settings.measureProfile, today: todayInTimezone(c.get('family').timezone),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(422, 'This recipe or pantry is too large to check exactly. Exclude some ingredients and try again.');
    throw error;
  }
  const today = todayInTimezone(c.get('family').timezone);
  const lines: ConsumeLine[] = result.items.map(row => {
    const suggested = row.needComplete ? row.need.hi : null;
    let remaining = suggested ?? 0;
    const allocations = consumptionOrder(state.lots.filter(lot => lot.itemId === row.itemId && !isExpired(lot, today))).flatMap(lot => {
      const take = Math.min(remaining, lot.qty);
      remaining -= take;
      return [{ lotId: lot.id, version: lot.version, enteredText: lot.enteredText, locationId: lot.locationId, date: lot.date, dateKind: lot.dateKind, precision: lot.precision, available: lot.qty, take }];
    });
    return { itemId: row.itemId, itemName: row.itemName, dim: row.dim, lineIndexes: row.lineIndexes, reasons: row.reasons, need: row.need, needComplete: row.needComplete, suggested, allocations, shortfall: suggested === null ? 0 : remaining };
  });
  return c.json({ recipeId: input.recipeId, recipeTitle: title, servings: input.servings, lines, unmapped: result.unmapped, excluded: result.excluded } satisfies ConsumePreview);
});

/** Runs a multi-lot batch under the same replay rules as single-lot transactions. */
async function runBatch(db: Db, txn: string, memberId: string, hash: string, build: () => Promise<D1PreparedStatement[]>): Promise<{ lots: InvLot[]; replayed: boolean }> {
  const earlier = await priorTransaction(db, txn, memberId, hash);
  if (earlier) return { lots: earlier, replayed: true };
  try { await db.batch(await build()); } catch (error) {
    const raced = await priorTransaction(db, txn, memberId, hash);
    if (raced) return { lots: raced, replayed: true };
    translate(error);
  }
  const done = await priorTransaction(db, txn, memberId, hash);
  if (!done) throw new ApiError(409, 'Inventory changed. Refresh and try again.');
  return { lots: done, replayed: false };
}

inventoryRoutes.post('/consume', async c => {
  const input = parseInput(schemas.consume, await readJson(c.req.raw));
  const db = c.env.DB;
  const { title, recipe } = await recipeForConsumption(db, input.recipeId);
  const user = c.get('user');
  const takes = [...input.takes].sort((a, b) => a.lotId.localeCompare(b.lotId));
  const shortfalls = [...input.shortfalls].sort((a, b) => a.itemId.localeCompare(b.itemId));
  if (new Set(takes.map(take => take.lotId)).size !== takes.length || new Set(shortfalls.map(row => row.itemId)).size !== shortfalls.length) throw new ApiError(400, 'List each lot and item once.');
  const hash = await digest({ op: 'consume', recipeId: input.recipeId, servings: input.servings, takes, shortfalls });
  const earlier = await priorTransaction(db, input.txnId, user.id, hash);
  if (earlier) return c.json({ lots: earlier, replayed: true, txnId: input.txnId } satisfies ConsumeResult);
  const state = await readInventoryState(db);
  const mapped = new Set(recipe.ingredients.map(ingredient => state.aliases.find(row => nameKey(row.name) === ingredientKey(ingredient.name))?.itemId).filter((value): value is string => Boolean(value)));
  const byLot = new Map(state.lots.map(row => [row.id, row]));
  for (const take of takes) {
    const stored = byLot.get(take.lotId);
    if (!stored || !mapped.has(stored.itemId)) throw new ApiError(409, 'Inventory changed. Refresh and try again.');
    if (take.take > stored.qty) throw new ApiError(409, 'There is less in stock than that. Recount, then try again.');
    if (isExpired(stored, todayInTimezone(c.get('family').timezone))) throw new ApiError(409, 'Some of this stock is past its use-by date. Archive it instead of cooking with it.');
  }
  if (shortfalls.some(row => !mapped.has(row.itemId))) throw new ApiError(400, 'Choose ingredients that are in this recipe.');
  const time = now();
  const json = JSON.stringify(takes.map(take => ({ lotId: take.lotId, version: take.version, take: take.take })));
  const result = await runBatch(db, input.txnId, user.id, hash, async () => [
    db.prepare("INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) VALUES (?, 'adjust', ?, ?, ?)").bind(input.txnId, user.id, hash, time),
    db.prepare('INSERT INTO inv_consumptions (txn_id, recipe_id, recipe_title, servings, shortfalls, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(input.txnId, input.recipeId, title.slice(0, 200), input.servings, JSON.stringify(shortfalls), time),
    guarded(db, `NOT (${MODULE_ENABLED})
      OR (SELECT COUNT(*) FROM json_each(?1)) != (SELECT COUNT(DISTINCT json_extract(value, '$.lotId')) FROM json_each(?1))
      OR EXISTS (SELECT 1 FROM json_each(?1) AS j LEFT JOIN inv_lots AS l ON l.id = json_extract(j.value, '$.lotId')
        WHERE l.id IS NULL OR l.archived_at IS NOT NULL OR l.version != json_extract(j.value, '$.version') OR l.qty < json_extract(j.value, '$.take'))`, json),
    db.prepare(`INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at)
      SELECT ?2, l.id, l.item_id, -json_extract(j.value, '$.take'), l.qty - json_extract(j.value, '$.take'), ?3, ?4
      FROM json_each(?1) AS j JOIN inv_lots AS l ON l.id = json_extract(j.value, '$.lotId')`).bind(json, input.txnId, `Cooked: ${title}`.slice(0, 200), time),
    db.prepare(`UPDATE inv_lots SET qty = inv_lots.qty - json_extract(j.value, '$.take'), version = inv_lots.version + 1, updated_at = ?2
      FROM json_each(?1) AS j WHERE inv_lots.id = json_extract(j.value, '$.lotId')`).bind(json, time),
  ]);
  return c.json({ ...result, txnId: input.txnId } satisfies ConsumeResult, result.replayed ? 200 : 201);
});

inventoryRoutes.post('/txns/:id/undo', async c => {
  const input = parseInput(schemas.undo, await readJson(c.req.raw));
  const db = c.env.DB;
  const target = c.req.param('id');
  const user = c.get('user');
  const hash = await digest({ op: 'undo', target });
  const earlier = await priorTransaction(db, input.txnId, user.id, hash);
  if (earlier) return c.json({ lots: earlier, replayed: true, txnId: input.txnId } satisfies ConsumeResult);
  const header = await db.prepare('SELECT txn_id, reverses_txn_id FROM inv_consumptions WHERE txn_id = ?').bind(target).first<{ txn_id: string; reverses_txn_id: string | null }>();
  if (!header || header.reverses_txn_id) throw new ApiError(404, 'Only a recorded cooking can be undone.');
  if (await db.prepare('SELECT 1 AS found FROM inv_consumptions WHERE reverses_txn_id = ?').bind(target).first()) throw new ApiError(409, 'This was already undone.');
  const rows = await db.prepare('SELECT seq, lot_id, delta, qty_after FROM inv_ledger WHERE txn_id = ?').bind(target).all<{ seq: number; lot_id: string; delta: number; qty_after: number }>();
  const lines = rows.results.filter(row => row.delta < 0).map(row => ({ lotId: row.lot_id, give: -row.delta, seq: row.seq, qtyAfter: row.qty_after }));
  if (!lines.length) throw new ApiError(409, 'There is nothing to put back.');
  const json = JSON.stringify(lines);
  const time = now();
  const result = await runBatch(db, input.txnId, user.id, hash, async () => [
    db.prepare("INSERT INTO inv_txns (id, kind, member_id, request_hash, created_at) VALUES (?, 'adjust', ?, ?, ?)").bind(input.txnId, user.id, hash, time),
    db.prepare(`INSERT INTO inv_consumptions (txn_id, recipe_id, recipe_title, servings, shortfalls, reverses_txn_id, created_at)
      SELECT ?, recipe_id, recipe_title, servings, '[]', txn_id, ? FROM inv_consumptions WHERE txn_id = ? AND reverses_txn_id IS NULL`).bind(input.txnId, time, target),
    // Exact reversal only: each lot must still hold what that cooking left, with no later activity.
    guarded(db, `NOT (${MODULE_ENABLED})
      OR NOT EXISTS (SELECT 1 FROM inv_consumptions WHERE txn_id = ?2 AND reverses_txn_id IS NULL)
      OR EXISTS (SELECT 1 FROM json_each(?1) AS j LEFT JOIN inv_lots AS l ON l.id = json_extract(j.value, '$.lotId')
        WHERE l.id IS NULL OR l.archived_at IS NOT NULL OR l.qty != json_extract(j.value, '$.qtyAfter')
          OR l.qty + json_extract(j.value, '$.give') > ${MAX_STOCK}
          OR EXISTS (SELECT 1 FROM inv_ledger AS g WHERE g.lot_id = l.id AND g.seq > json_extract(j.value, '$.seq')))`, json, target),
    db.prepare(`INSERT INTO inv_ledger (txn_id, lot_id, item_id, delta, qty_after, reason, created_at)
      SELECT ?2, l.id, l.item_id, json_extract(j.value, '$.give'), l.qty + json_extract(j.value, '$.give'), 'Undid cooking', ?3
      FROM json_each(?1) AS j JOIN inv_lots AS l ON l.id = json_extract(j.value, '$.lotId')`).bind(json, input.txnId, time),
    db.prepare(`UPDATE inv_lots SET qty = inv_lots.qty + json_extract(j.value, '$.give'), version = inv_lots.version + 1, updated_at = ?2
      FROM json_each(?1) AS j WHERE inv_lots.id = json_extract(j.value, '$.lotId')`).bind(json, time),
  ]);
  return c.json({ ...result, txnId: input.txnId } satisfies ConsumeResult, result.replayed ? 200 : 201);
});

inventoryRoutes.get('/consumptions', async c => {
  const query = parseInput(z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict(), c.req.query());
  const db = c.env.DB;
  const rows = await db.prepare(`SELECT c.txn_id, c.recipe_id, c.recipe_title, c.servings, c.shortfalls, c.reverses_txn_id, c.created_at, t.member_id, t.rowid AS ordinal,
      (SELECT u.txn_id FROM inv_consumptions u WHERE u.reverses_txn_id = c.txn_id) AS undone_by,
      (c.reverses_txn_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM inv_consumptions u WHERE u.reverses_txn_id = c.txn_id)
        AND NOT EXISTS (SELECT 1 FROM inv_ledger g JOIN inv_lots l ON l.id = g.lot_id WHERE g.txn_id = c.txn_id
          AND (l.archived_at IS NOT NULL OR l.qty != g.qty_after OR EXISTS (SELECT 1 FROM inv_ledger g2 WHERE g2.lot_id = g.lot_id AND g2.seq > g.seq)))) AS can_undo
    FROM inv_consumptions c JOIN inv_txns t ON t.id = c.txn_id WHERE (? IS NULL OR t.rowid < ?) ORDER BY t.rowid DESC LIMIT ?`)
    .bind(query.before ?? null, query.before ?? null, query.limit).all<{ txn_id: string; recipe_id: string | null; recipe_title: string; servings: number; shortfalls: string; reverses_txn_id: string | null; created_at: number; member_id: string; ordinal: number; undone_by: string | null; can_undo: number }>();
  const ids = rows.results.map(row => row.txn_id);
  const lines = ids.length ? await db.prepare(`SELECT g.txn_id, g.lot_id, g.item_id, i.name AS item_name, i.dim, g.delta FROM inv_ledger g JOIN inv_items i ON i.id = g.item_id WHERE g.txn_id IN (SELECT value FROM json_each(?)) ORDER BY g.seq`).bind(JSON.stringify(ids)).all<{ txn_id: string; lot_id: string; item_id: string; item_name: string; dim: StockDimension; delta: number }>() : { results: [] };
  const names = new Map((await db.prepare('SELECT id, name, dim FROM inv_items').all<ItemRow>()).results.map(row => [row.id, row]));
  const entries: InvConsumption[] = rows.results.map(row => ({
    txnId: row.txn_id, recipeId: row.recipe_id, recipeTitle: row.recipe_title, servings: row.servings, memberId: row.member_id, createdAt: row.created_at,
    lots: lines.results.filter(line => line.txn_id === row.txn_id).map(line => ({ lotId: line.lot_id, itemId: line.item_id, itemName: line.item_name, dim: line.dim, delta: line.delta })),
    shortfalls: (JSON.parse(row.shortfalls) as { itemId: string; amount: number }[]).flatMap(entry => { const known = names.get(entry.itemId); return known ? [{ itemId: entry.itemId, itemName: known.name, dim: known.dim, amount: entry.amount }] : []; }), undoneBy: row.undone_by, canUndo: row.can_undo === 1, reverses: row.reverses_txn_id,
  }));
  return c.json({ entries, next: entries.length === query.limit ? rows.results[rows.results.length - 1].ordinal : null });
});
