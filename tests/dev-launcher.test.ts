import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLocalSession, checkPortAvailable, ensureLocalVars, localEnvironment, makeLocalWorkerConfig, parseOptions, ProcessSupervisor, waitReady,
} from '../scripts/dev.mjs';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const supervisors: ProcessSupervisor[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hearth-launcher-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function listeningServer() {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return { server, port: address.port };
}

async function closeServer(server: Server) {
  if (server.listening) await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(supervisors.splice(0).map(supervisor => supervisor.stop()));
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('local launcher options', () => {
  it('uses the documented development ports without ambient environment settings', () => {
    expect(parseOptions([], {})).toEqual({ apiPort: 8787, uiPort: 5173, help: false, check: false, skipBuild: false });
  });

  it('accepts environment overrides, with explicit flags taking precedence', () => {
    const environment = { HEARTH_API_PORT: '9001', HEARTH_UI_PORT: '9002' };
    expect(parseOptions([], environment)).toMatchObject({ apiPort: 9001, uiPort: 9002 });
    expect(parseOptions(['--api-port', '1024', '--ui-port', '65535', '--check', '--skip-build'], environment))
      .toEqual({ apiPort: 1024, uiPort: 65535, help: false, check: true, skipBuild: true });
    expect(parseOptions(['--api-port=9003', '--ui-port=9004'], environment)).toMatchObject({ apiPort: 9003, uiPort: 9004 });
    expect(parseOptions(['--help'], {})).toHaveProperty('help', true);
  });

  it.each(['0', '80', '1023', '65536', '-1', '1.5', 'NaN', '9001abc', '1e4', '', ' '])('rejects invalid port %j', port => {
    expect(() => parseOptions(['--api-port', port], {})).toThrow();
    expect(() => parseOptions(['--ui-port', port], {})).toThrow();
  });

  it.each([
    ['--api-port'], ['--ui-port'], ['--api-port', '--check'], ['--remote'],
    ['--host', '0.0.0.0'], ['unexpected-positional-argument'],
    ['--api-port', '9001', '--ui-port', '9001'],
    ['--api-port=9001=garbage'], ['--ui-port=9002=garbage'],
  ])('rejects missing arguments, unsupported options, and colliding ports: %j', (...args) => {
    expect(() => parseOptions(args, {})).toThrow();
  });

  it('validates environment ports and rejects collisions across option sources', () => {
    expect(() => parseOptions([], { HEARTH_API_PORT: 'invalid' })).toThrow();
    expect(() => parseOptions([], { HEARTH_UI_PORT: '65536' })).toThrow();
    expect(() => parseOptions(['--api-port', '9001'], { HEARTH_UI_PORT: '9001' })).toThrow();
  });

  it('prints CLI help without checking ports or invoking build tools', async () => {
    const directory = await temporaryDirectory();
    const api = await listeningServer();
    const ui = await listeningServer();
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/dev.mjs', import.meta.url)), '--help',
      '--api-port', String(api.port), '--ui-port', String(ui.port),
    ], {
      cwd: directory,
      env: { PATH: directory, HOME: directory, TMPDIR: directory },
      encoding: 'utf8', timeout: 5_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('--api-port');
    expect(child.stdout).toContain('--ui-port');
    expect(child.stderr).toBe('');
    expect(api.server.listening).toBe(true);
    expect(ui.server.listening).toBe(true);
    await expect(stat(join(directory, '.dev.vars'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('local configuration files', () => {
  it('removes Cloudflare credentials and disables network metadata and metrics without changing the parent environment', () => {
    const credentials = [
      'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID',
      'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'CF_ACCOUNT_ID',
    ];
    const disabled = ['CLOUDFLARE_CF_FETCH_ENABLED', 'WRANGLER_SEND_METRICS', 'CLOUDFLARE_INCLUDE_PROCESS_ENV'];
    for (const key of credentials) vi.stubEnv(key, 'fictional-credential-sentinel');
    for (const key of disabled) vi.stubEnv(key, 'true');
    vi.stubEnv('HEARTH_LAUNCHER_TEST_SETTING', 'preserve-this-local-setting');
    const before = { ...process.env };

    const environment = localEnvironment();

    for (const key of credentials) expect(Object.hasOwn(environment, key), key).toBe(false);
    for (const key of disabled) expect(environment[key]).toBe('false');
    expect(environment.HEARTH_LAUNCHER_TEST_SETTING).toBe('preserve-this-local-setting');
    // Compare as a boolean so a failure cannot print unrelated ambient credentials.
    expect(JSON.stringify(process.env) === JSON.stringify(before)).toBe(true);
  });

  it('creates the local vars file exclusively, with private permissions', async () => {
    const directory = await temporaryDirectory();
    const example = 'DEV_AUTH="true"\nFAMILY_TIMEZONE="UTC"\n';
    await writeFile(join(directory, '.dev.vars.example'), example);
    const results = await Promise.all(Array.from({ length: 4 }, () => ensureLocalVars(directory)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(join(directory, '.dev.vars'), 'utf8')).toBe(example);
    if (process.platform !== 'win32') expect((await stat(join(directory, '.dev.vars'))).mode & 0o777).toBe(0o600);
  });

  it('preserves an existing vars file and its metadata even when the example is absent', async () => {
    const directory = await temporaryDirectory();
    const filename = join(directory, '.dev.vars');
    const existing = 'FAMILY_MEMBERS="fictional-test-content-to-preserve"\n';
    await writeFile(filename, existing, { mode: 0o640 });
    const before = await stat(filename);
    expect(await ensureLocalVars(directory)).toBe(false);
    const after = await stat(filename);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.atimeMs).toBe(before.atimeMs);
    expect(await readFile(filename, 'utf8')).toBe(existing);
  });

  it('fails cleanly if a new local vars file has no example to copy', async () => {
    const directory = await temporaryDirectory();
    await expect(ensureLocalVars(directory)).rejects.toThrow();
    await expect(stat(join(directory, '.dev.vars'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('produces a local-only config without mutating or retaining production bindings', () => {
    const projectDirectory = resolve('/tmp', 'hearth-local-config-fixture');
    const productionMarker = 'production-config-must-not-survive';
    const base = {
      name: 'hearth-family', main: 'src/server/index.ts', compatibility_date: '2026-01-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: './dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
      d1_databases: [{ binding: 'DB', database_name: 'hearth-family', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations', remote: true, preview_database_id: productionMarker }],
      vars: { FAMILY_TIMEZONE: 'Europe/Paris', ACCESS_AUD: productionMarker, FAMILY_MEMBERS: productionMarker, DEV_AUTH: 'false' },
      account_id: productionMarker, route: productionMarker, routes: [productionMarker], workers_dev: true,
      ai: { binding: 'AI' }, kv_namespaces: [{ binding: 'CACHE', id: productionMarker }],
      r2_buckets: [{ binding: 'BUCKET', bucket_name: productionMarker }], services: [{ binding: 'SERVICE', service: productionMarker }],
      env: { production: { vars: { SECRET: productionMarker } } },
      unsafe: { bindings: [{ name: 'UNSAFE', type: productionMarker }] },
      observability: { enabled: true }, unknown_future_remote_binding: productionMarker,
    };
    const before = structuredClone(base);
    const local = makeLocalWorkerConfig(base, projectDirectory);
    expect(base).toEqual(before);
    expect(local.main).toBe(join(projectDirectory, 'src/server/index.ts'));
    expect(local.assets.directory).toBe(join(projectDirectory, 'dist'));
    expect(local.d1_databases).toHaveLength(1);
    expect(local.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'hearth-family', remote: false, migrations_dir: join(projectDirectory, 'migrations') });
    expect(local.vars).toEqual({ FAMILY_TIMEZONE: 'Europe/Paris' });
    for (const key of ['ai', 'account_id', 'route', 'routes', 'kv_namespaces', 'r2_buckets', 'services', 'env', 'unsafe', 'unknown_future_remote_binding']) {
      expect(local).not.toHaveProperty(key);
    }
    expect(local.workers_dev).not.toBe(true);
    expect(JSON.stringify(local)).not.toContain(productionMarker);
  });
});

describe('local service readiness', () => {
  it('verifies authenticated access using only status and discards private bootstrap data', async () => {
    const response = new Response(JSON.stringify({ members: ['private-bootstrap-sentinel'] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const json = vi.spyOn(response, 'json');
    const text = vi.spyOn(response, 'text');
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkLocalSession('http://127.0.0.1/api/bootstrap', AbortSignal.timeout(500))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it.each([
    { status: 401, guidance: '.dev.vars' },
    { status: 403, guidance: '.dev.vars' },
    { status: 503, guidance: '.dev.vars' },
    { status: 500, guidance: 'local D1 migrations' },
  ])('blocks startup after bootstrap HTTP $status without reading private details', async ({ status, guidance }) => {
    const sentinel = 'private-bootstrap-error-sentinel';
    const response = new Response(JSON.stringify({ error: sentinel }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    const json = vi.spyOn(response, 'json');
    const text = vi.spyOn(response, 'text');
    const cancel = vi.spyOn(response.body!, 'cancel');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = checkLocalSession('http://127.0.0.1/api/bootstrap', AbortSignal.timeout(500));

    await expect(result).rejects.toThrow(guidance);
    await expect(result).rejects.toThrow(`HTTP ${status}`);
    await expect(result).rejects.not.toThrow(sentinel);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it('accepts the API health response after consuming its JSON body', async () => {
    const response = new Response(JSON.stringify({ ok: true, service: 'hearth' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitReady('http://127.0.0.1/api/health', 'api', AbortSignal.timeout(500))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it('accepts an HTML UI response and releases the unread body', async () => {
    const response = new Response('<!doctype html><title>Hearth</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitReady('http://127.0.0.1/', 'ui', AbortSignal.timeout(500))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });
});

describe('local listener ownership', () => {
  it('reports a collision without closing the process using that port, and releases its own probe', async () => {
    const { server, port } = await listeningServer();
    await expect(checkPortAvailable(port)).rejects.toThrow();
    expect(server.listening).toBe(true);
    await closeServer(server);
    await expect(checkPortAvailable(port)).resolves.toBeUndefined();
    await expect(checkPortAvailable(port)).resolves.toBeUndefined();
  });

  it('reports command failures without leaving cleanup hanging', async () => {
    const supervisor = new ProcessSupervisor();
    supervisors.push(supervisor);
    const directory = await temporaryDirectory();
    const managed = supervisor.spawn(join(directory, 'command-does-not-exist'), [], { stdio: 'ignore', label: 'missing test command' });
    await expect(managed.exit).resolves.toMatchObject({ error: expect.any(Error) });
    await supervisor.stop();
    await supervisor.stop();
  });

  it('allows a completed setup command to be released before shutdown', async () => {
    const supervisor = new ProcessSupervisor();
    supervisors.push(supervisor);
    const managed = supervisor.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await expect(managed.exit).resolves.toMatchObject({ code: 0, signal: null });
    supervisor.release(managed);
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32').each([false, true])('stops owned descendants while preserving an unrelated listener (parent already exited: %s)', async parentExits => {
    const directory = await temporaryDirectory();
    const marker = join(directory, 'descendant-listener.json');
    const { server: unrelated, port: unrelatedPort } = await listeningServer();
    const supervisor = new ProcessSupervisor();
    supervisors.push(supervisor);
    const descendantSource = `
      const { createServer } = require('node:net');
      const { writeFileSync } = require('node:fs');
      const server = createServer();
      server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ port: server.address().port })));
      setTimeout(() => process.exit(0), 10000).unref();
    `;
    const parentSource = `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });
      ${parentExits ? 'process.exit(0);' : 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 10000).unref();'}
    `;
    const managed = supervisor.spawn(process.execPath, ['-e', parentSource], { stdio: 'ignore', label: 'owned test process' });
    let descendantPort = 0;
    await expect.poll(async () => {
      try {
        descendantPort = (JSON.parse(await readFile(marker, 'utf8')) as { port: number }).port;
        return descendantPort > 0;
      } catch { return false; }
    }, { timeout: 3_000 }).toBe(true);
    await expect(checkPortAvailable(descendantPort)).rejects.toThrow();
    if (parentExits) await expect(managed.exit).resolves.toMatchObject({ code: 0 });
    await Promise.all([supervisor.stop(), supervisor.stop()]);
    await expect.poll(async () => {
      try { await checkPortAvailable(descendantPort); return true; } catch { return false; }
    }, { timeout: 3_000 }).toBe(true);
    expect(unrelated.listening).toBe(true);
    await expect(checkPortAvailable(unrelatedPort)).rejects.toThrow();
  }, 10_000);
});
