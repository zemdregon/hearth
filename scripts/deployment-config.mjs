import { parseTimezone } from '../src/server/config.mjs';

const requiredSecretNames = ['APP_ORIGIN', 'WEBAUTHN_RP_ID'];
export const deploymentSecretNames = [...requiredSecretNames, 'FAMILY_QUESTION_PAIR'];
const requiredNames = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', ...requiredSecretNames];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reservedHostname = hostname => hostname === 'localhost' || /(?:^|\.)(?:example\.(?:com|net|org)|test|invalid|example|localhost)$/.test(hostname);

/** Pure validation: never includes a supplied secret, token, or identity in errors. */
export function validateDeployment(config, environment) {
  const problems = [];
  if (!isObject(config)) return { problems: ['Wrangler configuration must be a JSON object.'] };
  for (const name of requiredNames) {
    if (typeof environment[name] !== 'string' || !environment[name].trim()) problems.push(`${name} is required.`);
  }
  if (environment.DEV_AUTH !== undefined && environment.DEV_AUTH !== 'false') problems.push('DEV_AUTH must be unset or false for deployment.');
  if (config.workers_dev !== false) problems.push('workers_dev must be explicitly false; publish only on the canonical passkey hostname.');
  if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(config.name)) problems.push('Set a valid Worker name in wrangler.jsonc.');
  if (config.account_id !== undefined && config.account_id !== environment.CLOUDFLARE_ACCOUNT_ID) problems.push('Wrangler account_id must match CLOUDFLARE_ACCOUNT_ID, or be omitted.');

  const vars = config.vars === undefined ? {} : config.vars;
  if (!isObject(vars)) problems.push('Worker vars must be a JSON object.');
  else {
    if (['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'FAMILY_MEMBERS'].some(name => name in vars)) problems.push('Remove legacy Access and email roster settings from Worker vars.');
    if ('DEV_AUTH' in vars) problems.push('Remove DEV_AUTH from Worker vars; deployment pins it to false as a secret.');
    if (deploymentSecretNames.some(name => name in vars)) problems.push('Passkey and family settings must come from deployment environment secrets, not Worker vars.');
    try { parseTimezone(vars.FAMILY_TIMEZONE); }
    catch { problems.push('FAMILY_TIMEZONE in Worker vars must be a valid IANA timezone.'); }
  }

  const bindings = Array.isArray(config.d1_databases) ? config.d1_databases.filter(database => isObject(database) && database.binding === 'DB') : [];
  const database = bindings[0];
  if (bindings.length !== 1) problems.push('Configure exactly one D1 database with binding DB.');
  if (database) {
    if (typeof database.database_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(database.database_name)) problems.push('The DB binding needs a valid database_name.');
    if (typeof database.database_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database.database_id) || !/[1-9a-f]/i.test(database.database_id)) problems.push('Replace the placeholder DB database_id with a provisioned D1 UUID.');
    if (database.migrations_dir !== undefined && (typeof database.migrations_dir !== 'string' || !database.migrations_dir.trim())) problems.push('DB migrations_dir must be a nonempty directory path.');
  }

  for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'FAMILY_MEMBERS']) {
    if (environment[name] !== undefined) problems.push(`Remove legacy ${name} from deployment configuration.`);
  }
  let origin;
  if (environment.APP_ORIGIN) {
    try {
      const url = new URL(environment.APP_ORIGIN);
      if (url.protocol !== 'https:' || url.origin !== environment.APP_ORIGIN || url.username || url.password || url.port || !url.hostname.includes('.') || reservedHostname(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw new Error('Invalid origin');
      origin = url.origin;
    } catch { problems.push('APP_ORIGIN must be the exact public HTTPS origin, without path, trailing slash, credentials, or custom port.'); }
  }

  const hasRoute = config.route !== undefined;
  const hasRoutes = config.routes !== undefined;
  if (hasRoute && hasRoutes) problems.push('Use routes or route in Wrangler configuration, not both.');
  const routes = hasRoutes ? config.routes : hasRoute ? [config.route] : [];
  if (!Array.isArray(routes) || !routes.length || routes.length > 20) problems.push('Configure a route for the full canonical APP_ORIGIN hostname.');
  else {
    for (const route of routes) {
      const entry = typeof route === 'string' ? { pattern: route } : route;
      if (!isObject(entry) || typeof entry.pattern !== 'string' || (entry.custom_domain !== undefined && typeof entry.custom_domain !== 'boolean')) {
        problems.push('Each route must be a valid pattern string or a route object.');
        continue;
      }
      if (origin) {
        const hostname = new URL(origin).hostname;
        const valid = entry.custom_domain === true ? entry.pattern === hostname : [`${hostname}/*`, `https://${hostname}/*`].includes(entry.pattern);
        if (!valid) problems.push('Every route must cover the exact APP_ORIGIN hostname and all paths; use a matching custom domain or hostname/*.');
      }
    }
  }

  if (origin && environment.WEBAUTHN_RP_ID !== new URL(origin).hostname) problems.push('WEBAUTHN_RP_ID must exactly match the APP_ORIGIN hostname.');
  let questionPair = null;
  if (environment.FAMILY_QUESTION_PAIR !== undefined) {
    try {
      questionPair = JSON.parse(environment.FAMILY_QUESTION_PAIR);
      if (questionPair !== null && (!Array.isArray(questionPair) || questionPair.length !== 2 || questionPair[0] === questionPair[1] || questionPair.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)))) throw new Error();
      if (questionPair) questionPair.sort();
    } catch { problems.push('FAMILY_QUESTION_PAIR must be JSON containing two distinct permanent member ids, or null; membership is checked against D1 at runtime.'); }
  }

  if (problems.length) return { problems: [...new Set(problems)] };
  return {
    problems: [],
    deployment: {
      databaseName: database.database_name,
      migrationsDirectory: database.migrations_dir || 'migrations',
      workerName: config.name,
      // Always upload the normalized pair, including null, to replace a stale secret.
      secrets: { APP_ORIGIN: origin, WEBAUTHN_RP_ID: environment.WEBAUTHN_RP_ID, FAMILY_QUESTION_PAIR: JSON.stringify(questionPair), DEV_AUTH: 'false' },
    },
  };
}
