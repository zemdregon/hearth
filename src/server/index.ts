import { Hono } from 'hono';
import type { Context } from 'hono';
import { moduleIds, kindModule } from '../shared/types';
import type { RecordDataMap, RecordKind, User } from '../shared/types';
import { sameQuestionPair } from '../shared/question-pairing';
import { questionForDate } from '../shared/questions';
import { backfillDates, todayInTimezone } from '../shared/calendar';
import { authenticate, enforceOrigin, readConfig } from './auth';
import { ApiError } from './env';
import type { Env, Variables } from './env';
import { consumeLimit, createHabitWithHistory, createRecord, deleteRecord, getRecord, readFamilySnapshot, requireModule, requireOwnership, updateRecord } from './db';
import { createSchema, deleteSchema, habitCreateSchema, importSchema, moduleSchema, parseInput, readJson, updateSchema, validateData } from './validation';
import { importRecipe, preflightImport, RecipeImportError } from './recipe-import';
import { matchesSnapshot, snapshotTag } from './snapshot';
import { passkeyRoutes } from './passkeys';
import { inventoryEnabled, inventoryRoutes, readConsumptions, readInventoryState, readLedger } from './inventory';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', c.req.path.startsWith('/api/auth/') ? 'no-referrer' : 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'no-store, private');
    c.header('Pragma', 'no-cache');
    c.header('Vary', 'Cookie');
  }
});

app.get('/api/health', c => c.json({ ok: true, service: 'hearth' }));
app.route('/api/auth', passkeyRoutes);

app.use('/api/*', async (c, next) => {
  const user = await authenticate(c.req.raw, c.env);
  const family = await readConfig(c.env, c.req.url);
  enforceOrigin(c.req.raw, family);
  if (!c.env.DB) throw new ApiError(503, 'Family storage is not configured.');
  c.set('family', family);
  c.set('user', user);
  await consumeLimit(c.env.DB, `member:${user.id}:requests`, 300, 60);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) await consumeLimit(c.env.DB, `member:${user.id}:writes`, 240, 3600);
  await next();
});

async function bootstrap(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const family = c.get('family');
  const user = c.get('user');
  const { modules, records, capacity } = await readFamilySnapshot(c.env.DB, user, family.members, family.questionPair);
  return { user, members: family.members, modules, records, capacity, timezone: family.timezone, questionPair: family.questionPair };
}

