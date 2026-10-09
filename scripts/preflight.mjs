import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDeployment } from './deployment-config.mjs';

export const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
export const configPath = resolve(projectDirectory, 'wrangler.jsonc');

export function preflight(environment = process.env) {
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { return { problems: ['wrangler.jsonc must be valid JSON for deployment preflight.'] }; }
  const result = validateDeployment(config, environment);
  if (result.deployment) {
    try {
      const migrations = readdirSync(resolve(dirname(configPath), result.deployment.migrationsDirectory));
      if (!['0001_initial.sql', '0002_storage_budget.sql', '0003_passkey_foundation.sql', '0004_passkey_runtime.sql', '0005_passkey_browser_sessions.sql', '0006_passkey_credential_tombstones.sql', '0007_inventory_foundation.sql', '0008_modules_inventory.sql', '0009_inventory_mapping.sql', '0010_inventory_consumption.sql'].every(name => migrations.includes(name))) throw new Error('Missing schema');
    } catch { return { problems: ['The DB migrations directory must contain all Hearth schema migrations.'] }; }
  }
  return result;
}

export function printPreflight(result) {
  if (result.problems.length) {
    console.error(`Deployment is not ready:\n${result.problems.map(problem => ` • ${problem}`).join('\n')}`);
    return false;
  }
  console.log('Local deployment configuration checks passed. Passkey enrollment, credential permissions and real-device sign-in still require verification in the intended account.');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!printPreflight(preflight())) process.exitCode = 1;
}
