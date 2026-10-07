import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { deploymentSecretNames, validateDeployment } from '../scripts/deployment-config.mjs';
import { readConfig } from '../src/server/auth';
import type { Env } from '../src/server/env';

const members = [
  { id: 'alex', name: 'Alex', email: 'alex@family-home.dev', role: 'admin', color: '#38634A' },
  { id: 'sam', name: 'Sam', email: 'sam@family-home.dev', role: 'member', color: '#A96743' },
];
function configuration() {
  return {
    name: 'hearth-production', workers_dev: false,
    routes: [{ pattern: 'hearth.family-home.dev', custom_domain: true }],
    d1_databases: [{ binding: 'DB', database_name: 'renamed-family-database', database_id: '12345678-1234-1234-1234-123456789abc', migrations_dir: 'migrations' }],
    vars: { FAMILY_TIMEZONE: 'America/New_York' },
  };
}
function environment(): Record<string, string | undefined> {
  return { CLOUDFLARE_API_TOKEN: 'private-token-sentinel', CLOUDFLARE_ACCOUNT_ID: 'private-account-sentinel', ACCESS_TEAM_DOMAIN: 'https://hearth.cloudflareaccess.com/', ACCESS_AUD: 'private-audience-sentinel', APP_ORIGIN: 'https://hearth.family-home.dev', FAMILY_MEMBERS: JSON.stringify(members) };
}
const validate = (config: unknown = configuration(), env = environment()) => validateDeployment(config, env);

