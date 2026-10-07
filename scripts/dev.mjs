import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTimezone } from '../src/server/config.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const loopback = '127.0.0.1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseOptions(args, environment = {}) {
  const values = { api: environment.HEARTH_API_PORT ?? '8787', ui: environment.HEARTH_UI_PORT ?? '5173' };
  const result = { help: false, check: false, skipBuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--check') result.check = true;
    else if (argument === '--skip-build') result.skipBuild = true;
    else if (/^--(?:api|ui)-port(?:=|$)/.test(argument)) {
      const separator = argument.indexOf('=');
      const flag = separator === -1 ? argument : argument.slice(0, separator);
      const assigned = separator === -1 ? undefined : argument.slice(separator + 1);
      const value = assigned ?? args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a port number.`);
      values[flag === '--api-port' ? 'api' : 'ui'] = value;
    } else throw new Error('Unknown launcher option. Run with --help for supported options.');
  }
  const port = (value, name) => {
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`${name} must be a port from 1024 to 65535.`);
    return Number(value);
  };
  const apiPort = port(values.api, 'API port');
  const uiPort = port(values.ui, 'UI port');
  if (apiPort === uiPort) throw new Error('API and UI ports must be different.');
  return { ...result, apiPort, uiPort };
}

export async function ensureLocalVars(directory) {
  const target = resolve(directory, '.dev.vars');
  try {
    if (!(await stat(target)).isFile()) throw new Error('Existing .dev.vars must be a file.');
    return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await copyFile(resolve(directory, '.dev.vars.example'), target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Could not create local .dev.vars from .dev.vars.example.');
    if (!(await stat(target)).isFile()) throw new Error('Existing .dev.vars must be a file.');
    return false;
  }
}

export function makeLocalWorkerConfig(base, directory) {
  if (!object(base)) throw new Error('Wrangler configuration must be a JSON object.');
  const databases = Array.isArray(base.d1_databases) ? base.d1_databases.filter(database => object(database) && database.binding === 'DB') : [];
  if (databases.length !== 1) throw new Error('Configure exactly one local D1 database with binding DB.');
  const database = databases[0];
  if (typeof database.database_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(database.database_name)) throw new Error('DB needs a valid database_name.');
  if (typeof database.database_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database.database_id)) throw new Error('DB needs a UUID database_id; the placeholder works locally.');
  let timezone;
  try { timezone = parseTimezone(object(base.vars) ? base.vars.FAMILY_TIMEZONE : undefined); }
  catch { throw new Error('FAMILY_TIMEZONE must be a valid IANA timezone.'); }
  return {
    name: 'hearth-local',
    main: resolve(directory, typeof base.main === 'string' ? base.main : 'src/server/index.ts'),
    compatibility_date: typeof base.compatibility_date === 'string' ? base.compatibility_date : '2026-01-01',
    compatibility_flags: Array.isArray(base.compatibility_flags) ? base.compatibility_flags.filter(flag => typeof flag === 'string') : ['nodejs_compat'],
    assets: { directory: resolve(directory, typeof base.assets?.directory === 'string' ? base.assets.directory : 'dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'DB', database_name: database.database_name, database_id: database.database_id, migrations_dir: resolve(directory, typeof database.migrations_dir === 'string' ? database.migrations_dir : 'migrations'), remote: false }],
    vars: { FAMILY_TIMEZONE: timezone },
    workers_dev: false, preview_urls: false, send_metrics: false, observability: { enabled: false },
  };
}

export function checkPortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is unavailable on ${loopback}. Stop the existing server or choose another port.`)));
    server.listen({ port, host: loopback, exclusive: true }, () => server.close(error => error ? reject(error) : resolvePort()));
  });
}

export class ProcessSupervisor {
  children = new Set();
  stopping;

