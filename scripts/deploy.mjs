import { spawnSync } from 'node:child_process';
import { preflight, printPreflight, projectDirectory, configPath } from './preflight.mjs';

const result = preflight();
if (!printPreflight(result) || !result.deployment) process.exit(1);
const { databaseName, secrets } = result.deployment;

function run(command, args, options = {}) {
  const child = spawnSync(command, args, { cwd: projectDirectory, stdio: 'inherit', ...options });
  if (child.error || child.status !== 0) {
    console.error(`Deployment stopped: ${command} did not complete successfully.`);
    process.exit(child.status || 1);
  }
}

run('npm', ['run', 'check']);
run('npx', ['wrangler', 'd1', 'migrations', 'apply', databaseName, '--remote', '--config', configPath]);
// Configuration values go directly to Wrangler stdin and never become command arguments.
run('npx', ['wrangler', 'secret', 'bulk', '--config', configPath], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
run('npx', ['wrangler', 'deploy', '--config', configPath]);
