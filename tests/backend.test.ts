import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import app from '../src/server/index';
import type { Env } from '../src/server/env';
import type { Answer, Bootstrap, FamilyRecord, User } from '../src/shared/types';
import { questionForDate } from '../src/shared/questions';
import { consumeLimit, createRecord, getRecord, readFamilySnapshot, updateRecord } from '../src/server/db';
import { validateData } from '../src/server/validation';
import { gzipSync } from 'node:zlib';
import { scalingRecords } from './fixtures/scaling';

/** Real SQLite executes the production SQL; this adapter only models D1's result shape. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  class Statement {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async first() { return sqlite.prepare(this.sql).get(...this.values as (string | number | null)[]) ?? null; }
    async all() {
      const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n);
      const results = sqlite.prepare(this.sql).all(...this.values as (string | number | null)[]);
      return { results, success: true, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n) - before } };
    }
    async run() { return this.all(); }
  }
  const adapter = {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db: adapter as unknown as D1Database, sqlite, close: () => sqlite.close() };
}

const members: User[] = [
  { id: 'alex', name: 'Alex', role: 'admin', color: '#38634A' },
  { id: 'sam', name: 'Sam', role: 'member', color: '#A96743' },
];
let env: Env;
let fixture: ReturnType<typeof database>;
const base = 'http://localhost:8787';
const task = { title: 'Buy apples', done: false };
const lee: User = { id: 'lee', name: 'Lee', role: 'admin', color: '#555555' };
const answerData = (date = '2026-01-01', changes: Partial<Answer> = {}): Answer => ({ date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'], ...changes });

const sessionTokens = new Map<string, string>();
let activeMembers: User[] = [];
function setMembers(roster: User[]) {
  activeMembers = roster;
  const now = Math.floor(Date.now() / 1000);
  fixture.sqlite.exec("UPDATE auth_members SET status = 'suspended'");
  for (const member of roster) {
    fixture.sqlite.prepare(`INSERT INTO auth_members (id,name,role,color,status,user_handle,created_at,updated_at)
      VALUES (?,?,?,?,'active',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,color=excluded.color,status='active'`)
      .run(member.id,member.name,member.role,member.color,createHash('sha256').update(randomBytes(32)).digest('base64url'),now,now);
    if (!sessionTokens.has(member.id)) {
      const token = createHash('sha256').update(randomBytes(32)).digest('base64url');
      const hash = createHash('sha256').update(token).digest('base64url');
      sessionTokens.set(member.id, token);
      fixture.sqlite.prepare(`INSERT INTO auth_credentials (id,member_id,public_key,counter,transports,backup_eligible,backed_up,created_at)
        VALUES (?,?, 'cHVibGlj',0,'[]',0,0,?)`).run(`test-${member.id}`,member.id,now);
      fixture.sqlite.prepare(`INSERT INTO auth_sessions (token_hash,member_id,credential_id,created_at,last_seen_at,expires_at,reauthenticated_at)
        VALUES (?,?,?,?,?,?,?)`).run(hash,member.id,`test-${member.id}`,now,now,now+86400,now);
    }
  }
}

function request(path: string, options: { method?: string; body?: unknown; user?: string; headers?: Record<string, string>; url?: string; configuration?: Partial<Env> } = {}) {
  return app.request(`${options.url || base}${path}`, {
    method: options.method || 'GET',
    headers: { Origin: base, 'Content-Type': 'application/json', Cookie: `__Host-hearth_session=${sessionTokens.get(options.user || activeMembers[0]?.id || '') || ''}`, ...options.headers },
    ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  }, { ...env, ...options.configuration });
}
async function create(kind: string, data: unknown, user?: string): Promise<FamilyRecord> {
  const response = await request('/api/records', { method: 'POST', body: { kind, data }, user });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FamilyRecord>;
}
async function records(user?: string) { return ((await (await request('/api/bootstrap', { user })).json()) as Bootstrap).records; }
async function seedNotes(count: number, prefix = 'note') {
  await env.DB.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?)
    INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version)
    SELECT ? || n, 'note', 'alex', ?, '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z', 1 FROM sequence`)
    .bind(count, prefix, JSON.stringify({ date: '2026-01-01', text: 'A preserved note' })).run();
}
async function legacyAnswer(user = members[0], changes: Partial<Answer> = {}) {
  const data = answerData('2026-01-01', { participantIds: undefined, ...changes });
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .bind(id, 'answer', user.id, JSON.stringify(data), '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z').run();
  return await getRecord(env.DB, id) as FamilyRecord<'answer'>;
}

beforeEach(() => {
  fixture = database();
  env = { DB: fixture.db, WEBAUTHN_RP_ID: 'localhost', FAMILY_TIMEZONE: 'UTC', APP_ORIGIN: base };
  sessionTokens.clear();
  setMembers(members);
});
afterEach(() => { fixture.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('authentication and request boundaries', () => {
  it('exposes minimal health while unconfigured private API fails closed', async () => {
    expect((await request('/api/health', { configuration: { APP_ORIGIN: undefined } })).status).toBe(200);
    const response = await request('/api/bootstrap', { configuration: { APP_ORIGIN: undefined } });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it('requires a valid session even on loopback', async () => {
    expect((await request('/api/bootstrap', { user: 'outsider' })).status).toBe(401);
    expect((await request('/api/bootstrap', { headers: { Cookie: '' } })).status).toBe(401);
  });
  it('rejects cross-origin mutations and non-JSON requests', async () => {
    for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string,string>[]) {
      expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task }, headers })).status).toBe(403);
    }
    expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect(await records()).toHaveLength(0);
  });
  it('rejects invalid deployment timezone', async () => {
    expect((await request('/api/bootstrap', { configuration: { FAMILY_TIMEZONE: 'not/a-zone' } })).status).toBe(503);
  });
});

describe('persistent records, validation, and optimistic concurrency', () => {
  it('creates server-owned records and permits shared task edits with version checks', async () => {
    const item = await create('task', task);
    expect(item.ownerId).toBe('alex');
    expect(item.version).toBe(1);
    const update = await request(`/api/records/${item.id}`, { method: 'PATCH', user: 'sam', body: { data: { ...task, done: true }, version: 1 } });
    expect(update.status).toBe(200);
    expect(((await update.json()) as FamilyRecord).version).toBe(2);
    expect((await request(`/api/records/${item.id}`, { method: 'PATCH', body: { data: task, version: 1 } })).status).toBe(409);
    expect((await request(`/api/records/${item.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(409);
    expect((await request(`/api/records/${item.id}`, { method: 'DELETE', body: { version: 2 } })).status).toBe(200);
    expect(await records()).toHaveLength(0);
  });

  it('rejects unknown fields, impossible dates, unknown assignees, and oversized bodies', async () => {
    const invalid = [
      { kind: 'task', data: { ...task, ownerId: 'sam' } },
      { kind: 'task', data: task, ownerId: 'sam' },
      { kind: 'task', data: { ...task, dueDate: '2025-02-30' } },
      { kind: 'task', data: { ...task, assigneeId: 'stranger' } },
      { kind: 'mood', data: { date: '2200-01-01', score: 3, note: '', shared: false } },
      { kind: 'invalid', data: task },
    ];
    for (const body of invalid) expect((await request('/api/records', { method: 'POST', body })).status).toBe(400);
    expect((await request('/api/records', { method: 'POST', body: '{malformed' })).status).toBe(400);
    expect((await request('/api/records', { method: 'POST', body: 'x'.repeat(65_537) })).status).toBe(413);
  });

  it('rejects invalid ingredient ranges and preserves valid ranges', () => {
    const recipe = { title: 'Soup', description: '', servings: 2, prepMinutes: 0, cookMinutes: 10, ingredients: [{ name: 'Carrots', quantity: 2, quantityMax: 4, unit: '' }], steps: ['Cook'], tags: [], favorite: false };
    expect(validateData('recipe', recipe).ingredients[0].quantityMax).toBe(4);
    expect(() => validateData('recipe', { ...recipe, ingredients: [{ ...recipe.ingredients[0], quantityMax: 1 }] })).toThrow();
  });

  it('enforces unique member/day records in the database', async () => {
    const mood = { date: '2026-01-01', score: 4, note: 'Quiet', shared: false };
    await create('mood', mood);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'mood', data: mood } })).status).toBe(409);
    await create('mood', mood, 'sam');
  });

  it('limits imports before expensive processing and resets quotas in a new window', async () => {
    await consumeLimit(env.DB, 'test', 2, 60, 0);
    await consumeLimit(env.DB, 'test', 2, 60, 0);
    await expect(consumeLimit(env.DB, 'test', 2, 60, 0)).rejects.toMatchObject({ status: 429 });
    await expect(consumeLimit(env.DB, 'test', 2, 60, 60_000)).resolves.toBeUndefined();
  });

  it('keeps member and deployment import quotas in separate namespaces', async () => {
    setMembers([{ ...members[0], id: 'family' }, members[1]]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request('/api/recipes/import', { method: 'POST', body: { mode: 'text', value: '1 cup rice. Boil until soft.' } });
      expect(response.status).not.toBe(429);
    }
    expect((await request('/api/recipes/import', { method: 'POST', body: { mode: 'text', value: '1 cup rice. Boil until soft.' } })).status).toBe(429);
    expect((await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'deployment:imports'").first<{ count: number }>())?.count).toBe(10);
  });

  it('enforces the aggregate byte budget atomically and releases capacity on deletion', async () => {
    const note = { date: '2026-01-01', text: '🌳'.repeat(2399) };
    validateData('note', note);
    const size = new TextEncoder().encode(JSON.stringify(note)).byteLength;
    const maximum = Math.floor(8_388_608 / size);
    let last: FamilyRecord | undefined;
    for (let count = 0; count < maximum; count += 1) last = await createRecord(env.DB, members[0], 'note', note);
    await expect(createRecord(env.DB, members[0], 'note', note)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('storage is full') });
    const stored = await env.DB.prepare('SELECT data_bytes, record_count FROM family_storage').first<{ data_bytes: number; record_count: number }>();
    expect(stored).toMatchObject({ data_bytes: maximum * size, record_count: maximum });
    expect((await readFamilySnapshot(env.DB, members[0], members, ['alex', 'sam'])).capacity).toBe('near-limit');
    const enlarged = { ...note, text: '🌳'.repeat(2499) };
    validateData('note', enlarged);
    // Fill the remaining room so an otherwise valid update cannot cross the aggregate limit.
    const remainder = 8_388_608 - stored!.data_bytes;
    const fillerBytes = remainder - JSON.stringify({ ...note, text: '' }).length;
    expect(fillerBytes).toBeGreaterThan(0);
    const filler = { ...note, text: '🌳'.repeat(Math.floor(fillerBytes / 4)) + 'x'.repeat(fillerBytes % 4) };
    validateData('note', filler);
    await createRecord(env.DB, members[0], 'note', filler);
    expect(await env.DB.prepare('SELECT data_bytes FROM family_storage WHERE id = 1').first()).toEqual({ data_bytes: 8_388_608 });
    expect((await readFamilySnapshot(env.DB, members[0], members, ['alex', 'sam'])).capacity).toBe('full');
    await expect(updateRecord(env.DB, last!, enlarged, 1)).rejects.toMatchObject({ status: 409 });
    expect((await getRecord(env.DB, last!.id)).version).toBe(1);
    await request(`/api/records/${last!.id}`, { method: 'DELETE', body: { version: 1 } });
    expect((await readFamilySnapshot(env.DB, members[0], members, ['alex', 'sam'])).capacity).toBe('near-limit');
    await expect(createRecord(env.DB, members[0], 'note', note)).resolves.toMatchObject({ version: 1 });
  });

  it('checks module state again inside the write after earlier validation', async () => {
    const item = await create('task', task);
    await request('/api/modules/tasks', { method: 'PATCH', body: { enabled: false } });
    await expect(createRecord(env.DB, members[0], 'task', task)).rejects.toMatchObject({ status: 409 });
    await expect(updateRecord(env.DB, item, { ...task, done: true }, 1)).rejects.toMatchObject({ status: 409 });
    expect((await getRecord(env.DB, item.id)).version).toBe(1);
  });
});

describe('coarse family capacity', () => {
  it('changes at the item warning and full boundaries, and releases capacity after deletion', async () => {
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('available');
    await seedNotes(7999);
    expect((await request('/api/modules/notes', { method: 'PATCH', body: { enabled: false } })).status).toBe(200);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('available');
    const warningItem = await create('task', task);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('near-limit');
    expect((await request(`/api/records/${warningItem.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('available');

    await seedNotes(2000, 'more');
    const finalItem = await create('task', task);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('full');
    expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task } })).status).toBe(409);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('full');
    expect((await request(`/api/records/${finalItem.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('near-limit');
  });

  it('includes disabled and private records without disclosing hidden details or exact usage', async () => {
    await seedNotes(7998);
    expect((await request('/api/modules/notes', { method: 'PATCH', body: { enabled: false } })).status).toBe(200);
    const mood = await create('mood', { date: '2026-01-01', score: 2, note: 'Private thoughts', shared: false }, 'sam');
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).capacity).toBe('available');
    const answer = await create('answer', answerData(), 'sam');
    for (const path of ['/api/bootstrap', '/api/export']) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const snapshot = await response.json() as Bootstrap;
      expect(snapshot.capacity).toBe('near-limit');
      expect(snapshot.records).toEqual([]);
      const keys = ['user', 'members', 'modules', 'records', 'capacity', 'timezone', 'questionPair'];
      if (path === '/api/export') keys.push('schemaVersion', 'exportedAt', 'scope');
      expect(Object.keys(snapshot).sort()).toEqual(keys.sort());
      const ownerSnapshot = await (await request(path, { user: 'sam' })).json() as Bootstrap;
      expect(ownerSnapshot.capacity).toBe(snapshot.capacity);
      expect(ownerSnapshot.records.map(record => record.id).sort()).toEqual([mood.id, answer.id].sort());
    }
  });

  it('does not report spare capacity when the storage counter is missing', async () => {
    await env.DB.prepare('DELETE FROM family_storage WHERE id = 1').run();
    const response = await request('/api/bootstrap');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Family storage is not configured.' });
  });
});

describe('conditional member-visible bootstrap', () => {
  async function tag(user?: string) {
    const response = await request('/api/bootstrap', { user });
    expect(response.status).toBe(200);
    const value = response.headers.get('ETag');
    expect(value).toMatch(/^W\/"hearth-[a-f0-9]{64}"$/);
    return value!;
  }

  it('returns bodyless no-store responses only for matching validators and keeps exports complete', async () => {
    await create('task', task);
    const validator = await tag();
    for (const header of [validator, validator.slice(2), `"other", ${validator}`, '*']) {
      const response = await request('/api/bootstrap', { headers: { 'If-None-Match': header } });
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
      expect(response.headers.get('ETag')).toBe(validator);
      expect(response.headers.get('Cache-Control')).toBe('no-store, private');
      expect(response.headers.get('Vary')).toContain('Cookie');
    }
    for (const header of ['"other"', 'garbage', validator.slice(0, -1)]) {
      const response = await request('/api/bootstrap', { headers: { 'If-None-Match': header } });
      expect(response.status).toBe(200);
      expect((await response.json() as Bootstrap).records).toHaveLength(1);
    }
    const exported = await request('/api/export', { headers: { 'If-None-Match': validator } });
    expect(exported.status).toBe(200);
    expect((await exported.json() as Bootstrap).records).toHaveLength(1);
  });

  it('invalidates on visible create, edit, deletion and module changes', async () => {
    let validator = await tag();
    async function changed() {
      const response = await request('/api/bootstrap', { headers: { 'If-None-Match': validator } });
      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).not.toBe(validator);
      validator = response.headers.get('ETag')!;
    }
    const record = await create('task', task);
    await changed();
    expect((await request(`/api/records/${record.id}`, { method: 'PATCH', body: { version: 1, data: { ...task, done: true } } })).status).toBe(200);
    await changed();
    expect((await request('/api/modules/tasks', { method: 'PATCH', body: { enabled: false } })).status).toBe(200);
    await changed();
    expect((await request('/api/modules/tasks', { method: 'PATCH', body: { enabled: true } })).status).toBe(200);
    await changed();
    expect((await request(`/api/records/${record.id}`, { method: 'DELETE', body: { version: 2 } })).status).toBe(200);
    await changed();
  });

  it('does not expose hidden activity through validators and binds them to the current viewer', async () => {
    const validator = await tag();
    await create('mood', { date: '2026-01-01', score: 2, note: 'Not visible to Alex', shared: false }, members[1].id);
    await create('answer', answerData(), members[1].id);
    expect(await tag()).toBe(validator);
    const sam = await request('/api/bootstrap', { user: members[1].id, headers: { 'If-None-Match': validator } });
    expect(sam.status).toBe(200);
    expect((await sam.json() as Bootstrap).records).toHaveLength(2);
    expect(sam.headers.get('ETag')).not.toBe(validator);
    await request('/api/modules/notes', { method: 'PATCH', body: { enabled: false } });
    const paused = await tag();
    await seedNotes(5);
    expect(await tag()).toBe(paused);
    // Only the intentionally shared capacity bucket may signal hidden growth.
    await seedNotes(7993, 'hidden-growth');
    const warning = await request('/api/bootstrap', { headers: { 'If-None-Match': paused } });
    expect(warning.status).toBe(200);
    expect(await warning.json()).toMatchObject({ capacity: 'near-limit', records: [] });
  });

  it('revalidates question reveal, withdrawal and configuration-dependent audiences', async () => {
    const other = await create('answer', answerData(), members[1].id);
    const waiting = await tag();
    const own = await create('answer', answerData());
    const revealed = await request('/api/bootstrap', { headers: { 'If-None-Match': waiting } });
    expect(revealed.status).toBe(200);
    expect((await revealed.json() as Bootstrap).records.map(record => record.id).sort()).toEqual([own.id, other.id].sort());
    const validator = revealed.headers.get('ETag')!;
    const unpaired = await request('/api/bootstrap', { headers: { 'If-None-Match': validator }, configuration: { FAMILY_QUESTION_PAIR: 'null' } });
    expect(unpaired.status).toBe(200);
    expect((await unpaired.json() as Bootstrap).records.map(record => record.id)).toEqual([own.id]);
    expect((await request(`/api/records/${own.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    const withdrawn = await request('/api/bootstrap', { headers: { 'If-None-Match': validator } });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json() as Bootstrap).records).toEqual([]);
  });

  it('includes family configuration and rechecks sessions before returning 304', async () => {
    const validator = await tag();
    const headers = { 'If-None-Match': validator };
    expect((await request('/api/bootstrap', { headers, configuration: { FAMILY_TIMEZONE: 'Europe/London' } })).status).toBe(200);
    setMembers(members.map(member => ({ ...member, name: member.name + ' Updated' })));
    expect((await request('/api/bootstrap', { headers })).status).toBe(200);
    expect((await request('/api/bootstrap', { headers, user: 'outsider' })).status).toBe(401);
    expect((await request('/api/bootstrap', { headers, configuration: { APP_ORIGIN: undefined } })).status).toBe(503);
    setMembers([members[1], lee]);
    expect((await request('/api/bootstrap', { headers, user: 'alex' })).status).toBe(401);
  });

  it.each([{ years: 2, days: 730, habits: 4, count: 6616 }, { years: 5, days: 1825, habits: 1, count: 9898 }])('bounds unchanged refresh bodies for a $years-year family fixture', async ({ years, days, habits, count }) => {
    const rows = scalingRecords(days, habits);
    expect(rows).toHaveLength(count);
    for (const record of rows) validateData(record.kind, record.data);
    await env.DB.batch(rows.map(record => env.DB.prepare('INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(record.id, record.kind, record.ownerId, JSON.stringify(record.data), record.createdAt, record.updatedAt)));
    const usage = await env.DB.prepare('SELECT data_bytes, record_count FROM family_storage WHERE id = 1').first<{ data_bytes: number; record_count: number }>();
    expect(usage!.data_bytes).toBeLessThan(8_388_608);
    expect(usage!.record_count).toBe(count);
    const full = await request('/api/bootstrap');
    expect(full.status).toBe(200);
    const json = await full.text();
    expect((JSON.parse(json) as Bootstrap).records).toHaveLength(count);
    const validator = full.headers.get('ETag')!;
    const durations: number[] = [];
    const queries = vi.spyOn(env.DB, 'prepare');
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const response = await request('/api/bootstrap', { headers: { 'If-None-Match': validator } });
      expect(response.status).toBe(304);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      durations.push(performance.now() - start);
    }
    // Conditional transfer does not pretend to eliminate whole-snapshot reads.
    expect(queries.mock.calls.filter(([sql]) => sql === 'SELECT * FROM records ORDER BY created_at DESC, id DESC')).toHaveLength(3);
    if (process.env.HEARTH_MEASURE_REFRESH) console.log('Refresh fixture measurement', { years, count, dataBytes: usage!.data_bytes, fullBodyBytes: Buffer.byteLength(json), syntheticGzipBytes: gzipSync(json).byteLength, unchangedBodyBytes: 0, conditionalMedianMs: Math.round(durations.sort((a, b) => a - b)[1]) });
    const changed = await create('task', { title: 'A newly visible item', done: false });
    const updated = await request('/api/bootstrap', { headers: { 'If-None-Match': validator } });
    expect(updated.status).toBe(200);
    expect((await updated.json() as Bootstrap).records.some(record => record.id === changed.id)).toBe(true);
  }, 30_000);
});

describe('private data, family visibility, and module boundaries', () => {
  it('never exposes private moods to other members or administrators through bootstrap or export', async () => {
    const mood = await create('mood', { date: '2026-01-01', score: 2, note: 'Private thoughts', shared: false }, 'sam');
    expect(await records()).toHaveLength(0);
    expect(await records('sam')).toHaveLength(1);
    const exported = await (await request('/api/export')).json() as Bootstrap & { schemaVersion: number };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.records).toHaveLength(0);
    for (const method of ['PATCH', 'DELETE']) {
      expect((await request(`/api/records/${mood.id}`, { method, body: method === 'PATCH' ? { data: { ...mood.data, shared: true }, version: 1 } : { version: 1 } })).status).toBe(403);
    }
    expect((await request(`/api/records/${mood.id}`, { method: 'PATCH', user: 'sam', body: { data: { ...mood.data, shared: true }, version: 1 } })).status).toBe(200);
    expect(await records()).toHaveLength(1);
  });

  it('reveals scoped answers to both partners only after both answer the same question', async () => {
    const answer = answerData();
    const first = await create('answer', { ...answer, participantIds: ['sam', 'alex'] });
    expect((first as FamilyRecord<'answer'>).data.participantIds).toEqual(['alex', 'sam']);
    expect(await records('sam')).toHaveLength(0);
    await create('answer', { ...answer, choice: 1 }, 'sam');
    expect(await records()).toHaveLength(2);
    expect(await records('sam')).toHaveLength(2);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: { ...answer, questionId: 'fake-question' } } })).status).toBe(400);
  });

  it('restricts profile and habit writes to their owner and habit logs to the habit owner', async () => {
    const profile = await create('profile', { bio: '', loves: [], suggestions: [] });
    expect((await request(`/api/records/${profile.id}`, { method: 'PATCH', user: 'sam', body: { data: { bio: 'Changed', loves: [], suggestions: [] }, version: 1 } })).status).toBe(403);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'habit', data: { title: 'Walk', userId: 'sam', color: '#112233' } } })).status).toBe(403);
    const habit = await create('habit', { title: 'Walk', userId: 'alex', color: '#112233' });
    expect((await request('/api/records', { method: 'POST', user: 'sam', body: { kind: 'habitLog', data: { habitId: habit.id, date: '2026-01-01' } } })).status).toBe(403);
    await create('habitLog', { habitId: habit.id, date: '2026-01-01' });
    expect((await request(`/api/records/${habit.id}`, { method: 'DELETE', body: { version: 2 } })).status).toBe(409);
    expect((await records()).filter(record => record.kind === 'habitLog')).toHaveLength(1);
    expect((await request(`/api/records/${habit.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect((await records()).filter(record => record.kind === 'habitLog')).toHaveLength(0);
  });

  it('preserves disabled module records and denies reads, writes, and imports until re-enabled', async () => {
    const item = await create('task', task);
    expect((await request('/api/modules/tasks', { method: 'PATCH', user: 'sam', body: { enabled: false } })).status).toBe(403);
    expect((await request('/api/modules/tasks', { method: 'PATCH', body: { enabled: false } })).status).toBe(200);
    expect(await records()).toHaveLength(0);
    expect(((await (await request('/api/export')).json()) as Bootstrap).records).toHaveLength(0);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task } })).status).toBe(403);
    expect((await request(`/api/records/${item.id}`, { method: 'PATCH', body: { version: 1, data: task } })).status).toBe(403);
    expect((await request(`/api/records/${item.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(403);
    await request('/api/modules/recipes', { method: 'PATCH', body: { enabled: false } });
    expect((await request('/api/recipes/import', { method: 'POST', body: { mode: 'text', value: 'Soup' } })).status).toBe(403);
    await request('/api/modules/tasks', { method: 'PATCH', body: { enabled: true } });
    expect((await records())[0].id).toBe(item.id);
  });
});

describe('question pair configuration, immutable scope, and family consent', () => {
  it('suspends an unavailable pair without breaking other members or revealing saved answers', async () => {
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    const own = await create('answer', answerData());
    await create('answer', answerData(), 'sam');
    fixture.sqlite.exec("UPDATE auth_members SET status='suspended' WHERE id='sam'");
    const response = await request('/api/bootstrap');
    expect(response.status).toBe(200);
    const data = await response.json() as Bootstrap;
    expect(data.questionPair).toBeNull();
    expect(data.records.map(record=>record.id)).toEqual([own.id]);
    expect((await request('/api/bootstrap',{user:'sam'})).status).toBe(401);
    expect((await request('/api/records',{method:'POST',body:{kind:'answer',data:answerData('2026-01-02')}})).status).toBe(403);
  });
  it('infers only a two-person pair and includes it in bootstrap and export', async () => {
    for (const path of ['/api/bootstrap', '/api/export']) {
      expect((await (await request(path)).json() as Bootstrap).questionPair).toEqual(['alex', 'sam']);
    }
    setMembers([...members, lee]);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).questionPair).toBeNull();
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: answerData() } })).status).toBe(403);
    setMembers(members);
    env.FAMILY_QUESTION_PAIR = 'null';
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).questionPair).toBeNull();
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: answerData() } })).status).toBe(403);
  });

  it('fails closed for an invalid configured pair', async () => {
    for (const pair of ['["alex","alex"]', '["alex","unknown"]', '["alex"]', 'broken']) {
      expect((await request('/api/bootstrap', { configuration: { FAMILY_QUESTION_PAIR: pair } })).status).toBe(503);
    }
  });

  it('requires the submitted scope, rejects stale or forged pairs, and excludes other family members', async () => {
    setMembers([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    for (const participantIds of [undefined, ['alex', 'lee'], ['alex', 'stranger']]) {
      expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: { ...answerData(), participantIds } } })).status).toBe(409);
    }
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: answerData('2026-01-01', { participantIds: ['alex', 'alex'] }) } })).status).toBe(400);
    expect((await request('/api/records', { method: 'POST', user: lee.id, body: { kind: 'answer', data: answerData() } })).status).toBe(403);
    expect(await records()).toHaveLength(0);
  });

  it('releases only opted-in answers to a third member, including an administrator, after paired completion', async () => {
    setMembers([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["sam","alex"]';
    const first = await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    expect(await records(lee.id)).toHaveLength(0);
    const partner = await create('answer', answerData('2026-01-01', { choice: 1 }), members[1].id);
    expect((await records(lee.id)).map(record => record.id)).toEqual([first.id]);
    expect((await (await request('/api/export', { user: lee.id })).json() as Bootstrap).records.map(record => record.id)).toEqual([first.id]);
    expect(await records()).toHaveLength(2);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: lee.id, body: { version: 1, data: { ...partner.data, shareToProfile: true } } })).status).toBe(403);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, shareToProfile: false } } })).status).toBe(200);
    expect(await records(lee.id)).toHaveLength(0);
    expect(await records(members[1].id)).toHaveLength(2);
  });

  it('removes partner and profile release when a paired answer is deleted', async () => {
    setMembers([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    const partner = await create('answer', answerData(), members[1].id);
    expect(await records(lee.id)).toHaveLength(1);
    expect((await request(`/api/records/${partner.id}`, { method: 'DELETE', user: members[1].id, body: { version: 1 } })).status).toBe(200);
    expect(await records(lee.id)).toHaveLength(0);
    expect(await records(members[1].id)).toHaveLength(0);
  });

  it('rejects edits to an answer date, question, or participant tuple', async () => {
    const first = await create('answer', answerData());
    for (const changes of [{ date: '2025-12-31' }, { questionId: 'different' }, { participantIds: ['alex', 'lee'] }, { participantIds: ['sam', 'alex'] }, { participantIds: undefined }]) {
      expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, ...changes } } })).status).toBe(400);
    }
    expect((await getRecord(env.DB, first.id)).version).toBe(1);
  });

  it('keeps legacy answers author-only even with old profile consent and both legacy answers present', async () => {
    const first = await legacyAnswer(members[0], { shareToProfile: true });
    const partner = await legacyAnswer(members[1], { shareToProfile: true });
    expect((await records()).map(record => record.id)).toEqual([first.id]);
    expect((await records(members[1].id)).map(record => record.id)).toEqual([partner.id]);
    expect((await (await request('/api/export')).json() as Bootstrap).records.map(record => record.id)).toEqual([first.id]);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1, shareToProfile: false } } })).status).toBe(200);
    const current = await getRecord(env.DB, first.id) as FamilyRecord<'answer'>;
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 2, data: { ...current.data, shareToProfile: true } } })).status).toBe(409);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 2, data: { ...current.data, participantIds: ['alex', 'sam'] } } })).status).toBe(400);
    expect((await getRecord(env.DB, first.id) as FamilyRecord<'answer'>).data.participantIds).toBeUndefined();
  });

  it('preserves authors’ history after pairing changes without reassigning it to a new partner', async () => {
    setMembers([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    const first = await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    const partner = await create('answer', answerData(), members[1].id);
    env.FAMILY_QUESTION_PAIR = '["alex","lee"]';
    expect((await records()).map(record => record.id)).toEqual([first.id]);
    expect((await records(members[1].id)).map(record => record.id)).toEqual([partner.id]);
    expect(await records(lee.id)).toHaveLength(0);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1, shareToProfile: false } } })).status).toBe(200);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: members[1].id, body: { version: 1, data: { ...partner.data, choice: 1 } } })).status).toBe(200);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: members[1].id, body: { version: 2, data: { ...partner.data, shareToProfile: true } } })).status).toBe(409);
    const nextDay = answerData('2026-01-02', { participantIds: ['alex', 'lee'] });
    await create('answer', nextDay);
    await create('answer', nextDay, lee.id);
    expect((await records(lee.id)).map(record => record.id)).not.toContain(first.id);
  });

  it('preserves private owner reads and edits while pairing is disabled or a partner is removed', async () => {
    const first = await create('answer', answerData());
    await create('answer', answerData(), members[1].id);
    env.FAMILY_QUESTION_PAIR = 'null';
    expect((await records()).map(record => record.id)).toEqual([first.id]);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1 } } })).status).toBe(200);
    setMembers([members[0], lee]);
    env.FAMILY_QUESTION_PAIR = undefined;
    expect(await records(lee.id)).toHaveLength(0);
    expect((await records()).map(record => record.id)).toEqual([first.id]);
  });

  it('blocks same-day submission if either current participant already answered under another scope', async () => {
    setMembers([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    const first = await create('answer', answerData());
    env.FAMILY_QUESTION_PAIR = '["alex","lee"]';
    for (const user of [members[0].id, lee.id]) {
      expect((await request('/api/records', { method: 'POST', user, body: { kind: 'answer', data: answerData('2026-01-01', { participantIds: ['alex', 'lee'] }) } })).status).toBe(409);
    }
    expect((await getRecord(env.DB, first.id)).data).toEqual(first.data);
    expect(await records(lee.id)).toHaveLength(0);
  });

  it('blocks legacy partner collisions inside the insert without upgrading the stored answer', async () => {
    const legacy = await legacyAnswer(members[0]);
    await expect(createRecord(env.DB, members[1], 'answer', answerData())).rejects.toMatchObject({ status: 409 });
    expect((await request('/api/records', { method: 'POST', user: members[1].id, body: { kind: 'answer', data: answerData() } })).status).toBe(409);
    expect((await getRecord(env.DB, legacy.id)).data).toEqual(legacy.data);
  });

  it('rechecks incompatible partner scope in the atomic insert when configuration changes between requests', async () => {
    await createRecord(env.DB, members[0], 'answer', answerData());
    await expect(createRecord(env.DB, lee, 'answer', answerData('2026-01-01', { participantIds: ['alex', 'lee'] }))).rejects.toMatchObject({ status: 409 });
    await expect(createRecord(env.DB, members[1], 'answer', answerData())).resolves.toMatchObject({ ownerId: 'sam' });
    await expect(createRecord(env.DB, members[0], 'answer', answerData())).rejects.toMatchObject({ status: 409 });
  });
});

describe('session authentication replaces identity headers', () => {
  it('rejects Access and development identity headers without a valid session', async () => {
    for (const forged of [
      { 'Cf-Access-Jwt-Assertion': 'legacy.jwt.token' },
      { 'Cf-Access-Authenticated-User-Email': 'legacy-value' },
      { 'X-Dev-User': 'alex' },
    ] as Record<string,string>[]) {
      expect((await request('/api/bootstrap', { headers: { ...forged, Cookie: '' } })).status).toBe(401);
    }
  });
  it('rechecks member status and session revocation on each private request', async () => {
    expect((await request('/api/bootstrap')).status).toBe(200);
    fixture.sqlite.exec("UPDATE auth_members SET status = 'suspended' WHERE id = 'alex'");
    expect((await request('/api/bootstrap')).status).toBe(401);
    fixture.sqlite.exec("UPDATE auth_members SET status = 'active' WHERE id = 'alex'; UPDATE auth_sessions SET revoked_at = created_at WHERE member_id = 'alex'");
    expect((await request('/api/bootstrap')).status).toBe(401);
  });
});