  spawn(command, args, options = {}) {
    if (this.stopping) throw new Error('The launcher is stopping.');
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env,
      detached: process.platform !== 'win32',
      stdio: options.stdio === 'ignore' ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      // Only the fixed npm build command uses a Windows shell; server binaries run via Node.
      shell: process.platform === 'win32' && command === 'npm',
    });
    const managed = {
      child,
      label: options.label || 'Child process',
      exit: new Promise(resolveExit => {
        child.once('error', error => resolveExit({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      }),
    };
    this.children.add(managed);
    return managed;
  }

  release(managed) { this.children.delete(managed); }

  stop(signal = 'SIGTERM') {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopChildren(signal);
    return this.stopping;
  }

  async stopChildren(signal) {
    const children = [...this.children];
    const terminate = (managed, requestedSignal) => {
      const pid = managed.child.pid;
      if (!pid) return;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-pid, requestedSignal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    for (const managed of children) terminate(managed, signal);
    await Promise.race([Promise.all(children.map(managed => managed.exit)), delay(2000, undefined, { ref: false })]);
    // Include descendants left after their direct parent exits, using only groups we created.
    for (const managed of children) terminate(managed, 'SIGKILL');
    this.children.clear();
  }
}

export function localEnvironment() {
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', CI: 'true', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'CF_ACCOUNT_ID']) delete environment[key];
  return environment;
}

export async function waitReady(url, service, signal) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Launcher interrupted.');
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), redirect: 'error' });
      if (response.ok) {
        if (service === 'ui' && response.headers.get('Content-Type')?.includes('text/html')) {
          await response.body?.cancel();
          return;
        }
        if (service === 'api') {
          const health = await response.json();
          if (health.ok === true && health.service === 'hearth') return;
        }
      }
      if (!response.bodyUsed) await response.body?.cancel();
    } catch { if (signal.aborted) throw new Error('Launcher interrupted.'); }
    await delay(250, undefined, { signal });
  }
  throw new Error(`${service === 'api' ? 'Local API' : 'Vite'} did not become ready within 60 seconds.`);
}

export async function checkLocalSession(url, signal) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' }); }
  catch { throw new Error('Could not verify local family access. Check the API startup logs.'); }
  // Check status only; never parse or display the member's bootstrap data.
  await response.body?.cancel();
  if ([401, 403, 503].includes(response.status)) throw new Error(`Local family access is not ready (HTTP ${response.status}). Check DEV_AUTH, FAMILY_MEMBERS and FAMILY_TIMEZONE in .dev.vars; existing settings were preserved.`);
  if (response.status !== 200) throw new Error(`Local family data could not load (HTTP ${response.status}). Check API logs and local D1 migrations.`);
}

