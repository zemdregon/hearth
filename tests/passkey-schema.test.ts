import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migrations = ['0001_initial.sql', '0002_storage_budget.sql', '0003_passkey_foundation.sql'];
const authTables = ['auth_members', 'auth_credentials', 'auth_enrollment_grants', 'auth_challenges', 'auth_sessions', 'auth_audit'];
const now = 1_791_417_600;
const hash = (character: string) => character.repeat(43);
type Row = Record<string, string | number | null>;
let db: DatabaseSync;

function migrate(name: string) {
  db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
}

// Identifiers are test-owned constants; data always uses SQLite bindings.
function insert(table: string, row: Row) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
}

function member(changes: Row = {}) {
  return insert('auth_members', {
    id: 'alex', name: 'Alex', role: 'admin', color: '#38634A', status: 'pending',
    user_handle: hash('A'), created_at: now, updated_at: now, ...changes,
  });
}

function credential(changes: Row = {}) {
  return insert('auth_credentials', {
    id: 'credential_A', member_id: 'alex', public_key: 'cHVibGljLWtleQ', counter: 0,
    transports: '["internal","hybrid"]', backup_eligible: 1, backed_up: 1,
    created_at: now, last_used_at: null, revoked_at: null, ...changes,
  });
}

function grant(changes: Row = {}) {
  return insert('auth_enrollment_grants', {
    token_hash: hash('G'), member_id: 'alex', purpose: 'bootstrap', created_at: now,
    expires_at: now + 600, consumed_at: null, revoked_at: null, ...changes,
  });
}

function challenge(changes: Row = {}) {
  return insert('auth_challenges', {
    id: 'ceremony_A', challenge: hash('C'), browser_hash: hash('B'), purpose: 'registration',
    member_id: 'alex', grant_hash: hash('G'), origin: 'https://hearth.example', rp_id: 'hearth.example',
    created_at: now, expires_at: now + 300, consumed_at: null, ...changes,
  });
}

function session(changes: Row = {}) {
  return insert('auth_sessions', {
    token_hash: hash('S'), member_id: 'alex', credential_id: 'credential_A', created_at: now,
    last_seen_at: now, expires_at: now + 3600, reauthenticated_at: null, revoked_at: null, ...changes,
  });
}

function audit(changes: Row = {}) {
  return insert('auth_audit', {
    id: 'event_A', actor_id: null, target_id: 'alex', event: 'member.enrollment_authorized', created_at: now, ...changes,
  });
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of migrations) migrate(name);
});
afterEach(() => db.close());