app.get('/api/bootstrap', async c => {
  // Authenticate and apply visibility on every refresh, including conditional ones.
  // Hash only the exact member-visible representation so hidden activity does not
  // create an extra change signal beyond the shared coarse capacity bucket.
  const json = JSON.stringify(await bootstrap(c));
  const tag = await snapshotTag(json);
  c.header('ETag', tag);
  if (matchesSnapshot(c.req.header('If-None-Match'), tag)) return c.body(null, 304);
  return c.body(json, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
});

async function validateRelations(db: D1Database, kind: RecordKind, data: RecordDataMap[RecordKind], user: User, members: User[], timezone: string, previous?: RecordDataMap[RecordKind]): Promise<void> {
  if (['mood', 'habitLog', 'answer'].includes(kind) && (data as RecordDataMap['mood']).date > todayInTimezone(timezone)) throw new ApiError(400, 'Choose today or a past date in your family timezone.');
  if (kind === 'task') {
    const assignee = (data as RecordDataMap['task']).assigneeId;
    // An unchanged assignee who has since been suspended must not block completing or renaming the task.
    const unchanged = assignee === (previous as RecordDataMap['task'] | undefined)?.assigneeId;
    if (assignee && !unchanged && !members.some(member => member.id === assignee)) throw new ApiError(400, 'Choose a member of this family.');
  }
  if (kind === 'habit' && (data as RecordDataMap['habit']).userId !== user.id) throw new ApiError(403, 'Habits can only be created and changed by their owner.');
  if (kind === 'habitLog') {
    const habit = await getRecord(db, (data as RecordDataMap['habitLog']).habitId);
    if (habit.kind !== 'habit' || habit.ownerId !== user.id) throw new ApiError(403, 'Only the habit owner can record a day.');
  }
  if (kind === 'answer') {
    const answer = data as RecordDataMap['answer'];
    const question = questionForDate(answer.date);
    if (question.id !== answer.questionId || answer.choice >= question.choices.length) throw new ApiError(400, 'Choose a valid answer to the question for this date.');
  }
}

app.post('/api/records', async c => {
  const { kind, data: input } = parseInput(createSchema, await readJson(c.req.raw));
  await requireModule(c.env.DB, kindModule[kind]);
  const data = validateData(kind, input);
  const user = c.get('user');
  if (kind === 'answer') {
    const answer = data as RecordDataMap['answer'];
    const pair = c.get('family').questionPair;
    if (!pair || !pair.includes(user.id)) throw new ApiError(403, 'Daily questions are available only to the configured pair.');
    if (!sameQuestionPair(answer.participantIds, pair)) throw new ApiError(409, 'The question pair changed. Refresh before answering.');
    answer.participantIds = [...pair];
  }
  await validateRelations(c.env.DB, kind, data, user, c.get('family').members, c.get('family').timezone);
  const record = await createRecord(c.env.DB, user, kind, data);
  return c.json(record, 201);
});

app.post('/api/habits', async c => {
  const { data: input, startDate } = parseInput(habitCreateSchema, await readJson(c.req.raw));
  await requireModule(c.env.DB, 'streaks');
  const data = validateData('habit', input);
  const user = c.get('user');
  if (data.userId !== user.id) throw new ApiError(403, 'Habits can only be created and changed by their owner.');
  let dates: string[] = [];
  if (startDate !== undefined) {
    try { dates = backfillDates(startDate, todayInTimezone(c.get('family').timezone)); }
    catch (error) { throw new ApiError(400, error instanceof RangeError ? error.message : 'Choose a valid start date.'); }
  }
  const habit = dates.length ? await createHabitWithHistory(c.env.DB, user, data, dates) : await createRecord(c.env.DB, user, 'habit', data);
  return c.json({ habit, backfilled: dates.length }, 201);
});

app.patch('/api/records/:id', async c => {
  const { data: input, version } = parseInput(updateSchema, await readJson(c.req.raw));
  const record = await getRecord(c.env.DB, c.req.param('id'));
  await requireModule(c.env.DB, kindModule[record.kind]);
  requireOwnership(record, c.get('user'));
  const data = validateData(record.kind, input);
  if (record.kind === 'answer') {
    const answer = data as RecordDataMap['answer'];
    const original = record.data;
    if (answer.date !== original.date || answer.questionId !== original.questionId
      || answer.participantIds?.[0] !== original.participantIds?.[0] || answer.participantIds?.[1] !== original.participantIds?.[1]) {
      throw new ApiError(400, 'An answer’s date, question, and participants cannot be changed.');
    }
    const pair = c.get('family').questionPair;
    if (answer.shareToProfile && !original.shareToProfile && (!pair?.includes(record.ownerId) || !sameQuestionPair(original.participantIds, pair))) {
      throw new ApiError(409, 'Only answers for the current question pair can be shared with family.');
    }
  }
  await validateRelations(c.env.DB, record.kind, data, c.get('user'), c.get('family').members, c.get('family').timezone, record.data);
  return c.json(await updateRecord(c.env.DB, record, data, version));
});

app.delete('/api/records/:id', async c => {
  const { version } = parseInput(deleteSchema, await readJson(c.req.raw));
  const record = await getRecord(c.env.DB, c.req.param('id'));
  await requireModule(c.env.DB, kindModule[record.kind]);
  requireOwnership(record, c.get('user'));
  await deleteRecord(c.env.DB, record, version);
  return c.json({ ok: true });
});

app.patch('/api/modules/:id', async c => {
  if (c.get('user').role !== 'admin') throw new ApiError(403, 'Only a family administrator can change modules.');
  const id = moduleIds.find(id => id === c.req.param('id'));
  if (!id) throw new ApiError(404, 'This module does not exist.');
  const { enabled } = parseInput(moduleSchema, await readJson(c.req.raw));
  await c.env.DB.prepare('INSERT INTO modules (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled').bind(id, enabled ? 1 : 0).run();
  return c.json({ id, enabled });
});

app.post('/api/recipes/import', async c => {
  await requireModule(c.env.DB, 'recipes');
  const request = parseInput(importSchema, await readJson(c.req.raw, 6 * 1024 * 1024));
  // Only requests that can actually run spend quota; a mistyped link must not lock the member out.
  preflightImport(request, c.env);
  await consumeLimit(c.env.DB, `member:${c.get('user').id}:imports`, 10, 3600);
  await consumeLimit(c.env.DB, 'deployment:imports', 40, 86400);
  const result = await importRecipe(request, c.env);
  return c.json(result);
});

app.route('/api/inventory', inventoryRoutes);

app.get('/api/export', async c => {
  await consumeLimit(c.env.DB, `member:${c.get('user').id}:exports`, 10, 3600);
  c.header('Content-Disposition', `attachment; filename="hearth-export-${new Date().toISOString().slice(0, 10)}.json"`);
  const base = { exportedAt: new Date().toISOString(), scope: 'Records visible to the exporting member from enabled modules.', ...await bootstrap(c) };
  // Inventory is household-shared and opt-in: present only while its module is enabled. The
  // export carries the newest history entries; the full ledger stays in storage.
  if (!await inventoryEnabled(c.env.DB)) return c.json({ schemaVersion: 1, ...base });
  const newest = await readLedger(c.env.DB, null, 1001);
  return c.json({ schemaVersion: 2, ...base, inventory: { ...await readInventoryState(c.env.DB), ledger: newest.slice(0, 1000), ledgerTruncated: newest.length > 1000, cookings: (await readConsumptions(c.env.DB, null, 50)).entries } });
});

app.all('/api/*', c => c.json({ error: 'This API endpoint does not exist.' }, 404));
app.all('*', async c => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Hearth assets are not available.', 404));

app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
  if (error instanceof RecipeImportError) return c.json({ error: error.message }, error.status);
  console.error('Hearth request failed', { name: error.name });
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

export default app;
