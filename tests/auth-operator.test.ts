import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOperatorMutation, createOperatorPlan, loadOperatorTarget, operatorSnapshotSql, parseOperatorArgs, parseWranglerOutput, runOperator, wranglerArguments } from '../scripts/auth-operator.mjs';
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
  return { command, config, remote: false, apply: false, expiresIn: 3600, ...(command === 'import' || command === 'restore-lock' ? { input } : { member: 'alex' }), ...changes };
}
function snapshot(member?: string, allAuth = false) { return db.prepare(operatorSnapshotSql(member, allAuth)).get() as unknown as OperatorSnapshot; }
function plan(command: OperatorOptions['command'], changes: Partial<OperatorOptions> = {}) {
  const opts = options(command, changes);
  return createOperatorPlan(opts, loadOperatorTarget(opts), snapshot(opts.member, command === 'restore-lock'), command === 'import' || command === 'restore-lock' ? roster : undefined);
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
  it('recovery-first enrollment durably closes bootstrap even before any credential exists', () => {
    seedRoster();
    batch(createOperatorMutation(plan('recover'), { now }).sql);
    expect(db.prepare('SELECT * FROM auth_operator_state').all()).toEqual([{ id: 'bootstrap', created_at: now }]);
    expect(db.prepare('SELECT count(*) n FROM auth_credentials').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_credential_tombstones').get()?.n).toBe(0);
    expect(() => plan('bootstrap')).toThrow('prior operator bootstrap');
    expect(() => plan('recover')).not.toThrow();
  });
  it('credential compaction cannot reopen bootstrap, including a restored missing marker', () => {
    seedRoster();
    const oldBootstrapPlan = plan('bootstrap');
    db.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at) VALUES ('retired_key','alex','cHVibGlj',0,0,?)").run(now);
    db.exec("UPDATE auth_members SET status='active' WHERE id='alex'");
    batch(createOperatorMutation(plan('recover'), { now }).sql);
    expect(db.prepare('SELECT count(*) n FROM auth_credentials').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_credential_tombstones').get()?.n).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM auth_operator_state').get()?.n).toBe(1);
    expect(() => plan('bootstrap')).toThrow('credential history');
    db.exec('DELETE FROM auth_operator_state');
    expect(() => plan('bootstrap')).toThrow('credential history');
    const before = snapshot(undefined, true).revision;
    expect(() => batch(createOperatorMutation(oldBootstrapPlan, { now }).sql)).toThrow(/CHECK/);
    expect(snapshot(undefined, true).revision).toBe(before);
    expect(() => plan('recover')).not.toThrow();
  });
  it('bootstrap rejects tombstones belonging to another permanent member', () => {
    seedRoster();
    const reviewed = plan('bootstrap');
    db.prepare("INSERT INTO auth_credential_tombstones(id_hash,member_id,retired_at) VALUES (?,'former',?)").run(hash('Y'), now);
    expect(() => plan('bootstrap')).toThrow('credential history');
    expect(() => batch(createOperatorMutation(reviewed, { now }).sql)).toThrow(/CHECK/);
    expect(db.prepare('SELECT count(*) n FROM auth_enrollment_grants').get()?.n).toBe(0);
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
      expect(db.prepare(`SELECT count(*) n FROM ${table} WHERE member_id='alex'`).get()?.n).toBe(0);
      expect(db.prepare(`SELECT revoked_at FROM ${table} WHERE member_id='sam'`).get()?.revoked_at).toBeNull();
    }
    expect(db.prepare('SELECT id_hash,member_id,retired_at FROM auth_credential_tombstones').all()).toEqual([{ id_hash: createHash('sha256').update('alex_key').digest('base64url'), member_id: 'alex', retired_at: now + 10 }]);
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
    const tables = ['auth_members', 'auth_credentials', 'auth_credential_tombstones', 'auth_sessions', 'auth_enrollment_grants', 'auth_challenges', 'auth_audit'];
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

  it('compacts the 100-credential history after restore so a new passkey can be enrolled', () => {
    seedAuth();
    const insert = db.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at,revoked_at) VALUES (?,'alex','cHVibGlj',0,0,?,?)");
    for (let index = 1; index < 100; index++) insert.run(`old_key_${index}`, now, now);
    batch(createOperatorMutation(plan('restore-lock'), { now: now + 10 }).sql);
    expect(db.prepare("SELECT count(*) n FROM auth_credentials WHERE member_id='alex'").get()?.n).toBe(100);
    const recovery = createOperatorMutation(plan('recover'), { now: now + 20 });
    batch(recovery.sql);
    expect(recovery.grant).not.toBeNull();
    expect(db.prepare("SELECT count(*) n FROM auth_credentials WHERE member_id='alex'").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM auth_credential_tombstones WHERE member_id='alex'").get()?.n).toBe(100);
    expect(db.prepare("SELECT retired_at FROM auth_credential_tombstones WHERE id_hash=?").get(createHash('sha256').update('old_key_1').digest('base64url'))?.retired_at).toBe(now);
    expect(db.prepare("SELECT retired_at FROM auth_credential_tombstones WHERE id_hash=?").get(createHash('sha256').update('alex_key').digest('base64url'))?.retired_at).toBe(now + 10);
    expect(db.prepare("SELECT count(*)<100 AS room FROM auth_credentials WHERE member_id='alex'").get()?.room).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM auth_sessions WHERE member_id='alex'").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM auth_credentials WHERE member_id='sam'").get()?.n).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves same-owner retirement evidence and refuses a conflicting tombstone owner atomically', () => {
    seedAuth();
    const idHash = createHash('sha256').update('alex_key').digest('base64url');
    db.prepare('INSERT INTO auth_credential_tombstones(id_hash,member_id,retired_at) VALUES(?,?,?)').run(idHash, 'sam', now - 1);
    const before = snapshot(undefined, true).revision;
    expect(() => batch(createOperatorMutation(plan('recover'), { now: now + 10 }).sql)).toThrow(/CHECK/);
    expect(snapshot(undefined, true).revision).toBe(before);
    db.prepare('UPDATE auth_credential_tombstones SET member_id=? WHERE id_hash=?').run('alex', idHash);
    batch(createOperatorMutation(plan('recover'), { now: now + 10 }).sql);
    expect(db.prepare('SELECT * FROM auth_credential_tombstones').all()).toEqual([{ id_hash: idHash, member_id: 'alex', retired_at: now - 1 }]);
  });

  it('refuses to compact a credential created after the recovery plan was reviewed', () => {
    seedAuth();
    const reviewed = plan('recover');
    db.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at) VALUES ('new_key','alex','cHVibGlj',0,0,?)").run(now);
    const before = snapshot(undefined, true).revision;
    expect(() => batch(createOperatorMutation(reviewed, { now: now + 10 }).sql)).toThrow(/CHECK/);
    expect(snapshot(undefined, true).revision).toBe(before);
  });
});

