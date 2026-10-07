import { parseAccessDomain, parseFamilyMembers, parseTimezone } from '../src/server/config.mjs';

export const deploymentSecretNames = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN', 'FAMILY_MEMBERS'];
const requiredNames = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', ...deploymentSecretNames];
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
  if (config.workers_dev !== false) problems.push('workers_dev must be explicitly false; publish only on the Access-protected hostname.');
  if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(config.name)) problems.push('Set a valid Worker name in wrangler.jsonc.');
  if (config.account_id !== undefined && config.account_id !== environment.CLOUDFLARE_ACCOUNT_ID) problems.push('Wrangler account_id must match CLOUDFLARE_ACCOUNT_ID, or be omitted.');

  const vars = config.vars === undefined ? {} : config.vars;
  if (!isObject(vars)) problems.push('Worker vars must be a JSON object.');
  else {
    if ('DEV_AUTH' in vars) problems.push('Remove DEV_AUTH from Worker vars; deployment pins it to false as a secret.');
    if (deploymentSecretNames.some(name => name in vars)) problems.push('Access and family settings must come from deployment environment secrets, not Worker vars.');
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

  let domain;
  if (environment.ACCESS_TEAM_DOMAIN) {
    try { domain = parseAccessDomain(environment.ACCESS_TEAM_DOMAIN); }
    catch { problems.push('ACCESS_TEAM_DOMAIN must be the Cloudflare Access team hostname, optionally prefixed with https://.'); }
  }
  if (environment.ACCESS_AUD && (environment.ACCESS_AUD.trim() !== environment.ACCESS_AUD || environment.ACCESS_AUD.length > 4096)) problems.push('ACCESS_AUD must contain the exact Access application audience without surrounding whitespace.');

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
  if (!Array.isArray(routes) || !routes.length || routes.length > 20) problems.push('Configure a route for the full Access-protected APP_ORIGIN hostname.');
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

  let members;
  if (environment.FAMILY_MEMBERS) {
    try {
      members = parseFamilyMembers(environment.FAMILY_MEMBERS);
      if (members.some(member => reservedHostname(member.email.split('@')[1]))) problems.push('FAMILY_MEMBERS must use real family email addresses; reserved example/test domains are not deployable.');
    } catch { problems.push('FAMILY_MEMBERS must be 1–20 valid, unique member objects with id, name, email, role, color and at least one admin.'); }
  }

  if (problems.length) return { problems: [...new Set(problems)] };
  return {
    problems: [],
    deployment: {
      databaseName: database.database_name,
      migrationsDirectory: database.migrations_dir || 'migrations',
      workerName: config.name,
      secrets: { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: environment.ACCESS_AUD, APP_ORIGIN: origin, FAMILY_MEMBERS: JSON.stringify(members), DEV_AUTH: 'false' },
    },
  };
}
