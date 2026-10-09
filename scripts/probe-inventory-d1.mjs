import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Intentionally no options: only a new temporary local database is accepted.
// Never uses project Wrangler config, existing persistence, credentials or data.
assert.equal(process.argv.length, 2, 'This local-only probe accepts no arguments.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'hearth-inventory-probe-'));
const token = randomBytes(32).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let worker;
let exited;
try {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({
    name: 'hearth-inventory-local-probe',
    main: join(root, 'tests/fixtures/inventory-d1-worker.mjs'),
    compatibility_date: '2026-10-01',
    workers_dev: false,
    vars: { PROBE_TOKEN: token },
    d1_databases: [{ binding: 'DB', database_name: 'inventory-synthetic', database_id: '11111111-1111-4111-8111-111111111111', remote: false }],
  }), { mode: 0o600, flag: 'wx' });
  worker = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config,
    '--persist-to', join(directory, 'state'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--show-interactive-dev-session', 'false'], {
    cwd: directory,
    env: { ...process.env, CI: 'true', CLOUDFLARE_ENV: '', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  // Wrangler may log bindings, including this temporary token; keep logs private.
  worker.stdout.resume(); worker.stderr.resume();
  let startupError;
  exited = new Promise(resolve => { worker.once('error', error => { startupError = error; resolve(); }); worker.once('exit', resolve); });
  const request = (name, method = 'GET') => fetch(`http://127.0.0.1:${port}/${name}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError || worker.exitCode !== null || worker.signalCode !== null) throw new Error('Local probe Worker exited before readiness.');
    try { const response = await request('health'); await response.body?.cancel(); if (response.ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert.ok(ready, 'Local probe readiness deadline');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 403, 'probe requires its temporary token');
  for (const name of ['setup', 'consume', 'rollback', 'race', 'replay', 'guards', 'ledger', 'undo', 'bulk']) {
    const response = await request(name, 'POST');
    const result = await response.json();
    assert.equal(response.status, 200, `${name}: ${result.message}`);
    assert.equal(result.ok, true, name);
    console.log(`PASS ${name}: ${result.message}`);
  }
  console.log('Inventory transaction probe passed on isolated local Wrangler D1. Remote D1 remains unverified.');
} finally {
  if (worker?.pid) {
    const signal = value => { try { if (process.platform === 'win32') worker.kill(value); else process.kill(-worker.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    signal('SIGTERM');
    await Promise.race([exited, pause(5000)]);
    if (worker.exitCode === null && worker.signalCode === null) { signal('SIGKILL'); await exited; }
  }
  rmSync(directory, { recursive: true, force: true });
}
