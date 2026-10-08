import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOperatorMutation, createOperatorPlan, loadOperatorTarget, operatorSnapshotSql, parseOperatorArgs, runOperator, wranglerArguments } from '../scripts/auth-operator.mjs';
import type { OperatorOptions, OperatorRequest, OperatorSnapshot, OperatorTarget } from '../scripts/auth-operator.mjs';
import type { EnrollmentRosterMember } from '../src/shared/members';

const now = 1_791_417_600;
const hash = (value: string) => value.repeat(43);
const roster: EnrollmentRosterMember[] = [
  { id: 'alex', name: "Private Alex's Name", role: 'admin', color: '#38634A', status: 'pending' },
  { id: 'sam', name: 'Private Sam Name', role: 'member', color: '#A96743', status: 'pending' },
  { id: 'former', name: 'Private Former Name', role: 'member', color: '#A96743', status: 'suspended' },
];
let db: DatabaseSync;
let folder: string;
let config: string;
let input: string;
let messages: string[];
let writes: number;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const filename of readdirSync(new URL('../migrations', import.meta.url)).filter(value => value.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
  folder = mkdtempSync(join(tmpdir(), 'hearth-auth-operator-test-'));
  config = join(folder, 'wrangler.json');
  input = join(folder, 'roster.json');
  writeFileSync(config, JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'isolated-test', database_id: '11111111-1111-4111-8111-111111111111' }] }));
  writeFileSync(input, JSON.stringify(roster));
  messages = [];
  writes = 0;
});
afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