describe('private output and CLI reporting', () => {
  const importProgress = '├ Checking if file needs uploading\n│\n├ 🌀 Uploading synthetic.sql\n│ 🌀 Uploading complete.\n│\n';
  const importResponse = JSON.stringify([{ success: true, results: [{ 'Total queries executed': 5 }], finalBookmark: 'synthetic' }], null, 2);

  it('accepts only the known remote-file progress prefix before a complete successful JSON result', () => {
    expect(parseWranglerOutput(importProgress + importResponse, true)).toEqual([{ 'Total queries executed': 5 }]);
    expect(parseWranglerOutput('├ Checking if file needs uploading\n│\n' + importResponse, true)).toEqual([{ 'Total queries executed': 5 }]);
    expect(parseWranglerOutput(importProgress.replace('├', '\u001b[90m├\u001b[0m') + importResponse, true)).toEqual([{ 'Total queries executed': 5 }]);
    expect(parseWranglerOutput(importResponse)).toEqual([{ 'Total queries executed': 5 }]);
    expect(() => parseWranglerOutput(importProgress + importResponse)).toThrow('unexpected response');
  });

  it.each([
    'private-sentinel\n' + importResponse,
    importProgress + importResponse + '\nprivate-sentinel',
    importProgress + importResponse + '\n' + importResponse,
    importProgress + importResponse.slice(0, -1),
    importProgress + '[{"success":false,"results":[]}]',
    importProgress + '[{"success":true,"results":[]},{"success":false,"results":[]}]',
    importProgress + '[{"results":[]}]',
    importProgress + '{"success":true,"results":[]}',
    importProgress + '[{"success":true,"results":{}}]',
    '├ Checking if file needs uploading\n'.repeat(300) + importResponse,
  ])('rejects malformed or unsuccessful remote import responses without echoing content %#', stdout => {
    expect(() => parseWranglerOutput(stdout, true)).toThrow(/^D1 (returned an unexpected response; operation outcome is unconfirmed\.|did not confirm successful execution\.)$/);
  });

  it('still requires the exact audit receipt after a successful import response', () => {
    seedRoster();
    const dry = run(options('bootstrap'));
    const output = join(folder, 'authorization.json');
    expect(() => runOperator(options('bootstrap', { apply: true, review: dry.review, output }), {
      execute: (target, request) => {
        if (request.file) { execute(target, request); return parseWranglerOutput(importProgress + importResponse, true); }
        if (request.command?.startsWith('SELECT id FROM auth_audit')) return [];
        return execute(target, request);
      },
      print: message => messages.push(message),
    })).toThrow('outcome is unconfirmed');
    expect(db.prepare('SELECT count(*) n FROM auth_enrollment_grants').get()?.n).toBe(1);
    expect(existsSync(output)).toBe(true);
    expect(messages.join('\n')).not.toContain(JSON.parse(readFileSync(output, 'utf8')).token);
  });

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

describe('operator-reviewed restore lock', () => {
  function anonymousChallenge() {
    db.prepare("INSERT INTO auth_challenges(id,challenge,browser_hash,purpose,origin,rp_id,created_at,expires_at) VALUES (?,?,?,'authentication',?,?,?,?)").run('anonymous_login', hash('X'), hash('B'), 'https://hearth.example', 'hearth.example', now, now + 300);
  }

  it('reconciles current authority and revokes all restored access without changing identities or family data', () => {
    seedAuth(); anonymousChallenge();
    record('mood', 'mood', 'former', { note: 'private-restored-record', shared: false });
    record('answer', 'answer', 'alex', { participantIds: ['alex', 'sam'], choice: 2 });
    record('task', 'task', 'sam', { assigneeId: 'former', title: 'Preserve' });
    record('habit', 'habit', 'alex', { userId: 'alex', title: 'Preserve' });
    db.exec("INSERT INTO modules(id,enabled) VALUES('moods',0); INSERT INTO rate_limits(key,window_start,count) VALUES('old-limit',100,2)");
    const preservedTables = ['records', 'modules', 'family_storage', 'rate_limits'];
    const before = preservedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const identities = db.prepare('SELECT id,user_handle,created_at FROM auth_members ORDER BY id').all();
    const currentRoster = roster.map(member => member.id === 'alex' ? { ...member, role: 'member', status: 'suspended' } : member.id === 'sam' ? { ...member, name: 'Current private name', role: 'admin', color: '#123456' } : member);
    writeFileSync(input, JSON.stringify(currentRoster));
    const files = readdirSync(folder);
    const dry = run(options('restore-lock'));
    expect(writes).toBe(0);
    expect(messages.join('\n')).not.toMatch(/private-restored-record|Current private name|cHVibGlj/);
    run(options('restore-lock', { apply: true, review: dry.review }));
    expect(readdirSync(folder)).toEqual(files);
    expect(db.prepare('SELECT id,user_handle,created_at FROM auth_members ORDER BY id').all()).toEqual(identities);
    expect(preservedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
    expect(db.prepare('SELECT id,name,role,color,status FROM auth_members ORDER BY id').all()).toEqual([...currentRoster].sort((a, b) => a.id.localeCompare(b.id)));
    for (const table of ['auth_credentials', 'auth_sessions', 'auth_enrollment_grants']) expect(db.prepare(`SELECT count(*) n FROM ${table} WHERE revoked_at IS NULL`).get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM auth_challenges').get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM auth_operator_state WHERE id='bootstrap'").get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM auth_audit WHERE event='operator.restore_lock'").get()?.n).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(messages.join('\n')).toContain('Keep traffic offline');
    expect(() => plan('recover', { member: 'alex' })).toThrow('Suspended');
    const recovery = createOperatorMutation(plan('recover', { member: 'sam' }), { now: now + 20 });
    batch(recovery.sql);
    expect(recovery.grant?.memberId).toBe('sam');
    expect(db.prepare("SELECT member_id FROM auth_enrollment_grants WHERE revoked_at IS NULL").all()).toEqual([{ member_id: 'sam' }]);
    expect(db.prepare('SELECT count(*) n FROM auth_sessions WHERE revoked_at IS NULL').get()?.n).toBe(0);
  });

  it('preserves a prior bootstrap marker and existing revocation evidence without issuing a token', () => {
    seedAuth();
    db.prepare("INSERT INTO auth_operator_state(id,created_at) VALUES('bootstrap',?)").run(now - 20);
    db.prepare("UPDATE auth_credentials SET revoked_at=? WHERE member_id='sam'").run(now + 2);
    const mutation = createOperatorMutation(plan('restore-lock'), { now: now + 10 });
    expect(mutation.grant).toBeNull();
    expect(mutation.sql).not.toContain('INSERT INTO auth_enrollment_grants');
    batch(mutation.sql);
    expect(db.prepare('SELECT created_at FROM auth_operator_state').get()?.created_at).toBe(now - 20);
    expect(db.prepare("SELECT revoked_at FROM auth_credentials WHERE member_id='sam'").get()?.revoked_at).toBe(now + 2);
    expect(() => plan('bootstrap')).toThrow();
  });

  it('bounds D1 expression depth across 100 credentials and detects a stale row in the final guard group', () => {
    seedAuth();
    const insert = db.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at,revoked_at) VALUES (?,'alex','cHVibGlj',0,0,?,?)");
    for (let index = 1; index < 100; index++) insert.run(`old_key_${index}`, now, now);
    const mutation = createOperatorMutation(plan('restore-lock'), { now: now + 10 });
    const comparisons = mutation.sql.split('\n').map(statement => (statement.match(/EXISTS \(SELECT 1 FROM auth_credentials WHERE/g) ?? []).length);
    expect(Math.max(...comparisons)).toBeLessThanOrEqual(20);
    expect(comparisons.reduce((total, count) => total + count, 0)).toBe(101);
    // sam_key sorts last, so every preceding group has already passed when
    // this changed row must abort the whole batch before any reconciliation.
    db.prepare("UPDATE auth_credentials SET counter=1 WHERE id='sam_key'").run();
    const before = snapshot(undefined, true).revision;
    expect(() => batch(mutation.sql)).toThrow(/CHECK/);
    expect(snapshot(undefined, true).revision).toBe(before);
    batch(createOperatorMutation(plan('restore-lock'), { now: now + 10 }).sql);
    expect(db.prepare('SELECT count(*) n FROM auth_credentials WHERE revoked_at IS NULL').get()?.n).toBe(0);
  });

  it('makes updated/revoked timestamps valid when a restored row is newer than the operator clock', () => {
    seedAuth();
    const future = now + 100;
    db.prepare("UPDATE auth_members SET created_at=?,updated_at=? WHERE id='sam'").run(future, future + 10);
    db.prepare("UPDATE auth_credentials SET created_at=? WHERE member_id='sam'").run(future);
    db.prepare("UPDATE auth_sessions SET created_at=?,last_seen_at=?,expires_at=? WHERE member_id='sam'").run(future, future, future + 3600);
    db.prepare("UPDATE auth_enrollment_grants SET created_at=?,expires_at=? WHERE member_id='sam'").run(future, future + 3600);
    batch(createOperatorMutation(plan('restore-lock'), { now }).sql);
    expect(db.prepare("SELECT updated_at FROM auth_members WHERE id='sam'").get()?.updated_at).toBe(future + 10);
    for (const table of ['auth_credentials', 'auth_sessions', 'auth_enrollment_grants']) expect(db.prepare(`SELECT revoked_at FROM ${table} WHERE member_id='sam'`).get()?.revoked_at).toBe(future);
  });

  it.each([
    { label: 'missing existing member', members: roster.slice(0, 2) },
    { label: 'new identity', members: [...roster, { ...roster[1], id: 'new' }] },
    { label: 'substituted identity', members: [roster[0], roster[1], { ...roster[2], id: 'replacement' }] },
    { label: 'active member', members: roster.map(member => ({ ...member, status: 'active' })) },
    { label: 'email field', members: roster.map(member => ({ ...member, email: 'private@example.test' })) },
    { label: 'no pending administrator', members: roster.map(member => ({ ...member, status: 'suspended' })) },
  ])('rejects a restore roster with $label', ({ members }) => {
    seedAuth(); writeFileSync(input, JSON.stringify(members));
    expect(() => run(options('restore-lock'))).toThrow();
    expect(writes).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM auth_members WHERE status='active'").get()?.n).toBe(2);
  });

  it('rejects missing historical references even when roster ids match every current member', () => {
    seedAuth(); record('answer', 'answer', 'alex', { participantIds: ['alex', 'historical_missing'] });
    expect(() => plan('restore-lock')).toThrow('historical_missing');
  });

  it('rejects a partial authentication snapshot and catches post-plan reference changes', () => {
    seedAuth();
    expect(() => createOperatorPlan(options('restore-lock'), loadOperatorTarget(options('restore-lock')), snapshot(), roster)).toThrow('complete authentication snapshot');
    const reviewed = plan('restore-lock');
    record('new-task', 'task', 'alex', { assigneeId: 'historical_missing' });
    expect(() => batch(createOperatorMutation(reviewed, { now }).sql)).toThrow(/CHECK/);
    expect(db.prepare("SELECT status FROM auth_members WHERE id='alex'").get()?.status).toBe('active');
  });

  it.each([
    { label: 'member name', change: "UPDATE auth_members SET name='New name' WHERE id='sam'" },
    { label: 'member role', change: "UPDATE auth_members SET role='admin' WHERE id='sam'" },
    { label: 'member color', change: "UPDATE auth_members SET color='#112233' WHERE id='sam'" },
    { label: 'member handle', change: `UPDATE auth_members SET user_handle='${hash('Y')}' WHERE id='sam'` },
    { label: 'member added', change: `INSERT INTO auth_members(id,name,role,color,status,user_handle,created_at,updated_at) VALUES('new','New','member','#123456','pending','${hash('Y')}',${now},${now})` },
    { label: 'credential counter', change: "UPDATE auth_credentials SET counter=1 WHERE member_id='sam'" },
    { label: 'credential key', change: "UPDATE auth_credentials SET public_key='Y2hhbmdlZA' WHERE member_id='sam'" },
    { label: 'credential name', change: "UPDATE auth_credentials SET name='Changed key' WHERE member_id='sam'" },
    { label: 'credential retirement', change: `INSERT INTO auth_credential_tombstones(id_hash,member_id,retired_at) VALUES('${hash('Y')}','sam',${now})` },
    { label: 'session activity', change: `UPDATE auth_sessions SET last_seen_at=${now + 1} WHERE member_id='sam'` },
    { label: 'session browser', change: `UPDATE auth_sessions SET browser_hash='${hash('Y')}' WHERE member_id='sam'` },
    { label: 'grant revocation', change: `UPDATE auth_enrollment_grants SET revoked_at=${now} WHERE member_id='sam'` },
    { label: 'anonymous challenge added', change: `INSERT INTO auth_challenges(id,challenge,browser_hash,purpose,origin,rp_id,created_at,expires_at) VALUES('anonymous','${hash('Y')}','${hash('B')}','authentication','https://hearth.example','hearth.example',${now},${now + 300})` },
    { label: 'member challenge removed', change: "DELETE FROM auth_challenges WHERE member_id='sam'" },
    { label: 'bootstrap marker', change: `INSERT INTO auth_operator_state(id,created_at) VALUES('bootstrap',${now})` },
    { label: 'auth rate state', change: `INSERT INTO auth_rate_windows(key,window_start,count) VALUES('global',${now},1)` },
  ])('rejects stale restore plans after $label changes and leaves that newer state intact', ({ change }) => {
    seedAuth();
    const reviewed = plan('restore-lock');
    db.exec(change);
    const newer = snapshot(undefined, true).revision;
    expect(() => batch(createOperatorMutation(reviewed, { now: now + 10 }).sql)).toThrow(/CHECK/);
    expect(snapshot(undefined, true).revision).toBe(newer);
  });

  it('binds the printed review hash to anonymous challenges and the current roster', () => {
    seedAuth();
    const dry = run(options('restore-lock'));
    anonymousChallenge();
    expect(() => run(options('restore-lock', { apply: true, review: dry.review }))).toThrow('Plan changed');
    const updated = run(options('restore-lock'));
    writeFileSync(input, JSON.stringify(roster.map(member => ({ ...member, name: 'Reviewed differently' }))));
    expect(() => run(options('restore-lock', { apply: true, review: updated.review }))).toThrow('Plan changed');
    expect(writes).toBe(0);
  });

  it('rolls back every revocation and membership edit if the final audit insert fails', () => {
    seedAuth(); anonymousChallenge();
    const operationId = hash('Z');
    db.prepare('INSERT INTO auth_audit(id,event,created_at) VALUES(?,?,?)').run(operationId, 'existing', now);
    const before = snapshot(undefined, true).revision;
    expect(() => batch(createOperatorMutation(plan('restore-lock'), { now: now + 10, operationId }).sql)).toThrow(/UNIQUE/);
    expect(snapshot(undefined, true).revision).toBe(before);
  });

  it('supports a reviewed explicit reclassification while keeping the existing permanent identity', () => {
    seedAuth();
    writeFileSync(input, JSON.stringify(roster.map(member => member.id === 'former' ? { ...member, status: 'pending' } : member)));
    const handle = db.prepare("SELECT user_handle FROM auth_members WHERE id='former'").get()?.user_handle;
    const dry = run(options('restore-lock')); run(options('restore-lock', { apply: true, review: dry.review }));
    expect(db.prepare("SELECT status,user_handle FROM auth_members WHERE id='former'").get()).toEqual({ status: 'pending', user_handle: handle });
  });

  it.each([
    ['restore-lock'], ['restore-lock', '--input', 'roster', '--member', 'alex'],
    ['restore-lock', '--input', 'roster', '--output', 'secret'],
    ['restore-lock', '--input', 'roster', '--expires-in', '3600'],
    ['restore-lock', '--input', 'roster', '--apply'],
  ].map(args => ({ args })))('CLI rejects incomplete or token-issuing restore options %#', ({ args }) => {
    const result = spawnSync(process.execPath, ['scripts/auth-operator.mjs', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(writes).toBe(0);
  });
});
