import { kindModule, moduleIds } from '../shared/types';
import type { FamilyRecord, ModuleConfig, ModuleId, RecordDataMap, RecordKind, User } from '../shared/types';
import { ApiError } from './env';

type RecordRow = { id: string; kind: RecordKind; owner_id: string; data: string; created_at: string; updated_at: string; version: number };
type ModuleRow = { id: ModuleId; enabled: number };
const decode = (row: RecordRow): FamilyRecord => ({ id: row.id, kind: row.kind, ownerId: row.owner_id, data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at, version: row.version }) as FamilyRecord;

function moduleSettings(rows: ModuleRow[]): ModuleConfig[] {
  const settings = new Map(rows.map(row => [row.id, row.enabled === 1]));
  return moduleIds.map(id => ({ id, enabled: settings.get(id) ?? true }));
}

export async function requireModule(db: D1Database, module: ModuleId): Promise<void> {
  const row = await db.prepare('SELECT enabled FROM modules WHERE id = ?').bind(module).first<{ enabled: number }>();
  if (row?.enabled === 0) throw new ApiError(403, 'This module is disabled.');
}

export async function getRecord(db: D1Database, id: string): Promise<FamilyRecord> {
  const row = await db.prepare('SELECT * FROM records WHERE id = ?').bind(id).first<RecordRow>();
  if (!row) throw new ApiError(404, 'This item no longer exists.');
  return decode(row);
}

export function visibleRecords(records: FamilyRecord[], user: User, members: User[], modules: ModuleConfig[]): FamilyRecord[] {
  const enabled = new Set(modules.filter(module => module.enabled).map(module => module.id));
  const answers = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.kind !== 'answer') continue;
    const key = `${record.data.date}:${record.data.questionId}`;
    const owners = answers.get(key) || new Set<string>();
    owners.add(record.ownerId);
    answers.set(key, owners);
  }
  return records.filter(record => {
    if (!enabled.has(kindModule[record.kind])) return false;
    if (record.kind === 'mood') return record.ownerId === user.id || record.data.shared;
    if (record.kind === 'answer') {
      if (record.ownerId === user.id) return true;
      if (!members.some(member => member.id === record.ownerId)) return false;
      const owners = answers.get(`${record.data.date}:${record.data.questionId}`);
      return members.every(member => owners?.has(member.id));
    }
    return true;
  });
}

export async function readFamilySnapshot(db: D1Database, user: User, members: User[]): Promise<{ modules: ModuleConfig[]; records: FamilyRecord[] }> {
  // One D1 transaction keeps module visibility and records on the same snapshot.
  const [settings, rows] = await db.batch([
    db.prepare('SELECT id, enabled FROM modules'),
    db.prepare('SELECT * FROM records ORDER BY created_at DESC, id DESC'),
  ]);
  const modules = moduleSettings(settings.results as ModuleRow[]);
  const records = visibleRecords((rows.results as RecordRow[]).map(decode), user, members, modules);
  return { modules, records };
}

export function requireOwnership(record: FamilyRecord, user: User): void {
  if (['mood', 'answer', 'profile', 'habit', 'habitLog'].includes(record.kind) && record.ownerId !== user.id) throw new ApiError(403, 'Only the owner can change this item.');
}

function translateConstraint(error: unknown): never {
  if (error instanceof Error && /FAMILY_STORAGE_LIMIT/.test(error.message)) throw new ApiError(409, 'Family storage is full (8 MB or 10,000 items). Export and remove older items to make room.');
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new ApiError(409, 'An item already exists for this member and day. Refresh before trying again.');
  throw error;
}

export async function createRecord<K extends RecordKind>(db: D1Database, user: User, kind: K, data: RecordDataMap[K]): Promise<FamilyRecord> {
  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), kind, ownerId: user.id, data, createdAt: now, updatedAt: now, version: 1 } as FamilyRecord;
  const habitId = kind === 'habitLog' ? (data as RecordDataMap['habitLog']).habitId : null;
  try {
    const result = await db.prepare(`INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version)
      SELECT ?, ?, ?, ?, ?, ?, 1
      WHERE COALESCE((SELECT enabled FROM modules WHERE id = ?), 1) = 1
      AND (? IS NULL OR EXISTS (SELECT 1 FROM records WHERE id = ? AND kind = 'habit' AND owner_id = ?))
      RETURNING id`)
      .bind(record.id, kind, user.id, JSON.stringify(data), now, now, kindModule[kind], habitId, habitId, user.id).first<{ id: string }>();
    if (!result) throw new ApiError(409, 'This change is no longer available. Refresh and try again.');
    return record;
  } catch (error) { return translateConstraint(error); }
}

export async function updateRecord(db: D1Database, record: FamilyRecord, data: RecordDataMap[RecordKind], version: number): Promise<FamilyRecord> {
  const updatedAt = new Date().toISOString();
  const habitId = record.kind === 'habitLog' ? (data as RecordDataMap['habitLog']).habitId : null;
  try {
    const result = await db.prepare(`UPDATE records SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?
      AND COALESCE((SELECT enabled FROM modules WHERE id = ?), 1) = 1
      AND (? IS NULL OR EXISTS (SELECT 1 FROM records WHERE id = ? AND kind = 'habit' AND owner_id = ?))
      RETURNING id`)
      .bind(JSON.stringify(data), updatedAt, record.id, version, kindModule[record.kind], habitId, habitId, record.ownerId).first<{ id: string }>();
    if (!result) throw new ApiError(409, 'Someone changed this item. Refresh to see the latest version.');
    return { ...record, data, updatedAt, version: version + 1 } as FamilyRecord;
  } catch (error) { return translateConstraint(error); }
}

export async function deleteRecord(db: D1Database, record: FamilyRecord, version: number): Promise<void> {
  const deletion = db.prepare(`DELETE FROM records WHERE id = ? AND version = ? AND COALESCE((SELECT enabled FROM modules WHERE id = ?), 1) = 1 RETURNING id`).bind(record.id, version, kindModule[record.kind]);
  if (record.kind === 'habit') {
    // D1 batches are atomic. Logs disappear only if the matching parent version still exists.
    const results = await db.batch([
      db.prepare(`DELETE FROM records WHERE kind = 'habitLog' AND json_extract(data, '$.habitId') = ?
        AND EXISTS (SELECT 1 FROM records WHERE id = ? AND version = ?)
        AND COALESCE((SELECT enabled FROM modules WHERE id = 'streaks'), 1) = 1`).bind(record.id, record.id, version),
      deletion,
    ]);
    if (results[1].results.length !== 1) throw new ApiError(409, 'Someone changed this item. Refresh to see the latest version.');
  } else {
    const result = await deletion.first<{ id: string }>();
    if (!result) throw new ApiError(409, 'Someone changed this item. Refresh to see the latest version.');
  }
}

export async function consumeLimit(db: D1Database, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<void> {
  const windowStart = Math.floor(now / (windowSeconds * 1000));
  const result = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start,
    count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END
    RETURNING count`).bind(key, windowStart).first<{ count: number }>();
  if (!result || result.count > limit) throw new ApiError(429, 'Too many requests. Please try again later.');
}