function options(command: OperatorOptions['command'], changes: Partial<OperatorOptions> = {}): OperatorOptions {
  return { command, config, remote: false, apply: false, expiresIn: 3600, ...(command === 'import' ? { input } : { member: 'alex' }), ...changes };
}
function snapshot(member?: string) { return db.prepare(operatorSnapshotSql(member)).get() as unknown as OperatorSnapshot; }
function plan(command: OperatorOptions['command'], changes: Partial<OperatorOptions> = {}) {
  const opts = options(command, changes);
  return createOperatorPlan(opts, loadOperatorTarget(opts), snapshot(opts.member), command === 'import' ? roster : undefined);
}
function batch(sql: string) {
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function seedRoster() { batch(createOperatorMutation(plan('import'), { now }).sql); }
function execute(_target: OperatorTarget, request: OperatorRequest): Record<string, unknown>[] {
  if (request.file) { writes++; batch(readFileSync(request.file, 'utf8')); return []; }
  return db.prepare(request.command!).all();
}
function run(opts: OperatorOptions) { return runOperator(opts, { execute, print: message => messages.push(message) }); }
function record(id: string, kind: string, owner: string, data: Record<string, unknown>) {
  db.prepare('INSERT INTO records(id,kind,owner_id,data,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?)').run(id, kind, owner, JSON.stringify(data), 'old', 'old', 7);
}
function seedAuth() {
  seedRoster();
  db.exec(`UPDATE auth_members SET status = 'active' WHERE id IN ('alex','sam');
    INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at) VALUES ('alex_key','alex','cHVibGlj',1,1,${now}),('sam_key','sam','cHVibGlj',1,1,${now});
    INSERT INTO auth_sessions(token_hash,member_id,credential_id,created_at,last_seen_at,expires_at) VALUES ('${hash('S')}','alex','alex_key',${now},${now},${now + 3600}),('${hash('T')}','sam','sam_key',${now},${now},${now + 3600});
    INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES ('${hash('G')}','alex','enroll',${now},${now + 3600}),('${hash('H')}','sam','enroll',${now},${now + 3600});
    INSERT INTO auth_challenges(id,challenge,browser_hash,purpose,member_id,grant_hash,origin,rp_id,created_at,expires_at) VALUES
      ('alex_registration','${hash('C')}','${hash('B')}','registration','alex','${hash('G')}','https://hearth.example','hearth.example',${now},${now + 300}),
      ('alex_reauth','${hash('D')}','${hash('B')}','reauthentication','alex',NULL,'https://hearth.example','hearth.example',${now},${now + 300}),
      ('sam_registration','${hash('E')}','${hash('B')}','registration','sam','${hash('H')}','https://hearth.example','hearth.example',${now},${now + 300});`);
}

describe('operator arguments and local targeting', () => {
  it('defaults to dry-run and local, with no implicitly selected remote database', () => {
    const parsed = parseOperatorArgs(['import', '--input', input, '--config', config]) as OperatorOptions;
    expect(parsed).toMatchObject({ apply: false, remote: false });
    const args = wranglerArguments(loadOperatorTarget(parsed), { command: 'SELECT 1' });
    expect(args).toContain('--local');
    expect(args).not.toContain('--remote');
    expect(args).toContain(join(folder, '.wrangler/state'));
  });
  it('uses an explicitly selected local persistence directory and configured binding', () => {
    const parsed = parseOperatorArgs(['import', '--input', input, '--config', config, '--persist-to', join(folder, 'custom'), '--local']) as OperatorOptions;
    const target = loadOperatorTarget(parsed);
    expect(target.databaseName).toBe('isolated-test');
    expect(wranglerArguments(target, { file: "a path ' ; file.sql" })).toContain("a path ' ; file.sql");
    expect(target.persistTo).toBe(join(folder, 'custom'));
  });
  it.each([
    [], ['import'], ['recover', '--member', 'alex', '--local', '--remote'],
    ['import', '--input', 'x', '--remote', '--persist-to', 'x'],
    ['recover', '--member', 'alex', '--apply'], ['bootstrap', '--member', 'alex', '--apply', '--review', hash('A')],
    ['recover', '--member', 'alex', '--expires-in', '86401'], ['recover', '--member', 'alex', '--expires-in', '59'],
    ['recover', '--member', 'alex', '--expires-in', '1e3'], ['recover', '--member', 'bad;id'],
    ['import', '--input', 'x', '--input', 'y'], ['import', '--input', 'x', '--output', 'x'],
    ['recover', '--member', 'alex', '--token', 'secret'], ['import', '--input', 'x', '--review', hash('A')],
    ['recover', '--member', 'alex', 'constructor', 'unexpected'],
  ].map(args => ({ args })))('rejects unsafe/incomplete arguments %#', ({ args }) => expect(() => parseOperatorArgs(args)).toThrow());
  it('supports explicit remote selection without a local persistence override', () => {
    const parsed = parseOperatorArgs(['recover', '--member', 'alex', '--remote', '--config', config]) as OperatorOptions;
    const target = loadOperatorTarget(parsed);
    expect(target.persistTo).toBeNull();
    expect(wranglerArguments(target, { command: 'SELECT 1' })).toContain('--remote');
  });
  it('rejects ambiguous bindings and preview redirection', () => {
    const binding = JSON.parse(readFileSync(config, 'utf8')).d1_databases[0];
    for (const bindings of [[], [binding, binding], [{ ...binding, preview_database_id: 'different' }]]) {
      writeFileSync(config, JSON.stringify({ d1_databases: bindings }));
      expect(() => loadOperatorTarget(options('import'))).toThrow();
    }
  });
});

describe('all-or-nothing historical roster import', () => {
  it('preserves record bytes, owners, immutable audiences, assignees, habit users and accounting', () => {
    record('mood', 'mood', 'former', { note: 'private-record-sentinel', score: 1 });
    record('answer', 'answer', 'alex', { participantIds: ['alex', 'sam'], choice: 1 });
    record('task', 'task', 'alex', { assigneeId: 'former', title: 'Private' });
    record('habit', 'habit', 'sam', { userId: 'former', title: 'Private' });
    db.exec("INSERT INTO modules(id,enabled) VALUES('moods',0)");
    const before = ['records', 'family_storage', 'modules'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const dry = run(options('import'));
    expect(writes).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_members').get()?.n).toBe(0);
    expect(messages.join('\n')).not.toMatch(/private-record-sentinel|Private Alex|Private Sam/);
    expect(messages.join('\n')).toContain('alex, former, sam');
    run(options('import', { apply: true, review: dry.review }));
    expect(['records', 'family_storage', 'modules'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
    expect(db.prepare('SELECT id,status FROM auth_members ORDER BY id').all()).toEqual([{ id: 'alex', status: 'pending' }, { id: 'former', status: 'suspended' }, { id: 'sam', status: 'pending' }]);
    expect(db.prepare('SELECT count(*) n FROM auth_enrollment_grants').get()?.n).toBe(0);
  });
  it.each([
    ['owner', 'note', 'missing', {}], ['answer', 'answer', 'alex', { participantIds: ['alex', 'missing'] }],
    ['task', 'task', 'alex', { assigneeId: 'missing' }], ['habit', 'habit', 'alex', { userId: 'missing' }],
  ])('refuses to drop historical %s identities', (_label, kind, owner, data) => {
    record('record', kind as string, owner as string, data as Record<string, unknown>);
    expect(() => plan('import')).toThrow('missing');
    expect(db.prepare('SELECT count(*) n FROM auth_members').get()?.n).toBe(0);
  });
  it('blocks malformed references without displaying their contents', () => {
    record('answer', 'answer', 'alex', { participantIds: ['alex', 'private-content@example.test'] });
    expect(() => plan('import')).toThrow('malformed');
    expect(() => plan('import')).not.toThrow('private-content');
  });
  it('rechecks new historical references inside the atomic batch', () => {
    const proposed = plan('import');
    record('new', 'task', 'alex', { assigneeId: 'new-person' });
    expect(() => batch(createOperatorMutation(proposed, { now }).sql)).toThrow(/CHECK/);
    expect(db.prepare('SELECT count(*) n FROM auth_members').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_transaction_guards').get()?.n).toBe(0);
  });
  it('rejects duplicate/stale import plans and never overwrites existing member rows', () => {
    const proposed = plan('import');
    batch(createOperatorMutation(proposed, { now }).sql);
    const before = db.prepare('SELECT * FROM auth_members').all();
    expect(() => plan('import')).toThrow('empty member table');
    expect(() => batch(createOperatorMutation(proposed, { now }).sql)).toThrow(/CHECK/);
    expect(db.prepare('SELECT * FROM auth_members').all()).toEqual(before);
  });
  it('rolls back earlier rows when a later uniqueness constraint fails', () => {
    expect(() => batch(createOperatorMutation(plan('import'), { now, handles: [hash('A'), hash('A'), hash('C')] }).sql)).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) n FROM auth_members').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_audit').get()?.n).toBe(0);
  });
  it('requires a new review if the input roster changes and rejects active/email-bearing imports', () => {
    const dry = run(options('import'));
    writeFileSync(input, JSON.stringify(roster.map(member => ({ ...member, name: 'Changed' }))));
    expect(() => run(options('import', { apply: true, review: dry.review }))).toThrow('Plan changed');
    for (const extra of [{ status: 'active' }, { email: 'private-sentinel@example.test' }]) {
      writeFileSync(input, JSON.stringify([{ ...roster[0], ...extra }]));
      expect(() => run(options('import'))).toThrow('Invalid enrollment roster');
    }
    expect(writes).toBe(0);
  });
});

describe('bounded bootstrap and recovery authorizations', () => {
  it('issues exactly one durable bootstrap authorization without activating or signing in', () => {
    seedRoster();
    const proposed = plan('bootstrap');
    const mutation = createOperatorMutation(proposed, { now, token: hash('Z') });
    batch(mutation.sql);
    expect(mutation.sql).not.toContain(hash('Z'));
    expect(db.prepare('SELECT status FROM auth_members WHERE id=?').get('alex')?.status).toBe('pending');
    expect(db.prepare('SELECT count(*) n FROM auth_sessions').get()?.n).toBe(0);
    expect(db.prepare('SELECT token_hash,purpose,expires_at-created_at lifetime FROM auth_enrollment_grants').get()).toEqual({ token_hash: createHash('sha256').update(hash('Z')).digest('base64url'), purpose: 'bootstrap', lifetime: 3600 });
    expect(() => batch(createOperatorMutation(proposed, { now }).sql)).toThrow(/CHECK/);
    db.exec("DELETE FROM auth_enrollment_grants; DELETE FROM auth_audit;");
    expect(() => plan('bootstrap')).toThrow('prior operator bootstrap');
    expect(() => plan('recover')).not.toThrow();
  });
  it('refuses member, suspended, and active-member bootstrap candidates', () => {
    seedRoster();
    expect(() => plan('bootstrap', { member: 'sam' })).toThrow('pending administrator');
    expect(() => plan('bootstrap', { member: 'former' })).toThrow('Suspended');
    db.exec("UPDATE auth_members SET status='active' WHERE id='sam'");
    expect(() => plan('bootstrap')).toThrow('pending administrator');
  });
  it('recovery revokes all selected access atomically while preserving identity and other members', () => {
    seedAuth();
    record('private', 'mood', 'alex', { note: 'keep' });
    const beforeMember = db.prepare('SELECT id,name,role,color,user_handle,created_at FROM auth_members WHERE id=?').get('alex');
    const beforeRecords = db.prepare('SELECT * FROM records').all();
    const mutation = createOperatorMutation(plan('recover'), { now: now + 10, token: hash('Z') });
    batch(mutation.sql);
    expect(db.prepare('SELECT id,name,role,color,user_handle,created_at FROM auth_members WHERE id=?').get('alex')).toEqual(beforeMember);
    expect(db.prepare('SELECT * FROM records').all()).toEqual(beforeRecords);
    expect(db.prepare('SELECT id,status FROM auth_members ORDER BY id').all()).toEqual([{ id: 'alex', status: 'pending' }, { id: 'former', status: 'suspended' }, { id: 'sam', status: 'active' }]);
    for (const table of ['auth_credentials', 'auth_sessions']) {
      expect(db.prepare(`SELECT revoked_at FROM ${table} WHERE member_id='alex'`).get()?.revoked_at).toBe(now + 10);
      expect(db.prepare(`SELECT revoked_at FROM ${table} WHERE member_id='sam'`).get()?.revoked_at).toBeNull();
    }
    expect(db.prepare('SELECT revoked_at FROM auth_enrollment_grants WHERE token_hash=?').get(hash('G'))?.revoked_at).toBe(now + 10);
    expect(db.prepare('SELECT member_id FROM auth_challenges').all()).toEqual([{ member_id: 'sam' }]);
    expect(db.prepare("SELECT count(*) n FROM auth_enrollment_grants WHERE member_id='alex' AND revoked_at IS NULL").get()?.n).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('fails concurrent recovery plans without revoking the first plan authorization', () => {
    seedAuth();
    const proposed = plan('recover');
    batch(createOperatorMutation(proposed, { now: now + 10 }).sql);
    const before = db.prepare('SELECT * FROM auth_enrollment_grants ORDER BY token_hash').all();
    expect(() => batch(createOperatorMutation(proposed, { now: now + 11 }).sql)).toThrow(/CHECK/);
    expect(db.prepare('SELECT * FROM auth_enrollment_grants ORDER BY token_hash').all()).toEqual(before);
  });
  it('rolls back revocations, challenge deletion and pending state when grant insertion fails', () => {
    seedAuth();
    const token = hash('Z');
    db.prepare('INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('base64url'), 'sam', 'enroll', now, now + 3600);
    const tables = ['auth_members', 'auth_credentials', 'auth_sessions', 'auth_enrollment_grants', 'auth_challenges', 'auth_audit'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    expect(() => batch(createOperatorMutation(plan('recover'), { now: now + 10, token }).sql)).toThrow(/UNIQUE/);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
  });
  it('refuses unknown/suspended recovery identities and notices authentication changes after review', () => {
    seedAuth();
    expect(() => plan('recover', { member: 'unknown' })).toThrow('does not exist');
    expect(() => plan('recover', { member: 'former' })).toThrow('Suspended');
    const proposed = plan('recover');
    db.prepare('UPDATE auth_credentials SET revoked_at=? WHERE member_id=?').run(now, 'alex');
    expect(() => batch(createOperatorMutation(proposed, { now }).sql)).toThrow(/CHECK/);
  });
});

describe('private output and CLI reporting', () => {
  it('creates no file/token on dry run, and apply saves a random token only in an exclusive 0600 file', () => {
    seedRoster();
    const output = join(folder, 'authorization.json');
    const dry = run(options('bootstrap', { output }));
    expect(existsSync(output)).toBe(false);
    expect(writes).toBe(0);
    run(options('bootstrap', { apply: true, review: dry.review, output }));
    const grant = JSON.parse(readFileSync(output, 'utf8'));
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(grant.token, 'base64url').length).toBe(32);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(grant.expiresAt - grant.createdAt).toBe(3600);
    expect(messages.join('\n')).not.toContain(grant.token);
    expect(messages.join('\n')).not.toContain(roster[0].name);
    expect(db.prepare('SELECT token_hash FROM auth_enrollment_grants').get()?.token_hash).toBe(createHash('sha256').update(grant.token).digest('base64url'));
  });
  it.each(['existing', 'symlink'])('never overwrites an %s output or mutates the database when reservation fails', kind => {
    seedRoster();
    const output = join(folder, 'authorization.json');
    if (kind === 'existing') writeFileSync(output, 'preserve');
    else symlinkSync(input, output);
    const original = readFileSync(output, 'utf8');
    const dry = run(options('bootstrap'));
    expect(() => run(options('bootstrap', { apply: true, review: dry.review, output }))).toThrow('before database mutation');
    expect(readFileSync(output, 'utf8')).toBe(original);
    expect(writes).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_enrollment_grants').get()?.n).toBe(0);
  });
  it('never forwards child error output and reports uncertain applies honestly', () => {
    seedRoster();
    const dry = run(options('bootstrap'));
    const output = join(folder, 'authorization.json');
    expect(() => runOperator(options('bootstrap', { apply: true, review: dry.review, output }), {
      execute: (target, request) => { if (request.file) throw new Error('private-sentinel'); return execute(target, request); },
      print: message => messages.push(message),
    })).toThrow('outcome is unconfirmed');
    expect(existsSync(output)).toBe(true);
    expect(messages.join('\n')).not.toContain('private-sentinel');
    expect(messages.join('\n')).not.toContain(JSON.parse(readFileSync(output, 'utf8')).token);
  });
  it('CLI errors never echo untrusted input or output paths', () => {
    for (const args of [['recover', '--member', 'private-sentinel@example.test'], ['import', '--input', join(folder, 'private-sentinel')]]) {
      const result = spawnSync(process.execPath, ['scripts/auth-operator.mjs', ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain('private-sentinel');
    }
  });
});
