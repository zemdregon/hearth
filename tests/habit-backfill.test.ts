import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './fixtures/api-harness';
import { backfillDates, MAX_BACKFILL_DAYS, streaksForDates } from '../src/shared/calendar';
import type { Bootstrap, FamilyRecord } from '../src/shared/types';

describe('backfillDates', () => {
  it('lists every day from the start through yesterday, never today', () => {
    expect(backfillDates('2026-10-06', '2026-10-09')).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(backfillDates('2026-10-08', '2026-10-09')).toEqual(['2026-10-08']);
  });
  it('crosses month, year and leap-day boundaries', () => {
    expect(backfillDates('2023-12-30', '2024-01-02')).toEqual(['2023-12-30', '2023-12-31', '2024-01-01']);
    expect(backfillDates('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29']);
  });
  it('rejects today, the future, invalid dates and spans beyond a year', () => {
    for (const start of ['2026-10-09', '2026-10-10', '2026-02-30', 'yesterday', '']) expect(() => backfillDates(start, '2026-10-09'), start).toThrow(RangeError);
    expect(backfillDates('2025-10-08', '2026-10-09')).toHaveLength(MAX_BACKFILL_DAYS); // 2025-10-08 → 2026-10-08 inclusive
    expect(() => backfillDates('2025-10-07', '2026-10-09')).toThrow(/at most 366/);
  });
  it('produces a streak that is alive through today', () => {
    expect(streaksForDates(backfillDates('2026-10-01', '2026-10-09'), '2026-10-09')).toEqual({ current: 8, longest: 8, total: 8 });
  });
});

let h: ReturnType<typeof harness>;
const NOW = new Date('2026-10-09T12:00:00Z');
// Freeze the clock before the harness stamps its sessions, so results do not depend on the real time.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); h = harness(); });
afterEach(() => { vi.useRealTimers(); h.close(); });

