import { kindModule, moduleIds } from '../shared/types';
import type { FamilyCapacity, FamilyRecord, ModuleConfig, ModuleId, QuestionPair, RecordDataMap, RecordKind, User } from '../shared/types';
import { canViewAnswer, sameQuestionPair } from '../shared/question-pairing';
import { familyCapacity } from '../shared/capacity';
import { ApiError } from './env';

type RecordRow = { id: string; kind: RecordKind; owner_id: string; data: string; created_at: string; updated_at: string; version: number };
type ModuleRow = { id: ModuleId; enabled: number };
type StorageRow = { data_bytes: number; record_count: number };
const decode = (row: RecordRow): FamilyRecord => ({ id: row.id, kind: row.kind, ownerId: row.owner_id, data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at, version: row.version }) as FamilyRecord;

function moduleSettings(rows: ModuleRow[]): ModuleConfig[] {
  const settings = new Map(rows.map(row => [row.id, row.enabled === 1]));
  // A missing row means enabled for original modules; inventory is opt-in and stays off.
  return moduleIds.map(id => ({ id, enabled: settings.get(id) ?? id !== 'inventory' }));
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

export function visibleRecords(records: FamilyRecord[], user: User, members: User[], modules: ModuleConfig[], questionPair: QuestionPair | null): FamilyRecord[] {
  const enabled = new Set(modules.filter(module => module.enabled).map(module => module.id));
  const answersByQuestion = new Map<string, FamilyRecord<'answer'>[]>();
  for (const record of records) {
    if (record.kind !== 'answer') continue;
    const key = `${record.data.date}:${record.data.questionId}`;
    const answers = answersByQuestion.get(key) || [];
    answers.push(record);
    answersByQuestion.set(key, answers);
  }
  return records.filter(record => {
    if (!enabled.has(kindModule[record.kind])) return false;
    if (record.kind === 'mood') return record.ownerId === user.id || record.data.shared;
    if (record.kind === 'answer') return canViewAnswer(record, answersByQuestion.get(`${record.data.date}:${record.data.questionId}`) || [], user.id, questionPair, members);
    return true;
  });
}

export async function readFamilySnapshot(db: D1Database, user: User, members: User[], questionPair: QuestionPair | null): Promise<{ modules: ModuleConfig[]; records: FamilyRecord[]; capacity: FamilyCapacity }> {
  // Keep visibility, records and whole-family capacity on the same D1 snapshot.
  const [settings, rows, storage] = await db.batch([
    db.prepare('SELECT id, enabled FROM modules'),
    db.prepare('SELECT * FROM records ORDER BY created_at DESC, id DESC'),
    db.prepare('SELECT data_bytes, record_count FROM family_storage WHERE id = 1'),
  ]);
  const usage = (storage.results as StorageRow[])[0];
  if (!usage) throw new ApiError(503, 'Family storage is not configured.');
  const modules = moduleSettings(settings.results as ModuleRow[]);
  const records = visibleRecords((rows.results as RecordRow[]).map(decode), user, members, modules, questionPair);
  return { modules, records, capacity: familyCapacity(usage.data_bytes, usage.record_count) };
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
  const answer = kind === 'answer' ? data as RecordDataMap['answer'] : null;
  if (answer && (!sameQuestionPair(answer.participantIds, answer.participantIds) || !answer.participantIds?.includes(user.id))) throw new ApiError(400, 'Choose the currently configured question pair.');
  // Recheck the partner's scope inside the atomic insert: a concurrent request using
  // an older deployment configuration must not bind this day to a different pair.
  const pairGuard = answer ? `AND NOT EXISTS (
    SELECT 1 FROM records WHERE kind = 'answer' AND json_extract(data, '$.date') = ? AND owner_id IN (?, ?)
    AND (json_type(data, '$.participantIds') IS NOT 'array' OR COALESCE(json_array_length(data, '$.participantIds'), 0) != 2
      OR NOT (COALESCE(json_extract(data, '$.participantIds[0]') = ? AND json_extract(data, '$.participantIds[1]') = ?, 0)
        OR COALESCE(json_extract(data, '$.participantIds[0]') = ? AND json_extract(data, '$.participantIds[1]') = ?, 0)))
  )` : '';
  const participants = answer?.participantIds;
  const pairBindings = answer && participants ? [answer.date, participants[0], participants[1], participants[0], participants[1], participants[1], participants[0]] : [];
  try {
    const result = await db.prepare(`INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version)
      SELECT ?, ?, ?, ?, ?, ?, 1
      WHERE COALESCE((SELECT enabled FROM modules WHERE id = ?), 1) = 1
      AND (? IS NULL OR EXISTS (SELECT 1 FROM records WHERE id = ? AND kind = 'habit' AND owner_id = ?))
      ${pairGuard}
      RETURNING id`)
      .bind(record.id, kind, user.id, JSON.stringify(data), now, now, kindModule[kind], habitId, habitId, user.id, ...pairBindings).first<{ id: string }>();
    if (!result) throw new ApiError(409, 'This change is no longer available. Refresh and try again.');
    return record;
  } catch (error) { return translateConstraint(error); }
}

/**
 * Creates a habit and its retroactive check-ins in one D1 batch: any failure (storage limit,
 * disabled module, duplicate day) rolls back the habit too, so a backdated habit is never half-made.
 */
export async function createHabitWithHistory(db: D1Database, user: User, data: RecordDataMap['habit'], dates: string[]): Promise<FamilyRecord<'habit'>> {
  const now = new Date().toISOString();
  const habit = { id: crypto.randomUUID(), kind: 'habit', ownerId: user.id, data, createdAt: now, updatedAt: now, version: 1 } as FamilyRecord<'habit'>;
  const logs = dates.map(date => ({ id: crypto.randomUUID(), data: JSON.stringify({ habitId: habit.id, date } satisfies RecordDataMap['habitLog']) }));
  const enabled = "COALESCE((SELECT enabled FROM modules WHERE id = 'streaks'), 1) = 1";
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) SELECT ?, 'habit', ?, ?, ?, ?, 1 WHERE ${enabled} RETURNING id`)
        .bind(habit.id, user.id, JSON.stringify(data), now, now),
      db.prepare(`INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version)
        SELECT json_extract(j.value, '$.id'), 'habitLog', ?, json_extract(j.value, '$.data'), ?, ?, 1 FROM json_each(?) AS j
        WHERE ${enabled} AND EXISTS (SELECT 1 FROM records WHERE id = ? AND kind = 'habit' AND owner_id = ?) RETURNING id`)
        .bind(user.id, now, now, JSON.stringify(logs), habit.id, user.id),
    ]);
    if (results[0].results.length !== 1 || results[1].results.length !== logs.length) throw new ApiError(409, 'This change is no longer available. Refresh and try again.');
    return habit;
  } catch (error) {
    if (error instanceof Error && /FAMILY_STORAGE_LIMIT/.test(error.message)) throw new ApiError(409, `There isn’t room for ${logs.length} days of history (each day is one record). Choose a later start date, or remove older items first.`);
    return translateConstraint(error);
  }
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