describe('production deployment configuration', () => {
  it('selects the configured database and normalizes shared runtime settings without credentials in the plan', () => {
    const result = validate();
    expect(result.problems).toEqual([]);
    expect(result.deployment?.databaseName).toBe('renamed-family-database');
    expect(result.deployment?.secrets.ACCESS_TEAM_DOMAIN).toBe('hearth.cloudflareaccess.com');
    expect(result.deployment?.secrets.DEV_AUTH).toBe('false');
    expect(result.deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["alex","sam"]');
    expect(result.deployment?.secrets).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(result.deployment?.secrets).not.toHaveProperty('CLOUDFLARE_ACCOUNT_ID');
    expect(readConfig({ ...result.deployment?.secrets, FAMILY_TIMEZONE: 'America/New_York' } as Env, environment().APP_ORIGIN!).members).toEqual(members);
  });

  it.each(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN', 'FAMILY_MEMBERS'])('requires %s without echoing sensitive values', name => {
    const env = { ...environment(), [name]: undefined };
    const result = validate(configuration(), env);
    expect(result.problems).toContain(`${name} is required.`);
    expect(result.deployment).toBeUndefined();
    const output = JSON.stringify(result.problems);
    expect(output).not.toContain('private-token-sentinel');
    expect(output).not.toContain('private-account-sentinel');
    expect(output).not.toContain('private-audience-sentinel');
    expect(output).not.toContain(members[0].email);
  });

  it.each([undefined, null, [], {}, [{ binding: 'OTHER' }], [{ binding: 'DB' }], [configuration().d1_databases[0], configuration().d1_databases[0]]])('rejects missing, malformed, or duplicate DB bindings: %j', d1_databases => {
    expect(validate({ ...configuration(), d1_databases }).problems.length).toBeGreaterThan(0);
  });

  it.each(['00000000-0000-0000-0000-000000000000', 'placeholder', '', '12345678123412341234123456789abc'])('rejects a placeholder or malformed database id: %s', database_id => {
    expect(validate({ ...configuration(), d1_databases: [{ ...configuration().d1_databases[0], database_id }] }).problems.join(' ')).toContain('database_id');
  });

  it.each(['', '--remote', 'database with spaces', null])('rejects a missing or unsafe database name: %s', database_name => {
    expect(validate({ ...configuration(), d1_databases: [{ ...configuration().d1_databases[0], database_name }] }).problems.join(' ')).toContain('database_name');
  });

  it('requires workers.dev disabled and rejects development bypasses from either source', () => {
    for (const workers_dev of [undefined, true, 'false']) expect(validate({ ...configuration(), workers_dev }).problems.join(' ')).toContain('workers_dev');
    for (const DEV_AUTH of ['true', '', 'TRUE']) expect(validate(configuration(), { ...environment(), DEV_AUTH }).problems.join(' ')).toContain('DEV_AUTH');
    expect(validate(configuration(), { ...environment(), DEV_AUTH: 'false' }).problems).toEqual([]);
    expect(validate({ ...configuration(), vars: { DEV_AUTH: 'true' } }).problems.join(' ')).toContain('DEV_AUTH');
    expect(validate({ ...configuration(), vars: { DEV_AUTH: 'false' } }).problems.join(' ')).toContain('DEV_AUTH');
  });

  it('rejects conflicting account, plaintext secrets, and invalid timezone settings', () => {
    expect(validate({ ...configuration(), account_id: 'different-account' }).problems.join(' ')).toContain('account_id');
    expect(validate({ ...configuration(), vars: { FAMILY_MEMBERS: environment().FAMILY_MEMBERS } }).problems.join(' ')).toContain('secrets');
    expect(validate({ ...configuration(), vars: { FAMILY_QUESTION_PAIR: '["alex","sam"]' } }).problems.join(' ')).toContain('secrets');
    expect(validate({ ...configuration(), vars: { FAMILY_TIMEZONE: 'bad/zone' } }).problems.join(' ')).toContain('FAMILY_TIMEZONE');
    expect(validate({ ...configuration(), vars: null }).problems.join(' ')).toContain('vars');
  });

  it.each([
    'http://hearth.family-home.dev', 'https://hearth.family-home.dev/', 'https://hearth.family-home.dev/api',
    'https://hearth.family-home.dev?x=1', 'https://user:password@hearth.family-home.dev',
    'https://hearth.family-home.dev:8443', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://hearth.example.com',
  ])('rejects an origin incompatible with exact private HTTPS deployment: %s', APP_ORIGIN => {
    expect(validate(configuration(), { ...environment(), APP_ORIGIN }).problems.join(' ')).toContain('APP_ORIGIN');
  });

  it.each(['hearth.family-home.dev/*', 'https://hearth.family-home.dev/*', { pattern: 'hearth.family-home.dev/*', zone_name: 'family-home.dev' }, { pattern: 'hearth.family-home.dev', custom_domain: true }])('accepts a route covering the exact origin: %j', route => {
    expect(validate({ ...configuration(), routes: [route] }).problems).toEqual([]);
    const { routes: _, ...config } = configuration();
    expect(validate({ ...config, route }).problems).toEqual([]);
  });

  it.each([undefined, [], 'hearth.family-home.dev/*', [null], [{}], ['*.family-home.dev/*'], ['hearth.family-home.dev/api/*'], ['http://hearth.family-home.dev/*'], ['different.family-home.dev/*'], [{ pattern: 'https://hearth.family-home.dev', custom_domain: true }], [{ pattern: 'hearth.family-home.dev', custom_domain: 'true' }]])('rejects absent, broad, partial, or mismatched routes: %j', routes => {
    expect(validate({ ...configuration(), routes }).problems.length).toBeGreaterThan(0);
  });

  it('rejects ambiguous or extra route targets', () => {
    expect(validate({ ...configuration(), route: 'hearth.family-home.dev/*' }).problems.join(' ')).toContain('not both');
    expect(validate({ ...configuration(), routes: ['hearth.family-home.dev/*', 'different.family-home.dev/*'] }).problems.join(' ')).toContain('Every route');
  });

  it.each(['http://hearth.cloudflareaccess.com', 'hearth.cloudflareaccess.com/extra', 'evil.dev', 'hearth.cloudflareaccess.com.evil.dev', '-bad.cloudflareaccess.com', 'bad-.cloudflareaccess.com', 'x'.repeat(64) + '.cloudflareaccess.com', ''])('rejects invalid Access issuer configuration: %s', ACCESS_TEAM_DOMAIN => {
    expect(validate(configuration(), { ...environment(), ACCESS_TEAM_DOMAIN }).problems.join(' ')).toContain('ACCESS_TEAM_DOMAIN');
  });
});