async function launch(options) {
  const supervisor = new ProcessSupervisor();
  const controller = new AbortController();
  const environment = localEnvironment();
  let runtimeDirectory;
  let interrupted;
  const onSignal = signal => {
    if (interrupted) return;
    interrupted = signal;
    controller.abort();
    void supervisor.stop(signal);
  };
  const handleInterrupt = () => onSignal('SIGINT');
  const handleTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleTerminate);

  const command = (label, executable, args) => supervisor.spawn(executable, args, { cwd: projectDirectory, env: environment, label });
  const run = async (label, executable, args) => {
    const managed = command(label, executable, args);
    const outcome = await managed.exit;
    if (outcome.error || outcome.code !== 0) throw new Error(`${label} failed; local startup stopped.`);
    supervisor.release(managed);
  };
  const serverReady = async (managed, url, service) => Promise.race([
    waitReady(url, service, controller.signal),
    managed.exit.then(() => { throw new Error(`${managed.label} stopped before it was ready.`); }),
  ]);

  try {
    const base = JSON.parse(await readFile(resolve(projectDirectory, 'wrangler.jsonc'), 'utf8'));
    const local = makeLocalWorkerConfig(base, projectDirectory);
    const wrangler = resolve(projectDirectory, 'node_modules/wrangler/bin/wrangler.js');
    const vite = resolve(projectDirectory, 'node_modules/vite/bin/vite.js');
    await Promise.all([access(wrangler), access(vite)]).catch(() => { throw new Error('Install project dependencies with npm ci before starting local development.'); });
    await Promise.all([checkPortAvailable(options.apiPort), checkPortAvailable(options.uiPort)]);
    if (options.check) {
      console.log(`Local launcher checks passed. API port ${options.apiPort} and UI port ${options.uiPort} are available. No files changed or services started.`);
      return;
    }
    const created = await ensureLocalVars(projectDirectory);
    console.log(created ? 'Created .dev.vars from the local example. The shipped sample signs in as Alex (alex@example.test), with Sam as a second member.' : 'Using existing .dev.vars unchanged. Local identity values are not displayed.');
    if (!options.skipBuild) await run('Production asset build', 'npm', ['run', 'build']);
    else await access(resolve(local.assets.directory, 'index.html')).catch(() => { throw new Error('--skip-build needs an existing production build. Run npm run build first.'); });
    if (controller.signal.aborted) throw new Error('Launcher interrupted.');
    const runtimeRoot = resolve(projectDirectory, '.wrangler/dev-launcher');
    await mkdir(runtimeRoot, { recursive: true });
    runtimeDirectory = await mkdtemp(resolve(runtimeRoot, 'session-'));
    const configPath = resolve(runtimeDirectory, 'wrangler.json');
    const viteConfig = resolve(runtimeDirectory, 'vite.config.mjs');
    const origin = `http://localhost:${options.uiPort}`;
    await writeFile(configPath, JSON.stringify(local), { mode: 0o600 });
    await writeFile(viteConfig, `import { mergeConfig } from 'vite';\nimport base from ${JSON.stringify(pathToFileURL(resolve(projectDirectory, 'vite.config.ts')).href)};\nexport default mergeConfig(base, { server: { host: ${JSON.stringify(loopback)}, port: ${options.uiPort}, strictPort: true, proxy: { '/api': ${JSON.stringify(`http://${loopback}:${options.apiPort}`)} } } });\n`, { mode: 0o600 });
    const common = ['--config', configPath, '--persist-to', resolve(projectDirectory, '.wrangler/state'), '--env-file', resolve(projectDirectory, '.dev.vars')];
    await run('Local D1 migrations', process.execPath, [wrangler, 'd1', 'migrations', 'apply', local.d1_databases[0].database_name, '--local', ...common]);
    await Promise.all([checkPortAvailable(options.apiPort), checkPortAvailable(options.uiPort)]);
    const api = command('Local API', process.execPath, [wrangler, 'dev', '--local', '--ip', loopback, '--port', String(options.apiPort), '--inspector-port', '0', '--log-level', 'warn', '--show-interactive-dev-session', 'false', '--var', `APP_ORIGIN:${origin}`, ...common]);
    await serverReady(api, `http://${loopback}:${options.apiPort}/api/health`, 'api');
    await checkLocalSession(`http://${loopback}:${options.apiPort}/api/bootstrap`, controller.signal);
    const ui = command('Vite', process.execPath, [vite, '--config', viteConfig, '--host', loopback, '--port', String(options.uiPort), '--strictPort']);
    await serverReady(ui, `http://${loopback}:${options.uiPort}/`, 'ui');
    console.log(`\nHearth is ready at ${origin}\nAPI: http://${loopback}:${options.apiPort}\nLocal D1 data persists in .wrangler/state. Workers AI is disabled in this local session.\nPress Ctrl+C to stop both services.`);
    const stopped = await Promise.race([api.exit.then(() => api.label), ui.exit.then(() => ui.label)]);
    if (!interrupted) throw new Error(`${stopped} stopped unexpectedly; both local services are shutting down.`);
  } finally {
    controller.abort();
    await supervisor.stop(interrupted || 'SIGTERM');
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTerminate);
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  }
}

const help = `Hearth local development\n\nUsage: node scripts/dev.mjs [options]\n\n  --api-port NUMBER  Local API port (default 8787; HEARTH_API_PORT)\n  --ui-port NUMBER   Browser/Vite port (default 5173; HEARTH_UI_PORT)\n  --check            Validate local configuration and available ports only\n  --skip-build       Reuse an existing production asset build\n  --help            Show this help\n\nBuilds assets, applies local D1 migrations, then starts the API and Vite.\nExisting .dev.vars is preserved; a missing file is copied from the sample.\nNo Cloudflare account is required. The launcher disables remote bindings and AI.\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2), process.env);
    if (options.help) console.log(help);
    else await launch(options);
  } catch (error) {
    if (process.exitCode !== 130 && process.exitCode !== 143) {
      console.error(error instanceof SyntaxError ? 'Could not read wrangler.jsonc as JSON.' : error.message);
      process.exitCode = 1;
    }
  }
}
