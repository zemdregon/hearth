import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Intentionally no options: only a new temporary local database is accepted.
// Applies the real migrations and exercises the production inventory routes on local D1.
assert.equal(process.argv.length, 2, 'This local-only probe accepts no arguments.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'hearth-inventory-api-'));
const token = randomBytes(32).toString('hex');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let worker;
let exited;
try {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = join(directory, 'wrangler.json');
  const state = join(directory, 'state');
  writeFileSync(config, JSON.stringify({
    name: 'hearth-inventory-api-probe',
    main: join(root, 'tests/fixtures/inventory-api-d1-worker.ts'),
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    vars: { PROBE_TOKEN: token },
    d1_databases: [{ binding: 'DB', database_name: 'inventory-api-synthetic', database_id: '11111111-1111-4111-8111-111111111111', migrations_dir: join(root, 'migrations'), remote: false }],
  }), { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, CI: 'true', CLOUDFLARE_ENV: '', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') };
  const migrate = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', state], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(migrate.status, 0, 'real migrations must apply to a fresh local D1');
  worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--show-interactive-dev-session', 'false'], {
    cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  worker.stdout.resume(); worker.stderr.resume();
  let startupError;
  exited = new Promise(resolve => { worker.once('error', error => { startupError = error; resolve(); }); worker.once('exit', resolve); });
  const call = (path, { method = 'GET', body, member = 'alex', headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-member': member, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const json = async response => ({ status: response.status, body: await response.json().catch(() => null) });
  const sql = async (statement, ...args) => {
    const { body } = await json(await call('/__sql', { method: 'POST', body: { statements: [{ sql: statement, args }] } }));
    return body.ok ? body.results[0] : Promise.reject(new Error(body.message));
  };
  const api = async (path, options) => json(await call(`/api/inventory${path}`, options));
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || worker.exitCode !== null || worker.signalCode !== null) throw new Error('Local probe Worker exited before readiness.');
    try { const response = await call('/health'); await response.body?.cancel(); if (response.ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert.ok(ready, 'Local probe readiness deadline');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 403, 'probe requires its temporary token');
  const pass = message => console.log(`PASS ${message}`);
  const txn = (() => { let n = 0; return () => `probe-txn-${String(++n).padStart(6, '0')}`; })();
  const count = async table => (await sql(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

  // Real migration state.
  assert.deepEqual(await sql("SELECT id, enabled FROM modules WHERE id = 'inventory'"), [{ id: 'inventory', enabled: 0 }]);
  const tables = (await sql("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'inv_%' ORDER BY name")).map(row => row.name);
  assert.deepEqual(tables, ['inv_aliases', 'inv_assert', 'inv_calibrations', 'inv_consumptions', 'inv_items', 'inv_ledger', 'inv_locations', 'inv_lots', 'inv_settings', 'inv_storage', 'inv_txns']);
  assert.ok((await sql("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'inv_%'"))[0].n === 19);
  pass('migrations 0001-0010 apply to a fresh local D1; inventory module row exists and is disabled');

  assert.equal((await api('')).status, 403);
  assert.equal((await api('/items', { method: 'POST', body: { name: 'Flour', dim: 'mass' } })).status, 403);
  await sql("UPDATE modules SET enabled = 1 WHERE id = 'inventory'");
  await sql(`INSERT INTO auth_members (id,name,role,color,status,user_handle,created_at,updated_at) VALUES
    ('alex','alex','admin','#000000','active','${'a'.repeat(43)}',1,1),('sam','sam','member','#000000','active','${'b'.repeat(43)}',1,1)`);
  pass('disabled module is forbidden; enabling it opens the routes');

  const flour = (await api('/items', { method: 'POST', body: { name: 'Flour', dim: 'mass' } })).body;
  assert.equal((await api('/items', { method: 'POST', body: { name: ' flour ', dim: 'mass' } })).status, 409);
  const pantry = (await api('/locations', { method: 'POST', body: { name: 'Pantry', kind: 'pantry' } })).body;
  const add = { txnId: txn(), itemId: flour.id, locationId: pantry.id, amount: '1 1/2', unit: 'lb', precision: 'exact', note: '' };
  const added = await api('/lots', { method: 'POST', body: add });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const lot = added.body.lots[0];
  assert.equal(lot.qty, 680_388_555_000);
  const replay = await api('/lots', { method: 'POST', body: add });
  assert.deepEqual([replay.status, replay.body.replayed, await count('inv_lots'), await count('inv_ledger')], [200, true, 1, 1]);
  assert.equal((await api('/lots', { method: 'POST', body: { ...add, amount: '2' } })).status, 409);
  assert.equal((await api('/lots', { method: 'POST', body: add, member: 'sam' })).status, 409);
  pass('catalog, exact lb conversion, idempotent replay and txn-id conflicts on D1');

  const read = await call('/api/inventory');
  const tag = read.headers.get('etag');
  assert.equal((await read.json()).lots.length, 1);
  assert.equal((await call('/api/inventory', { headers: { 'If-None-Match': tag } })).status, 304);
  pass('conditional read returns 304');

  const stale = await api(`/lots/${lot.id}/adjust`, { method: 'POST', body: { txnId: txn(), version: 99, mode: 'add', amount: '1', unit: 'kg', reason: '' } });
  assert.equal(stale.status, 409);
  const over = await api(`/lots/${lot.id}/adjust`, { method: 'POST', body: { txnId: txn(), version: 1, mode: 'remove', amount: '5', unit: 'kg', reason: '' } });
  assert.equal(over.status, 409);
  assert.deepEqual([await count('inv_ledger'), await count('inv_txns')], [1, 1]);
  pass('stale versions and overdraw fail with no partial writes');

  const body = (mode, amount, id = txn(), version = 1) => ({ txnId: id, version, mode, amount, unit: 'g', reason: '' });
  const race = await Promise.all([api(`/lots/${lot.id}/adjust`, { method: 'POST', body: body('remove', '100') }), api(`/lots/${lot.id}/adjust`, { method: 'POST', body: body('remove', '200') })]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409], JSON.stringify(race));
  assert.equal(await count('inv_ledger'), 2);
  const retryId = txn();
  const retries = await Promise.all([1, 2].map(() => api(`/lots/${lot.id}/adjust`, { method: 'POST', body: body('add', '50', retryId, 2) })));
  assert.deepEqual(retries.map(result => result.status), [200, 200], JSON.stringify(retries));
  assert.equal(await count('inv_ledger'), 3);
  pass('concurrent versioned writes have one winner; concurrent identical retries apply once');

  const next = (await api('')).body.lots[0];
  const archived = await api(`/lots/${next.id}/archive`, { method: 'POST', body: { txnId: txn(), version: next.version, reason: 'Used up' } });
  assert.equal(archived.status, 200);
  assert.equal((await api(`/items/${flour.id}/archive`, { method: 'POST', body: { version: 1 } })).status, 200);
  assert.equal((await api(`/locations/${pantry.id}/archive`, { method: 'POST', body: { version: 1 } })).status, 200);
  assert.equal((await api('/lots', { method: 'POST', body: { ...add, txnId: txn() } })).status, 404);
  pass('archiving lot, then item and location, succeeds; stock cannot be added to archived rows');

  const guarded = await api('/items', { method: 'POST', body: { name: 'Sugar', dim: 'mass' } });
  const sugar = guarded.body;
  await sql('UPDATE inv_storage SET ledger_count = 100000');
  const before = [await count('inv_lots'), await count('inv_txns'), await count('inv_ledger')];
  const full = await api('/lots', { method: 'POST', body: { ...add, itemId: sugar.id, locationId: null, txnId: txn() } });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full/);
  assert.deepEqual([await count('inv_lots'), await count('inv_txns'), await count('inv_ledger')], before);
  await sql('UPDATE inv_storage SET ledger_count = 3');
  pass('a late trigger failure inside the batch rolls back lot, transaction and ledger rows');

  for (const statement of ['UPDATE inv_ledger SET delta = 0', 'DELETE FROM inv_ledger', "UPDATE inv_txns SET kind = 'add'", 'DELETE FROM inv_txns']) {
    await assert.rejects(() => sql(statement), /INVENTORY_LEDGER_IMMUTABLE/, statement);
  }
  pass('ledger and transaction immutability triggers fire on D1');

  // Recipe mapping, conversions, settings and availability on D1.
  const rice = (await api('/items', { method: 'POST', body: { name: 'Rice', dim: 'mass' } })).body;
  assert.equal((await api('/lots', { method: 'POST', body: { txnId: txn(), itemId: rice.id, locationId: null, amount: '300', unit: 'g', precision: 'exact', note: '' } })).status, 201);
  const alias = await api('/aliases', { method: 'POST', body: { name: 'Basmati  Rice', itemId: rice.id } });
  assert.equal(alias.status, 201, JSON.stringify(alias.body));
  assert.equal((await api('/aliases', { method: 'POST', body: { name: 'basmati rice', itemId: rice.id } })).status, 409);
  const setup = await api('');
  assert.equal((await api('/settings', { method: 'PUT', body: { measureProfile: 'us-label', version: setup.body.settings.version }, member: 'sam' })).status, 403);
  assert.equal((await api('/settings', { method: 'PUT', body: { measureProfile: 'us-label', version: setup.body.settings.version } })).status, 200);
  const cal = { itemId: rice.id, fromAmount: '1', fromUnit: 'cup', fromProfile: 'us-label', toAmount: '200', toUnit: 'g' };
  assert.equal((await api('/calibrations', { method: 'POST', body: cal })).status, 201);
  const dupe = await api('/calibrations', { method: 'POST', body: { ...cal, fromAmount: '2', toAmount: '400' } });
  assert.equal(dupe.status, 409, JSON.stringify(dupe.body));
  await sql("INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) VALUES ('recipe-1', 'recipe', 'alex', ?, 'a', 'a', 1)", JSON.stringify({ title: 'Rice', description: '', servings: 2, prepMinutes: 1, cookMinutes: 1, ingredients: [{ name: 'Basmati rice', quantity: 1, unit: 'cup' }, { name: 'Salt', quantity: 1, unit: 'tsp' }], steps: ['Cook'], tags: [], favorite: false }));
  const verdict = await api('/availability', { method: 'POST', body: { recipeId: 'recipe-1', servings: 2, exclude: [] } });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  assert.deepEqual([verdict.body.verdict, verdict.body.unmapped.map(line => line.name), verdict.body.items[0].verdict, verdict.body.items[0].reasons], ['unknown', ['Salt'], 'sufficient', ['ACCEPTED_CALIBRATION']]);
  const scaled = await api('/availability', { method: 'POST', body: { recipeId: 'recipe-1', servings: 4, exclude: [1] } });
  assert.deepEqual([scaled.body.verdict, scaled.body.items[0].short], ['insufficient', { lo: 100_000_000_000, hi: 100_000_000_000 }]);
  await sql("DELETE FROM records WHERE id = 'recipe-1'");
  pass('mappings, one-per-pair conversions, admin-only convention and availability work on D1');

  // Confirmed cooking and undo on D1 (set-based json_each batches, numbered parameters).
  const flourItem = (await api('/items', { method: 'POST', body: { name: 'Plain flour', dim: 'mass' } })).body;
  const mk = async (amount, extra = {}) => (await api('/lots', { method: 'POST', body: { txnId: txn(), itemId: flourItem.id, locationId: null, amount, unit: 'g', precision: 'exact', note: '', ...extra } })).body.lots[0];
  const lotA = await mk('200', { dateKind: 'best_by', date: '2027-01-01' });
  const lotB = await mk('500');
  await api('/aliases', { method: 'POST', body: { name: 'plain flour', itemId: flourItem.id } });
  await sql("INSERT INTO records (id, kind, owner_id, data, created_at, updated_at, version) VALUES ('recipe-2', 'recipe', 'alex', ?, 'a', 'a', 1)", JSON.stringify({ title: 'Bread', description: '', servings: 2, prepMinutes: 1, cookMinutes: 1, ingredients: [{ name: 'Plain flour', quantity: 300, unit: 'g' }], steps: ['Bake'], tags: [], favorite: false }));
  const plan = (await api('/consume/preview', { method: 'POST', body: { recipeId: 'recipe-2', servings: 2, exclude: [] } })).body;
  const takes = plan.lines[0].allocations.filter(a => a.take > 0).map(a => ({ lotId: a.lotId, version: a.version, take: a.take }));
  assert.deepEqual(takes.map(t => t.take), [200_000_000_000, 100_000_000_000]);
  const cookId = txn();
  const cookBody = { txnId: cookId, recipeId: 'recipe-2', servings: 2, takes, shortfalls: [] };
  const cooked = await api('/consume', { method: 'POST', body: cookBody });
  assert.equal(cooked.status, 201, JSON.stringify(cooked.body));
  assert.deepEqual((await sql(`SELECT id, qty, version FROM inv_lots WHERE id IN ('${lotA.id}','${lotB.id}') ORDER BY qty`)).map(r => [r.qty, r.version]), [[0, 2], [400_000_000_000, 2]]);
  assert.equal((await api('/consume', { method: 'POST', body: cookBody })).body.replayed, true);
  const raceCook = await Promise.all([txn(), txn()].map(id => api('/consume', { method: 'POST', body: { ...cookBody, txnId: id, takes: [{ lotId: lotB.id, version: 2, take: 1_000_000_000 }] } })));
  assert.deepEqual(raceCook.map(r => r.status).sort(), [201, 409], JSON.stringify(raceCook));
  assert.equal((await api(`/txns/${cookId}/undo`, { method: 'POST', body: { txnId: txn() } })).status, 409, 'later activity on a lot makes undo inexact');
  const secondPlan = (await api('/consume/preview', { method: 'POST', body: { recipeId: 'recipe-2', servings: 2, exclude: [] } })).body;
  assert.equal(secondPlan.lines[0].allocations.find(a => a.lotId === lotB.id).available, 399_000_000_000);
  // A clean cooking can be undone exactly once.
  const lotC = await mk('50');
  const cook2 = txn();
  assert.equal((await api('/consume', { method: 'POST', body: { txnId: cook2, recipeId: 'recipe-2', servings: 2, takes: [{ lotId: lotC.id, version: 1, take: 20_000_000_000 }], shortfalls: [] } })).status, 201);
  const undoId = txn();
  assert.equal((await api(`/txns/${cook2}/undo`, { method: 'POST', body: { txnId: undoId } })).status, 201);
  assert.equal((await sql(`SELECT qty FROM inv_lots WHERE id = '${lotC.id}'`))[0].qty, 50_000_000_000);
  assert.equal((await api(`/txns/${cook2}/undo`, { method: 'POST', body: { txnId: txn() } })).status, 409);
  assert.equal((await api(`/txns/${cook2}/undo`, { method: 'POST', body: { txnId: undoId } })).body.replayed, true);
  const history = (await api('/consumptions')).body.entries;
  assert.deepEqual(history.map(entry => [entry.recipeTitle, entry.reverses === cook2, entry.canUndo]), [['Bread', true, false], ['Bread', false, false], ['Bread', false, true], ['Bread', false, false]]); // undo, undone cooking, the untouched race winner, the first cooking (later activity)
  await assert.rejects(() => sql('DELETE FROM inv_consumptions'), /INVENTORY_LEDGER_IMMUTABLE/);
  await sql("DELETE FROM records WHERE id = 'recipe-2'");
  pass('cooking preview, atomic multi-lot consume, one race winner, exact undo-once and history work on D1');

  // Habit backfill batch (json_each INSERT ... RETURNING) on D1, including all-or-nothing rollback.
  const created = (await json(await call('/__habit', { method: 'POST', body: { dates: ['2026-10-01', '2026-10-02', '2026-10-03'] } }))).body;
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.deepEqual(await sql("SELECT kind, COUNT(*) AS n FROM records GROUP BY kind ORDER BY kind"), [{ kind: 'habit', n: 1 }, { kind: 'habitLog', n: 3 }]);
  const accounting = (await sql('SELECT data_bytes, record_count FROM family_storage'))[0];
  const actual = (await sql('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes, COUNT(*) AS n FROM records'))[0];
  assert.deepEqual([accounting.data_bytes, accounting.record_count], [actual.bytes, actual.n]);
  assert.equal((await sql("SELECT json_extract(data, '$.habitId') AS h FROM records WHERE kind = 'habitLog' LIMIT 1"))[0].h, created.id);
  await sql('UPDATE family_storage SET record_count = 9998 WHERE id = 1');
  const rowsBefore = await count('records');
  const refused = (await json(await call('/__habit', { method: 'POST', body: { dates: ['2026-09-01', '2026-09-02', '2026-09-03'] } }))).body;
  assert.equal(refused.ok, false);
  assert.match(refused.message, /storage is full/);
  assert.equal(await count('records'), rowsBefore, 'a failed backfill must not leave the habit behind');
  await sql('UPDATE family_storage SET record_count = 4 WHERE id = 1');
  pass('habit with retroactive check-ins commits as one batch on D1; over-budget history rolls the habit back');

  assert.deepEqual(await sql('PRAGMA foreign_key_check'), []);
  assert.equal((await sql('PRAGMA quick_check'))[0].quick_check, 'ok');
  pass('foreign_key_check is empty and quick_check is ok');
  console.log('Inventory API probe passed on isolated local Wrangler D1. Remote D1 remains unverified.');
} finally {
  if (worker?.pid) {
    const signal = value => { try { if (process.platform === 'win32') worker.kill(value); else process.kill(-worker.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    signal('SIGTERM');
    await Promise.race([exited, pause(5000)]);
    if (worker.exitCode === null && worker.signalCode === null) { signal('SIGKILL'); await exited; }
  }
  if (!process.env.KEEP_PROBE) rmSync(directory, { recursive: true, force: true }); else console.log(directory);
}