describe('daily question pair deployment', () => {
  const extendedMembers = [...members, { id: 'lee', name: 'Lee', email: 'lee@family-home.dev', role: 'member', color: '#555555' }];
  const largerEnvironment = () => ({ ...environment(), FAMILY_MEMBERS: JSON.stringify(extendedMembers) });

  it('treats the pair secret as optional and writes a canonical value', () => {
    expect(deploymentSecretNames).toContain('FAMILY_QUESTION_PAIR');
    const inferred = validate();
    expect(inferred.problems).toEqual([]);
    expect(inferred.deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["alex","sam"]');
    expect(readConfig(inferred.deployment!.secrets as unknown as Env, environment().APP_ORIGIN!).questionPair).toEqual(['alex', 'sam']);
    const explicit = validate(configuration(), { ...largerEnvironment(), FAMILY_QUESTION_PAIR: '["sam","alex"]' });
    expect(explicit.problems).toEqual([]);
    expect(explicit.deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["alex","sam"]');
    expect(readConfig(explicit.deployment!.secrets as unknown as Env, environment().APP_ORIGIN!).questionPair).toEqual(['alex', 'sam']);
  });

  it('always overwrites the prior secret after configuration is removed or disabled', () => {
    const paired = validate(configuration(), { ...largerEnvironment(), FAMILY_QUESTION_PAIR: '["sam","lee"]' });
    expect(paired.deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["lee","sam"]');
    for (const env of [largerEnvironment(), { ...environment(), FAMILY_MEMBERS: JSON.stringify([members[0]]) }, { ...environment(), FAMILY_QUESTION_PAIR: 'null' }]) {
      const result = validate(configuration(), env);
      expect(result.problems).toEqual([]);
      expect(result.deployment?.secrets).toHaveProperty('FAMILY_QUESTION_PAIR', 'null');
      expect({ ...paired.deployment?.secrets, ...result.deployment?.secrets }.FAMILY_QUESTION_PAIR).toBe('null');
      expect(readConfig(result.deployment!.secrets as unknown as Env, environment().APP_ORIGIN!).questionPair).toBeNull();
    }
    expect(validate().deployment?.secrets.FAMILY_QUESTION_PAIR).toBe('["alex","sam"]');
  });

  it.each(['', '[bad json', '{}', '[]', '["alex"]', '["alex","sam","lee"]', '["alex","alex"]', '["alex","unknown-private-id"]'])('rejects invalid pair configuration without printing values: %s', FAMILY_QUESTION_PAIR => {
    const env = { ...largerEnvironment(), FAMILY_QUESTION_PAIR };
    const result = validate(configuration(), env);
    expect(result.deployment).toBeUndefined();
    expect(result.problems.join(' ')).toContain('FAMILY_QUESTION_PAIR');
    expect(result.problems.join(' ')).not.toContain('unknown-private-id');
    expect(result.problems.join(' ')).not.toContain(members[0].email);
    expect(() => readConfig(env as unknown as Env, environment().APP_ORIGIN!)).toThrow('Family access is not configured.');
  });

  it('the actual CLI reports invalid pair configuration without echoing its contents', () => {
    const child = spawnSync(process.execPath, ['scripts/preflight.mjs'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, ...environment(), FAMILY_QUESTION_PAIR: '["private-pair-sentinel","sam"]' },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('FAMILY_QUESTION_PAIR');
    expect(child.stderr + child.stdout).not.toContain('private-pair-sentinel');
    expect(child.stderr + child.stdout).not.toContain('private-audience-sentinel');
    expect(child.stderr + child.stdout).not.toContain(members[0].email);
  });
});

describe('family allowlist parity with the runtime', () => {
  const invalidMembers: unknown[] = [
    null, {}, [], [null], [{}], [members[0], members[0]], [members[1]],
    [members[0], { ...members[1], email: members[0].email.toUpperCase() }],
    [{ ...members[0], id: 'bad:id' }], [{ ...members[0], name: ' ' }],
    [{ ...members[0], role: 'owner' }], [{ ...members[0], color: 'red' }],
    [{ ...members[0], email: 'invalid' }], [{ ...members[0], name: 'x'.repeat(101) }],
    [{ ...members[0], unknown: 'value' }],
    Array.from({ length: 21 }, (_, index) => ({ ...members[0], id: `person${index}`, email: `person${index}@family-home.dev` })),
  ];

  it.each(invalidMembers.map((value, index) => ({ value, index })))('rejects malformed roster case $index consistently', ({ value }) => {
    const env: Record<string, string | undefined> = { ...environment(), FAMILY_MEMBERS: JSON.stringify(value) };
    expect(validate(configuration(), env).problems.join(' ')).toContain('FAMILY_MEMBERS');
    expect(() => readConfig(env as unknown as Env, env.APP_ORIGIN!)).toThrow();
  });

  it('rejects malformed JSON and production placeholder email domains gracefully', () => {
    for (const FAMILY_MEMBERS of ['[bad json', JSON.stringify([{ ...members[0], email: 'alex@example.com' }]), JSON.stringify([{ ...members[0], email: 'alex@hearth.test' }])]) {
      expect(validate(configuration(), { ...environment(), FAMILY_MEMBERS }).problems.join(' ')).toContain('FAMILY_MEMBERS');
    }
  });

  it('the actual CLI fails closed without credentials and prints no supplied secret value', () => {
    const child = spawnSync(process.execPath, ['scripts/preflight.mjs'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, ...environment(), CLOUDFLARE_API_TOKEN: '' },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('CLOUDFLARE_API_TOKEN is required');
    expect(child.stderr).not.toContain('private-audience-sentinel');
    expect(child.stderr).not.toContain(members[0].email);
    expect(child.stdout).not.toContain('checks passed');
  });
});