const habit = { title: 'Walk', userId: 'alex', color: '#2f624b' };
const create = (body: unknown, user = 'alex') => h.request('/api/habits', { method: 'POST', body, user });
const records = async (user = 'alex') => ((await (await h.request('/api/bootstrap', { user })).json()) as Bootstrap).records;
const logCount = () => Number((h.sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE kind = 'habitLog'").get() as { n: number }).n);
const storage = () => h.sqlite.prepare('SELECT data_bytes, record_count FROM family_storage').get() as { data_bytes: number; record_count: number };

describe('creating a habit with retroactive check-ins', () => {
  it('creates the habit and a log for each day through yesterday, atomically', async () => {
    const response = await create({ data: habit, startDate: '2026-10-01' });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as { habit: FamilyRecord<'habit'>; backfilled: number };
    expect(body.backfilled).toBe(8);
    const all = await records();
    const logs = all.filter((record): record is FamilyRecord<'habitLog'> => record.kind === 'habitLog');
    expect(all.filter(record => record.kind === 'habit').map(record => record.id)).toEqual([body.habit.id]);
    expect(logs.map(log => log.data.date).sort()).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
    expect(logs.every(log => log.data.habitId === body.habit.id && log.ownerId === 'alex' && log.version === 1)).toBe(true);
    expect(streaksForDates(logs.map(log => log.data.date), '2026-10-09')).toEqual({ current: 8, longest: 8, total: 8 });
    // Bytes match what a normal check-in stores, so the budget triggers account identically.
    const stored = h.sqlite.prepare("SELECT data FROM records WHERE kind = 'habitLog' LIMIT 1").get() as { data: string };
    expect(stored.data).toBe(JSON.stringify({ habitId: body.habit.id, date: JSON.parse(stored.data).date }));
    const actual = h.sqlite.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes, COUNT(*) AS n FROM records').get() as { bytes: number; n: number };
    expect(storage()).toEqual({ data_bytes: actual.bytes, record_count: actual.n });
  });
  it('lets the owner uncheck a backfilled day and still check in today', async () => {
    const { habit: created } = await (await create({ data: habit, startDate: '2026-10-07' })).json() as { habit: FamilyRecord<'habit'> };
    const log = (await records()).find(record => record.kind === 'habitLog' && record.data.date === '2026-10-07')!;
    expect((await h.request(`/api/records/${log.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect((await h.request('/api/records', { method: 'POST', body: { kind: 'habitLog', data: { habitId: created.id, date: '2026-10-09' } } })).status).toBe(201);
    expect(logCount()).toBe(2);
  });
  it('without a start date behaves like the ordinary create', async () => {
    const response = await create({ data: habit });
    expect([response.status, ((await response.json()) as { backfilled: number }).backfilled]).toEqual([201, 0]);
    expect(logCount()).toBe(0);
  });
  it('deleting the habit removes its backfilled history', async () => {
    const { habit: created } = await (await create({ data: habit, startDate: '2026-10-05' })).json() as { habit: FamilyRecord<'habit'> };
    expect(logCount()).toBe(4);
    expect((await h.request(`/api/records/${created.id}`, { method: 'DELETE', body: { version: 1 } })).status).toBe(200);
    expect(logCount()).toBe(0);
    expect(storage()).toEqual({ data_bytes: 0, record_count: 0 });
  });
  it('accepts exactly a year of history and no more', async () => {
    expect(((await (await create({ data: habit, startDate: '2025-10-08' })).json()) as { backfilled: number }).backfilled).toBe(366);
    expect((await create({ data: habit, startDate: '2025-10-07' })).status).toBe(400);
    expect(logCount()).toBe(366);
  });
  it('rejects today, future, malformed dates and extra fields without creating anything', async () => {
    for (const startDate of ['2026-10-09', '2026-10-10', '2026-02-30', '2026-1-1', 'last week']) {
      expect((await create({ data: habit, startDate })).status, startDate).toBe(400);
    }
    expect((await create({ data: habit, startDate: '2026-10-01', extra: true })).status).toBe(400);
    expect((await create({ data: { ...habit, extra: 1 }, startDate: '2026-10-01' })).status).toBe(400);
    expect((await records())).toHaveLength(0);
  });
  it('uses the family timezone for what counts as today', async () => {
    // 2026-10-09 12:00Z is already 2026-10-10 in UTC+14, so 2026-10-09 is yesterday there.
    expect((await create({ data: habit, startDate: '2026-10-09' })).status).toBe(400);
    h.env.FAMILY_TIMEZONE = 'Pacific/Kiritimati';
    expect(((await (await create({ data: habit, startDate: '2026-10-09' })).json()) as { backfilled: number }).backfilled).toBe(1);
  });
  it('only lets a member create their own habit, and respects the paused streaks module', async () => {
    expect((await create({ data: { ...habit, userId: 'sam' }, startDate: '2026-10-01' })).status).toBe(403);
    expect((await create({ data: habit, startDate: '2026-10-01' }, 'sam')).status).toBe(403);
    expect((await create({ data: { ...habit, userId: 'sam' }, startDate: '2026-10-01' }, 'sam')).status).toBe(201);
    h.sqlite.exec("INSERT INTO modules (id, enabled) VALUES ('streaks', 0)");
    expect((await create({ data: habit, startDate: '2026-10-01' })).status).toBe(403);
    expect(logCount()).toBe(8); // only the member's own habit was created
  });
  it('requires a session and a same-origin request', async () => {
    expect((await create({ data: habit, startDate: '2026-10-01' }, 'outsider')).status).toBe(401);
    expect((await h.request('/api/habits', { method: 'POST', body: { data: habit, startDate: '2026-10-01' }, headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect(await records()).toHaveLength(0);
  });
  it('rolls the whole habit back when the storage budget cannot hold the history', async () => {
    h.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9995)
      INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) SELECT 'n' || i, 'note', 'alex', '{"date":"2026-01-01","text":"x"}', 'a', 'a', 1 FROM n`);
    const before = storage();
    const response = await create({ data: habit, startDate: '2026-10-01' }); // needs 9 rows, only 5 left
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/storage is full/);
    expect(storage()).toEqual(before);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM records WHERE kind IN ('habit', 'habitLog')").get()).toEqual({ n: 0 });
  });
});
