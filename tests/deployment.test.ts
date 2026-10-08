import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentSecretNames, validateDeployment } from '../scripts/deployment-config.mjs';

function configuration() {
  return { name: 'hearth-production', workers_dev: false,
    routes: [{ pattern: 'hearth.family-home.dev', custom_domain: true }],
    d1_databases: [{ binding: 'DB', database_name: 'renamed-family-database', database_id: '12345678-1234-1234-1234-123456789abc', migrations_dir: 'migrations' }],
    vars: { FAMILY_TIMEZONE: 'America/New_York' } };
}
function environment(): Record<string, string | undefined> {
  return { CLOUDFLARE_API_TOKEN: 'private-token-sentinel', CLOUDFLARE_ACCOUNT_ID: 'private-account-sentinel', APP_ORIGIN: 'https://hearth.family-home.dev', WEBAUTHN_RP_ID: 'hearth.family-home.dev' };
}
const validate = (config: unknown = configuration(), env = environment()) => validateDeployment(config, env);

describe('passkey production deployment configuration', () => {
  it('requires no email roster or Access provider and selects the configured database', () => {
    const result = validate();
    expect(result.problems).toEqual([]);
    expect(result.deployment?.databaseName).toBe('renamed-family-database');
    expect(result.deployment?.secrets).toEqual({ APP_ORIGIN: environment().APP_ORIGIN, WEBAUTHN_RP_ID: environment().WEBAUTHN_RP_ID, FAMILY_QUESTION_PAIR: 'null', DEV_AUTH: 'false' });
    expect(deploymentSecretNames).not.toContain('FAMILY_MEMBERS');
    expect(JSON.stringify(result.deployment)).not.toContain('private-token-sentinel');
    expect(JSON.stringify(result.deployment)).not.toContain('private-account-sentinel');
  });
  it.each(['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','APP_ORIGIN','WEBAUTHN_RP_ID'])('requires %s', name => {
    const result = validate(configuration(), { ...environment(), [name]: undefined });
    expect(result.problems).toContain(`${name} is required.`);
    expect(result.deployment).toBeUndefined();
  });
  it.each(['ACCESS_TEAM_DOMAIN','ACCESS_AUD','FAMILY_MEMBERS'])('rejects legacy %s without displaying its value', name => {
    const result = validate(configuration(), { ...environment(), [name]: 'private-legacy-sentinel' });
    expect(result.problems.join(' ')).toContain(name);
    expect(result.problems.join(' ')).not.toContain('private-legacy-sentinel');
    expect(validate({ ...configuration(), vars: { [name]: 'private-legacy-sentinel' } }).problems.join(' ')).toContain('legacy');
  });
  it.each([undefined,null,[],{},[{binding:'OTHER'}],[{binding:'DB'}],[configuration().d1_databases[0],configuration().d1_databases[0]]])('rejects malformed DB binding %#', d1_databases => {
    expect(validate({ ...configuration(), d1_databases }).problems.length).toBeGreaterThan(0);
  });
  it.each(['00000000-0000-0000-0000-000000000000','placeholder','','12345678123412341234123456789abc'])('rejects database id %s', database_id => {
    expect(validate({ ...configuration(), d1_databases: [{ ...configuration().d1_databases[0], database_id }] }).problems.join(' ')).toContain('database_id');
  });
  it.each(['','--remote','database with spaces',null])('rejects unsafe database name %s', database_name => {
    expect(validate({ ...configuration(), d1_databases: [{ ...configuration().d1_databases[0], database_name }] }).problems.join(' ')).toContain('database_name');
  });
  it('rejects alternate Worker hostnames, bypass settings and mismatched accounts', () => {
    for (const workers_dev of [undefined,true,'false']) expect(validate({ ...configuration(), workers_dev }).problems.join(' ')).toContain('workers_dev');
    for (const DEV_AUTH of ['true','','TRUE']) expect(validate(configuration(), { ...environment(), DEV_AUTH }).problems.join(' ')).toContain('DEV_AUTH');
    expect(validate(configuration(), { ...environment(), DEV_AUTH:'false' }).problems).toEqual([]);
    expect(validate({ ...configuration(), vars:{DEV_AUTH:'false'} }).problems.join(' ')).toContain('DEV_AUTH');
    expect(validate({ ...configuration(), account_id:'other-account' }).problems.join(' ')).toContain('account_id');
    expect(validate({ ...configuration(), vars:{FAMILY_TIMEZONE:'bad/zone'} }).problems.join(' ')).toContain('FAMILY_TIMEZONE');
    expect(validate({ ...configuration(), vars:null }).problems.join(' ')).toContain('vars');
  });
  it.each(['http://hearth.family-home.dev','https://hearth.family-home.dev/','https://hearth.family-home.dev/api','https://hearth.family-home.dev?x=1','https://user:password@hearth.family-home.dev','https://hearth.family-home.dev:8443','https://127.0.0.1','https://[::1]','https://localhost','https://hearth.example.com'])('rejects invalid production origin %s', APP_ORIGIN => {
    expect(validate(configuration(), { ...environment(), APP_ORIGIN }).problems.join(' ')).toContain('APP_ORIGIN');
  });
  it.each(['family-home.dev','other.family-home.dev','https://hearth.family-home.dev','HEARTH.family-home.dev'])('rejects RP ID mismatch %s', WEBAUTHN_RP_ID => {
    expect(validate(configuration(), { ...environment(), WEBAUTHN_RP_ID }).problems.join(' ')).toContain('WEBAUTHN_RP_ID');
  });
  it.each(['hearth.family-home.dev/*','https://hearth.family-home.dev/*',{pattern:'hearth.family-home.dev/*',zone_name:'family-home.dev'},{pattern:'hearth.family-home.dev',custom_domain:true}])('accepts exact full-host route %#', route => {
    expect(validate({ ...configuration(), routes:[route] }).problems).toEqual([]);
  });
  it.each(['*.family-home.dev/*','hearth.family-home.dev/api/*','other.family-home.dev/*',{pattern:'hearth.family-home.dev/*',custom_domain:true}])('rejects partial or unrelated route %#', route => {
    expect(validate({ ...configuration(), routes:[route] }).problems.length).toBeGreaterThan(0);
  });
  it('normalizes explicit permanent-id pairs without inventing membership or retaining stale defaults', () => {
    expect(validate(configuration(), { ...environment(), FAMILY_QUESTION_PAIR:'["sam","alex"]' }).deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["alex","sam"]');
    expect(validate(configuration(), { ...environment(), FAMILY_QUESTION_PAIR:'null' }).deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('null');
    for (const FAMILY_QUESTION_PAIR of ['[bad','[]','["alex","alex"]','["alex",1]','["private@example.test","sam"]','{}']) {
      const result=validate(configuration(), { ...environment(), FAMILY_QUESTION_PAIR });
      expect(result.problems.join(' ')).toContain('FAMILY_QUESTION_PAIR');
      expect(result.problems.join(' ')).not.toContain('private@example.test');
    }
  });
  it('actually refuses a deployment missing the runtime migration', () => {
    const dir=mkdtempSync(join(tmpdir(),'hearth-preflight-'));
    try {
      mkdirSync(join(dir,'scripts')); mkdirSync(join(dir,'src/server'),{recursive:true}); mkdirSync(join(dir,'migrations'));
      for (const filename of ['scripts/preflight.mjs','scripts/deployment-config.mjs','src/server/config.mjs']) cpSync(resolve(filename),join(dir,filename));
      symlinkSync(resolve('node_modules'),join(dir,'node_modules'),'dir');
      writeFileSync(join(dir,'wrangler.jsonc'),JSON.stringify(configuration()));
      for(const name of ['0001_initial.sql','0002_storage_budget.sql','0003_passkey_foundation.sql']) writeFileSync(join(dir,'migrations',name),'');
      const run=()=>spawnSync(process.execPath,[join(dir,'scripts/preflight.mjs')],{env:environment(),encoding:'utf8'});
      const missing=run(); expect(missing.status).toBe(1); expect(missing.stderr).toContain('all Hearth schema migrations');
      writeFileSync(join(dir,'migrations/0004_passkey_runtime.sql'),'');
      expect(run().status).toBe(1);
      writeFileSync(join(dir,'migrations/0005_passkey_browser_sessions.sql'),'');
      expect(run().status).toBe(1);
      writeFileSync(join(dir,'migrations/0006_passkey_credential_tombstones.sql'),'');
      const complete=run(); expect(complete.status).toBe(0); expect(complete.stdout).toContain('checks passed');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
