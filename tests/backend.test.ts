import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import app from '../src/server/index';
import type { Env } from '../src/server/env';
import type { Answer, Bootstrap, FamilyRecord, User } from '../src/shared/types';
import { questionForDate } from '../src/shared/questions';
import { consumeLimit, createRecord, getRecord, updateRecord } from '../src/server/db';
import { validateData } from '../src/server/validation';

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
  return { db: adapter as unknown as D1Database, close: () => sqlite.close() };
}

const members: User[] = [
  { id: 'alex', name: 'Alex', email: 'alex@example.com', role: 'admin', color: '#38634A' },
  { id: 'sam', name: 'Sam', email: 'sam@example.com', role: 'member', color: '#A96743' },
];
let env: Env;
let fixture: ReturnType<typeof database>;
const base = 'http://localhost:8787';
const task = { title: 'Buy apples', done: false };
const lee: User = { id: 'lee', name: 'Lee', email: 'lee@example.com', role: 'admin', color: '#555555' };
const answerData = (date = '2026-01-01', changes: Partial<Answer> = {}): Answer => ({ date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'], ...changes });

function request(path: string, options: { method?: string; body?: unknown; user?: string; headers?: Record<string, string>; url?: string; configuration?: Partial<Env> } = {}) {
  return app.request(`${options.url || base}${path}`, {
    method: options.method || 'GET',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dev-User': options.user || 'alex@example.com', ...options.headers },
    ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  }, { ...env, ...options.configuration });
}
async function create(kind: string, data: unknown, user?: string): Promise<FamilyRecord> {
  const response = await request('/api/records', { method: 'POST', body: { kind, data }, user });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FamilyRecord>;
}
async function records(user?: string) { return ((await (await request('/api/bootstrap', { user })).json()) as Bootstrap).records; }
async function legacyAnswer(user = members[0], changes: Partial<Answer> = {}) {
  const data = answerData('2026-01-01', { participantIds: undefined, ...changes });
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .bind(id, 'answer', user.id, JSON.stringify(data), '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z').run();
  return await getRecord(env.DB, id) as FamilyRecord<'answer'>;
}

beforeEach(() => {
  fixture = database();
  env = { DB: fixture.db, DEV_AUTH: 'true', FAMILY_MEMBERS: JSON.stringify(members), FAMILY_TIMEZONE: 'UTC', APP_ORIGIN: base };
});
afterEach(() => { fixture.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('authentication and request boundaries', () => {
  it('exposes a minimal health response while unconfigured private API fails closed', async () => {
    expect((await request('/api/health', { configuration: { FAMILY_MEMBERS: undefined } })).status).toBe(200);
    const response = await request('/api/bootstrap', { configuration: { FAMILY_MEMBERS: undefined } });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('does not enable development authentication on a remote host or accept an email header', async () => {
    const response = await request('/api/bootstrap', { url: 'https://hearth.example', configuration: { APP_ORIGIN: 'https://hearth.example', ACCESS_TEAM_DOMAIN: 'hearth.cloudflareaccess.com', ACCESS_AUD: 'test-aud' }, headers: { 'Cf-Access-Authenticated-User-Email': 'alex@example.com' } });
    expect(response.status).toBe(401);
  });

  it('requires allowlist membership even for local development', async () => {
    expect((await request('/api/bootstrap', { user: 'outsider@example.com' })).status).toBe(403);
    const response = await request('/api/bootstrap', { headers: { 'X-Dev-User': '' } });
    expect(((await response.json()) as Bootstrap).user.id).toBe('alex');
  });

  it('rejects cross-origin mutations and non-JSON requests', async () => {
    const attempts: Record<string, string>[] = [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of attempts) {
      expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task }, headers })).status).toBe(403);
    }
    expect((await request('/api/records', { method: 'POST', body: { kind: 'task', data: task }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect(await records()).toHaveLength(0);
  });

  it('rejects duplicate members and invalid deployment timezone', async () => {
    expect((await request('/api/bootstrap', { configuration: { FAMILY_MEMBERS: JSON.stringify([members[0], members[0]]) } })).status).toBe(503);
    expect((await request('/api/bootstrap', { configuration: { FAMILY_TIMEZONE: 'not/a-zone' } })).status).toBe(503);
  });
});

describe('persistent records, validation, and optimistic concurrency', () => {
  it('creates server-owned records and permits shared task edits with version checks', async () => {
    const item = await create('task', task);
    expect(item.ownerId).toBe('alex');
    expect(item.version).toBe(1);
    const update = await request(`/api/records/${item.id}`, { method: 'PATCH', user: 'sam@example.com', body: { data: { ...task, done: true }, version: 1 } });
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
    await create('mood', mood, 'sam@example.com');
  });

  it('limits imports before expensive processing and resets quotas in a new window', async () => {
    await consumeLimit(env.DB, 'test', 2, 60, 0);
    await consumeLimit(env.DB, 'test', 2, 60, 0);
    await expect(consumeLimit(env.DB, 'test', 2, 60, 0)).rejects.toMatchObject({ status: 429 });
    await expect(consumeLimit(env.DB, 'test', 2, 60, 60_000)).resolves.toBeUndefined();
  });

  it('keeps member and deployment import quotas in separate namespaces', async () => {
    env.FAMILY_MEMBERS = JSON.stringify([{ ...members[0], id: 'family' }, members[1]]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request('/api/recipes/import', { method: 'POST', body: { mode: 'text', value: '1 cup rice. Boil until soft.' } });
      expect(response.status).not.toBe(429);
    }
    expect((await request('/api/recipes/import', { method: 'POST', body: { mode: 'text', value: '1 cup rice. Boil until soft.' } })).status).toBe(429);
    expect((await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'deployment:imports'").first<{ count: number }>())?.count).toBe(10);
  });

  it('enforces the aggregate byte budget atomically and releases capacity on deletion', async () => {
    const note = { date: '2026-01-01', text: '🌳'.repeat(2400) };
    validateData('note', note);
    const size = new TextEncoder().encode(JSON.stringify(note)).byteLength;
    const maximum = Math.floor(8_388_608 / size);
    let last: FamilyRecord | undefined;
    for (let count = 0; count < maximum; count += 1) last = await createRecord(env.DB, members[0], 'note', note);
    await expect(createRecord(env.DB, members[0], 'note', note)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('storage is full') });
    const stored = await env.DB.prepare('SELECT data_bytes, record_count FROM family_storage').first<{ data_bytes: number; record_count: number }>();
    expect(stored).toMatchObject({ data_bytes: maximum * size, record_count: maximum });
    const enlarged = { ...note, text: '🌳'.repeat(2499) };
    validateData('note', enlarged);
    // Fill the remaining room so an otherwise valid update cannot cross the aggregate limit.
    const remainder = 8_388_608 - stored!.data_bytes;
    const fillerBytes = remainder - JSON.stringify({ ...note, text: '' }).length;
    if (fillerBytes > 0) {
      const filler = { ...note, text: '🌳'.repeat(Math.floor(fillerBytes / 4)) + 'x'.repeat(fillerBytes % 4) };
      validateData('note', filler);
      await createRecord(env.DB, members[0], 'note', filler);
    }
    await expect(updateRecord(env.DB, last!, enlarged, 1)).rejects.toMatchObject({ status: 409 });
    expect((await getRecord(env.DB, last!.id)).version).toBe(1);
    await request(`/api/records/${last!.id}`, { method: 'DELETE', body: { version: 1 } });
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

describe('private data, family visibility, and module boundaries', () => {
  it('never exposes private moods to other members or administrators through bootstrap or export', async () => {
    const mood = await create('mood', { date: '2026-01-01', score: 2, note: 'Private thoughts', shared: false }, 'sam@example.com');
    expect(await records()).toHaveLength(0);
    expect(await records('sam@example.com')).toHaveLength(1);
    const exported = await (await request('/api/export')).json() as Bootstrap & { schemaVersion: number };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.records).toHaveLength(0);
    for (const method of ['PATCH', 'DELETE']) {
      expect((await request(`/api/records/${mood.id}`, { method, body: method === 'PATCH' ? { data: { ...mood.data, shared: true }, version: 1 } : { version: 1 } })).status).toBe(403);
    }
    expect((await request(`/api/records/${mood.id}`, { method: 'PATCH', user: 'sam@example.com', body: { data: { ...mood.data, shared: true }, version: 1 } })).status).toBe(200);
    expect(await records()).toHaveLength(1);
  });

  it('reveals scoped answers to both partners only after both answer the same question', async () => {
    const answer = answerData();
    const first = await create('answer', { ...answer, participantIds: ['sam', 'alex'] });
    expect((first as FamilyRecord<'answer'>).data.participantIds).toEqual(['alex', 'sam']);
    expect(await records('sam@example.com')).toHaveLength(0);
    await create('answer', { ...answer, choice: 1 }, 'sam@example.com');
    expect(await records()).toHaveLength(2);
    expect(await records('sam@example.com')).toHaveLength(2);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: { ...answer, questionId: 'fake-question' } } })).status).toBe(400);
  });

  it('restricts profile and habit writes to their owner and habit logs to the habit owner', async () => {
    const profile = await create('profile', { bio: '', loves: [], suggestions: [] });
    expect((await request(`/api/records/${profile.id}`, { method: 'PATCH', user: 'sam@example.com', body: { data: { bio: 'Changed', loves: [], suggestions: [] }, version: 1 } })).status).toBe(403);
    expect((await request('/api/records', { method: 'POST', body: { kind: 'habit', data: { title: 'Walk', userId: 'sam', color: '#112233' } } })).status).toBe(403);
    const habit = await create('habit', { title: 'Walk', userId: 'alex', color: '#112233' });
    expect((await request('/api/records', { method: 'POST', user: 'sam@example.com', body: { kind: 'habitLog', data: { habitId: habit.id, date: '2026-01-01' } } })).status).toBe(403);
    await create('habitLog', { habitId: habit.id, date: '2026-01-01' });
    expect((await request(`/api/records/${habit.id}`, { method: 'DELETE', body: { version: 2 } })).status).toBe(409);
    expect((await records()).filter(record => record.kind === 'habitLog')).toHaveLength(1);
    expect((await request(`/api/records/${habit.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect((await records()).filter(record => record.kind === 'habitLog')).toHaveLength(0);
  });

  it('preserves disabled module records and denies reads, writes, and imports until re-enabled', async () => {
    const item = await create('task', task);
    expect((await request('/api/modules/tasks', { method: 'PATCH', user: 'sam@example.com', body: { enabled: false } })).status).toBe(403);
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
  it('infers only a two-person pair and includes it in bootstrap and export', async () => {
    for (const path of ['/api/bootstrap', '/api/export']) {
      expect((await (await request(path)).json() as Bootstrap).questionPair).toEqual(['alex', 'sam']);
    }
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    expect((await (await request('/api/bootstrap')).json() as Bootstrap).questionPair).toBeNull();
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: answerData() } })).status).toBe(403);
    env.FAMILY_MEMBERS = JSON.stringify(members);
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
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    for (const participantIds of [undefined, ['alex', 'lee'], ['alex', 'stranger']]) {
      expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: { ...answerData(), participantIds } } })).status).toBe(409);
    }
    expect((await request('/api/records', { method: 'POST', body: { kind: 'answer', data: answerData('2026-01-01', { participantIds: ['alex', 'alex'] }) } })).status).toBe(400);
    expect((await request('/api/records', { method: 'POST', user: lee.email, body: { kind: 'answer', data: answerData() } })).status).toBe(403);
    expect(await records()).toHaveLength(0);
  });

  it('releases only opted-in answers to a third member, including an administrator, after paired completion', async () => {
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["sam","alex"]';
    const first = await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    expect(await records(lee.email)).toHaveLength(0);
    const partner = await create('answer', answerData('2026-01-01', { choice: 1 }), members[1].email);
    expect((await records(lee.email)).map(record => record.id)).toEqual([first.id]);
    expect((await (await request('/api/export', { user: lee.email })).json() as Bootstrap).records.map(record => record.id)).toEqual([first.id]);
    expect(await records()).toHaveLength(2);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: lee.email, body: { version: 1, data: { ...partner.data, shareToProfile: true } } })).status).toBe(403);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, shareToProfile: false } } })).status).toBe(200);
    expect(await records(lee.email)).toHaveLength(0);
    expect(await records(members[1].email)).toHaveLength(2);
  });

  it('removes partner and profile release when a paired answer is deleted', async () => {
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    const partner = await create('answer', answerData(), members[1].email);
    expect(await records(lee.email)).toHaveLength(1);
    expect((await request(`/api/records/${partner.id}`, { method: 'DELETE', user: members[1].email, body: { version: 1 } })).status).toBe(200);
    expect(await records(lee.email)).toHaveLength(0);
    expect(await records(members[1].email)).toHaveLength(0);
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
    expect((await records(members[1].email)).map(record => record.id)).toEqual([partner.id]);
    expect((await (await request('/api/export')).json() as Bootstrap).records.map(record => record.id)).toEqual([first.id]);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1, shareToProfile: false } } })).status).toBe(200);
    const current = await getRecord(env.DB, first.id) as FamilyRecord<'answer'>;
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 2, data: { ...current.data, shareToProfile: true } } })).status).toBe(409);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 2, data: { ...current.data, participantIds: ['alex', 'sam'] } } })).status).toBe(400);
    expect((await getRecord(env.DB, first.id) as FamilyRecord<'answer'>).data.participantIds).toBeUndefined();
  });

  it('preserves authors’ history after pairing changes without reassigning it to a new partner', async () => {
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    const first = await create('answer', answerData('2026-01-01', { shareToProfile: true }));
    const partner = await create('answer', answerData(), members[1].email);
    env.FAMILY_QUESTION_PAIR = '["alex","lee"]';
    expect((await records()).map(record => record.id)).toEqual([first.id]);
    expect((await records(members[1].email)).map(record => record.id)).toEqual([partner.id]);
    expect(await records(lee.email)).toHaveLength(0);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1, shareToProfile: false } } })).status).toBe(200);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: members[1].email, body: { version: 1, data: { ...partner.data, choice: 1 } } })).status).toBe(200);
    expect((await request(`/api/records/${partner.id}`, { method: 'PATCH', user: members[1].email, body: { version: 2, data: { ...partner.data, shareToProfile: true } } })).status).toBe(409);
    const nextDay = answerData('2026-01-02', { participantIds: ['alex', 'lee'] });
    await create('answer', nextDay);
    await create('answer', nextDay, lee.email);
    expect((await records(lee.email)).map(record => record.id)).not.toContain(first.id);
  });

  it('preserves private owner reads and edits while pairing is disabled or a partner is removed', async () => {
    const first = await create('answer', answerData());
    await create('answer', answerData(), members[1].email);
    env.FAMILY_QUESTION_PAIR = 'null';
    expect((await records()).map(record => record.id)).toEqual([first.id]);
    expect((await request(`/api/records/${first.id}`, { method: 'PATCH', body: { version: 1, data: { ...first.data, choice: 1 } } })).status).toBe(200);
    env.FAMILY_MEMBERS = JSON.stringify([members[0], lee]);
    env.FAMILY_QUESTION_PAIR = undefined;
    expect(await records(lee.email)).toHaveLength(0);
    expect((await records()).map(record => record.id)).toEqual([first.id]);
  });

  it('blocks same-day submission if either current participant already answered under another scope', async () => {
    env.FAMILY_MEMBERS = JSON.stringify([...members, lee]);
    env.FAMILY_QUESTION_PAIR = '["alex","sam"]';
    const first = await create('answer', answerData());
    env.FAMILY_QUESTION_PAIR = '["alex","lee"]';
    for (const user of [members[0].email, lee.email]) {
      expect((await request('/api/records', { method: 'POST', user, body: { kind: 'answer', data: answerData('2026-01-01', { participantIds: ['alex', 'lee'] }) } })).status).toBe(409);
    }
    expect((await getRecord(env.DB, first.id)).data).toEqual(first.data);
    expect(await records(lee.email)).toHaveLength(0);
  });

  it('blocks legacy partner collisions inside the insert without upgrading the stored answer', async () => {
    const legacy = await legacyAnswer(members[0]);
    await expect(createRecord(env.DB, members[1], 'answer', answerData())).rejects.toMatchObject({ status: 409 });
    expect((await request('/api/records', { method: 'POST', user: members[1].email, body: { kind: 'answer', data: answerData() } })).status).toBe(409);
    expect((await getRecord(env.DB, legacy.id)).data).toEqual(legacy.data);
  });

  it('rechecks incompatible partner scope in the atomic insert when configuration changes between requests', async () => {
    await createRecord(env.DB, members[0], 'answer', answerData());
    await expect(createRecord(env.DB, lee, 'answer', answerData('2026-01-01', { participantIds: ['alex', 'lee'] }))).rejects.toMatchObject({ status: 409 });
    await expect(createRecord(env.DB, members[1], 'answer', answerData())).resolves.toMatchObject({ ownerId: 'sam' });
    await expect(createRecord(env.DB, members[0], 'answer', answerData())).rejects.toMatchObject({ status: 409 });
  });
});

describe('Cloudflare Access signed tokens', () => {
  let privateKey: CryptoKey;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    publicJwk = { ...await exportJWK(keys.publicKey), kid: 'hearth-test', alg: 'RS256', use: 'sig' };
  });
  async function signedToken(options: { email?: string; issuer?: string; audience?: string; expires?: string; omitExpiry?: boolean } = {}) {
    let jwt = new SignJWT({ email: options.email || 'alex@example.com', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'hearth-test' }).setSubject('access-user').setIssuedAt().setIssuer(options.issuer || 'https://hearth-test.cloudflareaccess.com').setAudience(options.audience || 'test-audience');
    if (!options.omitExpiry) jwt = jwt.setExpirationTime(options.expires || '1h');
    return jwt.sign(privateKey);
  }
  function productionRequest(token: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } })));
    return request('/api/bootstrap', { url: 'https://hearth.example', headers: { 'Cf-Access-Jwt-Assertion': token }, configuration: { APP_ORIGIN: 'https://hearth.example', ACCESS_TEAM_DOMAIN: 'hearth-test.cloudflareaccess.com', ACCESS_AUD: 'test-audience' } });
  }

  it('verifies signature, issuer, audience, expiry, and independent family membership', async () => {
    expect((await productionRequest(await signedToken())).status).toBe(200);
    expect((await productionRequest(await signedToken({ issuer: 'https://wrong.cloudflareaccess.com' }))).status).toBe(401);
    expect((await productionRequest(await signedToken({ audience: 'wrong-audience' }))).status).toBe(401);
    expect((await productionRequest(await signedToken({ expires: '-1h' }))).status).toBe(401);
    expect((await productionRequest(await signedToken({ omitExpiry: true }))).status).toBe(401);
    expect((await productionRequest(await signedToken({ email: 'outsider@example.com' }))).status).toBe(403);
    const token = await signedToken();
    const [header, payload, signature] = token.split('.');
    const altered = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    expect((await productionRequest(altered)).status).toBe(401);
  });
});