describe('additive passkey foundation migration', () => {
  it('preserves records, permanent owners, couples audiences, module settings and storage accounting', () => {
    db.close();
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(migrations[0]);
    migrate(migrations[1]);
    const savedRecords = [
      { id: 'private-mood', kind: 'mood', owner_id: 'departed_member', data: JSON.stringify({ date: '2026-10-08', score: 2, note: 'Private 🌿', shared: false }) },
      { id: 'paired-answer', kind: 'answer', owner_id: 'stable_alex', data: JSON.stringify({ date: '2026-10-08', participantIds: ['stable_alex', 'stable_sam'], choice: 1, shareToProfile: false }) },
      { id: 'legacy-answer', kind: 'answer', owner_id: 'stable_sam', data: JSON.stringify({ date: '2026-10-08', choice: 0 }) },
      { id: 'departed-profile', kind: 'profile', owner_id: 'departed_member', data: JSON.stringify({ bio: 'Keep this id' }) },
    ];
    for (const row of savedRecords) insert('records', { ...row, created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z', version: 7 });
    insert('modules', { id: 'moods', enabled: 0 });
    insert('modules', { id: 'questions', enabled: 1 });
    insert('rate_limits', { key: 'existing-limit', window_start: now, count: 4 });
    const preservedTables = ['records', 'modules', 'rate_limits', 'family_storage'];
    const before = preservedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const oldSchema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();

    migrate(migrations[2]);

    expect(preservedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
    expect(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'auth_%' ORDER BY name").all()).toEqual(oldSchema);
    expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({
      id: 1, record_count: savedRecords.length,
      data_bytes: savedRecords.reduce((total, record) => total + Buffer.byteLength(record.data), 0),
    });
    for (const table of authTables) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });

  it('creates only email-free authentication tables with a minimal audit record and no new triggers', () => {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'auth_%' ORDER BY name").all().map(row => row.name)).toEqual([...authTables].sort());
    for (const table of authTables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      expect(columns).not.toContain('email');
      expect(columns).not.toContain('private_key');
      expect(columns).not.toContain('token');
    }
    expect(db.prepare('PRAGMA table_info(auth_audit)').all().map(row => row.name)).toEqual(['id', 'actor_id', 'target_id', 'event', 'created_at']);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name LIKE 'auth_%'").all()).toEqual([]);
  });

  it('keeps both original storage-budget guards effective after migration', () => {
    const largeData = JSON.stringify({ text: 'x'.repeat(8_388_608 - 11) });
    insert('records', { id: 'at-byte-limit', kind: 'note', owner_id: 'existing_owner', data: largeData, created_at: 'before', updated_at: 'before', version: 1 });
    expect(db.prepare('SELECT data_bytes FROM family_storage').get()?.data_bytes).toBe(8_388_608);
    expect(() => insert('records', { id: 'over-byte-limit', kind: 'note', owner_id: 'existing_owner', data: '{}', created_at: 'after', updated_at: 'after', version: 1 })).toThrow('FAMILY_STORAGE_LIMIT');
    db.exec("DELETE FROM records; WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000) INSERT INTO records (id, kind, owner_id, data, created_at, updated_at) SELECT 'record-' || n, 'note', 'existing_owner', '{}', 'before', 'before' FROM sequence;");
    expect(db.prepare('SELECT record_count FROM family_storage').get()?.record_count).toBe(10_000);
    expect(() => insert('records', { id: 'over-count-limit', kind: 'note', owner_id: 'existing_owner', data: '{}', created_at: 'after', updated_at: 'after', version: 1 })).toThrow('FAMILY_STORAGE_LIMIT');
    expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: 20_000, record_count: 10_000 });
  });
});

describe('passkey identity and credential constraints', () => {
  it('rejects reused permanent ids and opaque handles while allowing equal display names', () => {
    member();
    expect(() => member({ user_handle: hash('D') })).toThrow(/UNIQUE/);
    expect(() => member({ id: 'sam' })).toThrow(/UNIQUE/);
    member({ id: 'sam', user_handle: hash('D') });
    expect(db.prepare('SELECT id, name FROM auth_members ORDER BY id').all()).toEqual([{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Alex' }]);
  });

  it.each([
    ['missing id', { id: null }], ['empty id', { id: '' }], ['oversized id', { id: 'a'.repeat(65) }],
    ['email identity', { id: 'alex@example.com' }], ['embedded nul', { id: 'alex\0suffix' }],
    ['empty name', { name: '' }], ['untrimmed name', { name: ' Alex ' }], ['oversized name', { name: 'a'.repeat(101) }],
    ['unknown role', { role: 'owner' }], ['unknown status', { status: 'invited' }], ['invalid color', { color: '#GGGGGG' }],
    ['short handle', { user_handle: 'short' }], ['padded handle', { user_handle: `${'A'.repeat(42)}=` }],
    ['negative timestamp', { created_at: -1 }], ['fractional timestamp', { created_at: now + 0.5 }],
    ['non-numeric timestamp', { created_at: 'yesterday' }], ['backdated update', { updated_at: now - 1 }],
  ] satisfies [string, Row][])('rejects invalid member field: %s', (_label, changes) => {
    expect(() => member(changes)).toThrow(/constraint failed/);
  });

  it('preserves accepted legacy member bounds and stores pending status by default', () => {
    const id = 'a'.repeat(64);
    insert('auth_members', { id, name: 'N'.repeat(100), role: 'member', color: '#aBcD01', user_handle: hash('A'), created_at: now, updated_at: now });
    expect(db.prepare('SELECT id, name, status FROM auth_members').get()).toEqual({ id, name: 'N'.repeat(100), status: 'pending' });
  });

  it('rejects registering an existing credential for another member', () => {
    member();
    member({ id: 'sam', user_handle: hash('D') });
    credential();
    expect(() => credential({ member_id: 'sam' })).toThrow(/UNIQUE/);
    credential({ id: 'second_credential', counter: 0, backup_eligible: 0, backed_up: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM auth_credentials WHERE member_id = ?').get('alex')?.n).toBe(2);
  });

  it.each([
    ['empty credential', { id: '' }], ['oversized credential', { id: 'A'.repeat(2049) }],
    ['non-base64url credential', { id: 'credential/=' }], ['empty key', { public_key: '' }], ['oversized key', { public_key: 'A'.repeat(8193) }],
    ['negative counter', { counter: -1 }], ['fractional counter', { counter: 0.5 }], ['overflow counter', { counter: 4_294_967_296 }],
    ['invalid JSON', { transports: '[' }], ['object transports', { transports: '{}' }], ['unbounded transports', { transports: JSON.stringify(Array(9).fill('usb')) }],
    ['non-boolean eligibility', { backup_eligible: 2 }], ['non-boolean backup', { backed_up: 2 }],
    ['impossible backup', { backup_eligible: 0, backed_up: 1 }], ['backdated use', { last_used_at: now - 1 }], ['backdated revocation', { revoked_at: now - 1 }],
  ] satisfies [string, Row][])('rejects invalid credential field: %s', (_label, changes) => {
    member();
    expect(() => credential(changes)).toThrow(/constraint failed/);
  });
});

describe('authorization, challenge, session and audit constraints', () => {
  beforeEach(() => member());

  it.each([
    ['unhashed token', { token_hash: 'raw-token' }], ['unknown purpose', { purpose: 'login' }],
    ['empty lifetime', { expires_at: now }], ['excessive lifetime', { expires_at: now + 86_401 }],
    ['fractional expiry', { expires_at: now + 0.5 }], ['backdated consumption', { consumed_at: now - 1 }],
    ['consumed at expiry', { consumed_at: now + 600 }], ['backdated revocation', { revoked_at: now - 1 }],
  ] satisfies [string, Row][])('rejects invalid enrollment authorization: %s', (_label, changes) => {
    expect(() => grant(changes)).toThrow(/constraint failed/);
  });

  it('supports each bounded enrollment purpose without granting a session', () => {
    for (const [index, purpose] of ['bootstrap', 'enroll', 'recover'].entries()) grant({ purpose, token_hash: hash(String(index)), expires_at: now + 86_400 });
    expect(db.prepare('SELECT count(*) AS n FROM auth_enrollment_grants').get()?.n).toBe(3);
    expect(db.prepare('SELECT count(*) AS n FROM auth_sessions').get()?.n).toBe(0);
    expect(db.prepare('SELECT status FROM auth_members').get()?.status).toBe('pending');
  });

  it.each([
    ['short challenge', { challenge: 'short' }], ['short browser binding', { browser_hash: 'short' }],
    ['unknown purpose', { purpose: 'recovery' }], ['anonymous registration', { member_id: null }],
    ['grant used for authentication', { purpose: 'authentication' }], ['empty origin', { origin: '' }], ['empty RP id', { rp_id: '' }],
    ['empty lifetime', { expires_at: now }], ['excessive lifetime', { expires_at: now + 301 }], ['consumed at expiry', { consumed_at: now + 300 }],
  ] satisfies [string, Row][])('rejects invalid ceremony state: %s', (_label, changes) => {
    grant();
    expect(() => challenge(changes)).toThrow(/constraint failed/);
  });

  it('supports discoverable login and member-bound reauthentication while rejecting challenge reuse', () => {
    challenge({ purpose: 'authentication', member_id: null, grant_hash: null });
    expect(() => challenge({ id: 'ceremony_B', purpose: 'authentication', member_id: null, grant_hash: null })).toThrow(/UNIQUE/);
    challenge({ id: 'ceremony_B', challenge: hash('D'), purpose: 'reauthentication', grant_hash: null });
    expect(() => challenge({ id: 'ceremony_C', challenge: hash('E'), purpose: 'reauthentication', member_id: null, grant_hash: null })).toThrow(/CHECK/);
    challenge({ id: 'ceremony_C', challenge: hash('E'), grant_hash: null });
    expect(db.prepare('SELECT count(*) AS n FROM auth_challenges').get()?.n).toBe(3);
  });

  it('rejects a grant-bound challenge for a different member', () => {
    member({ id: 'sam', user_handle: hash('D') });
    grant();
    expect(() => challenge({ member_id: 'sam' })).toThrow(/FOREIGN KEY/);
    challenge();
  });

  it.each([
    ['unhashed session token', { token_hash: 'secret' }], ['empty lifetime', { expires_at: now }],
    ['excessive lifetime', { expires_at: now + 2_592_001 }], ['backdated activity', { last_seen_at: now - 1 }],
    ['activity after expiry', { last_seen_at: now + 3600 }], ['backdated verification', { reauthenticated_at: now - 1 }],
    ['verification after expiry', { reauthenticated_at: now + 3600 }], ['backdated revocation', { revoked_at: now - 1 }],
  ] satisfies [string, Row][])('rejects invalid session state: %s', (_label, changes) => {
    credential();
    expect(() => session(changes)).toThrow(/constraint failed/);
  });

  it('ties each session to the credential owner and preserves identity history on suspension', () => {
    member({ id: 'sam', user_handle: hash('D') });
    credential();
    expect(() => session({ member_id: 'sam' })).toThrow(/FOREIGN KEY/);
    session({ expires_at: now + 2_592_000 });
    audit();
    db.prepare('UPDATE auth_members SET status = ?, updated_at = ? WHERE id = ?').run('suspended', now + 1, 'alex');
    expect(db.prepare('SELECT member_id FROM auth_credentials').get()?.member_id).toBe('alex');
    expect(db.prepare('SELECT member_id FROM auth_sessions').get()?.member_id).toBe('alex');
    expect(() => db.prepare('DELETE FROM auth_members WHERE id = ?').run('alex')).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('DELETE FROM auth_credentials WHERE id = ?').run('credential_A')).toThrow(/FOREIGN KEY/);
    expect(db.prepare('SELECT target_id FROM auth_audit').get()?.target_id).toBe('alex');
  });

  it('actually enforces foreign keys for every relationship', () => {
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(() => credential({ member_id: 'missing' })).toThrow(/FOREIGN KEY/);
    expect(() => grant({ member_id: 'missing' })).toThrow(/FOREIGN KEY/);
    expect(() => challenge({ member_id: 'missing', grant_hash: null })).toThrow(/FOREIGN KEY/);
    expect(() => challenge()).toThrow(/FOREIGN KEY/);
    expect(() => session()).toThrow(/FOREIGN KEY/);
    expect(() => audit({ actor_id: 'missing' })).toThrow(/FOREIGN KEY/);
    expect(() => audit({ target_id: 'missing' })).toThrow(/FOREIGN KEY/);
    credential();
    expect(() => session({ member_id: 'missing' })).toThrow(/FOREIGN KEY/);
    grant();
    challenge();
    session();
    audit();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each(['', 'a'.repeat(65), 'Member signed in with private details', 'person@example.com'])('rejects unbounded or free-form audit identifiers: %j', event => {
    expect(() => audit({ event })).toThrow(/CHECK/);
  });
});
