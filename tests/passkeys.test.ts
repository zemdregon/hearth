import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { authenticatePasskey, passkeyRoutes, readPasskeyConfig, type PasskeyEnv } from '../src/server/passkeys';

const origin = 'https://hearth.example';
const rpID = 'hearth.example';
const timestamp = 1_791_417_600;
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest();
let sqlite: DatabaseSync;
let env: PasskeyEnv;
let beforeBatch: ((sql: string[]) => void | Promise<void>) | undefined;

// The adapter executes production SQL against real SQLite. A batch completes
// synchronously, exactly as D1's serialized transaction, before its Promise resolves.
function database(): D1Database {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  class Statement {
    values: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null)[]) { this.values = values; return this; }
    execute() {
      const results = sqlite.prepare(this.sql).all(...this.values);
      return { results, success: true, meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get()!.n) } };
    }
    async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
  }
  return {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      const pause = beforeBatch?.(statements.map(statement => statement.sql));
      if (pause) await pause;
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
}
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, data?: unknown, headers: Record<string, string> = {}) {
    const result = await passkeyRoutes.request(`${origin}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: this.cookieHeader(), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
    for (const value of result.headers.getSetCookie()) {
      const [name, token] = value.split(';', 1)[0].split('=');
      if (token) this.cookies.set(name, token); else this.cookies.delete(name);
    }
    return result;
  }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  identity() { return authenticatePasskey(new Request(`${origin}/api/bootstrap`, { headers: { Cookie: this.cookieHeader() } }), env); }
}
function member(id = 'alex', role = 'admin', status = 'pending') {
  const handle = b64(randomBytes(32));
  sqlite.prepare('INSERT INTO auth_members(id,name,role,color,status,user_handle,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, id, role, '#38634A', status, handle, timestamp, timestamp);
  return handle;
}
function grant(id = 'alex') {
  const token = b64(randomBytes(32));
  sqlite.prepare("INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES (?,?,'bootstrap',?,?)").run(b64(digest(token)), id, timestamp, timestamp + 86400);
  return token;
}
function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  return {
    id: b64(id), publicKey,
    register(challenge: string, changes: { origin?: string; rpID?: string; flags?: number; crossOrigin?: boolean; attestation?: 'packed' } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: changes.origin || origin, crossOrigin: changes.crossOrigin || false }));
      const credentialLength = Buffer.alloc(2); credentialLength.writeUInt16BE(id.length);
      const authData = Buffer.concat([digest(changes.rpID || rpID), Buffer.from([changes.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), credentialLength, id, publicKey]);
      const attStmt = changes.attestation === 'packed' ? new Map<string, number | Uint8Array>([['alg', -7], ['sig', sign('sha256', Buffer.concat([authData, digest(clientDataJSON)]), pair.privateKey)]]) : new Map<string, number | Uint8Array>();
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>([['fmt', changes.attestation || 'none'], ['authData', authData], ['attStmt', attStmt]]));
      return { id: b64(id), rawId: b64(id), type: 'public-key', response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestation), transports: ['internal'] }, clientExtensionResults: { credProps: { rk: true } } };
    },
    assertion(challenge: string, userHandle: string, changes: { origin?: string; rpID?: string; flags?: number; counter?: number; challenge?: string; crossOrigin?: boolean; signature?: string } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: changes.challenge || challenge, origin: changes.origin || origin, crossOrigin: changes.crossOrigin || false }));
      const count = Buffer.alloc(4); count.writeUInt32BE(changes.counter || 0);
      const authenticatorData = Buffer.concat([digest(changes.rpID || rpID), Buffer.from([changes.flags ?? 5]), count]);
      const signature = changes.signature || b64(sign('sha256', Buffer.concat([authenticatorData, digest(clientDataJSON)]), pair.privateKey));
      return { id: b64(id), rawId: b64(id), type: 'public-key', response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature, userHandle }, clientExtensionResults: {} };
    },
  };
}
async function options(browser: Browser, path: string, input = {}) {
  const result = await browser.request(path, input);
  expect(result.status, await result.clone().text()).toBe(200);
  return result.json() as Promise<{ ceremonyId: string; options: { challenge: string; [key: string]: unknown } }>;
}
async function enroll(browser: Browser, key: ReturnType<typeof authenticator>, token: string) {
  const ceremony = await options(browser, '/register/options', { token });
  const result = await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: key.register(ceremony.options.challenge), name: 'My device' });
  expect(result.status, await result.clone().text()).toBe(200);
}
async function login(browser: Browser, key: ReturnType<typeof authenticator>, handle: string) {
  const ceremony = await options(browser, '/login/options');
  const result = await browser.request('/login/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) });
  expect(result.status, await result.clone().text()).toBe(200);
  return result;
}
async function active(id = 'alex', role = 'admin') {
  const handle = member(id, role);
  const token = grant(id);
  const key = authenticator(); const browser = new Browser();
  await enroll(browser, key, token); await login(browser, key, handle);
  return { browser, key, handle };
}
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(timestamp * 1000); env = { DB: database(), APP_ORIGIN: origin, WEBAUTHN_RP_ID: rpID }; beforeBatch = undefined; });
afterEach(() => { beforeBatch = undefined; sqlite.close(); vi.restoreAllMocks(); });

describe('real WebAuthn passkey registration, assertions and sessions', () => {
  it('requires enrollment then a real signed assertion, stores hashes only, and rotates a secure session', async () => {
    const browser = new Browser(); const key = authenticator(); const handle = member(); const token = grant();
    await enroll(browser, key, token);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    expect(browser.cookies.has('__Host-hearth_session')).toBe(false);
    const signedIn = await login(browser, key, handle);
    expect(signedIn.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(await browser.identity()).toEqual({ id: 'alex', name: 'alex', role: 'admin', color: '#38634A' });
    const old = browser.cookies.get('__Host-hearth_session')!;
    expect(sqlite.prepare('SELECT token_hash FROM auth_sessions').get()!.token_hash).toBe(b64(digest(old)));
    expect(signedIn.headers.get('Cache-Control')).toBe('no-store, private');
    await login(browser, key, handle);
    expect(browser.cookies.get('__Host-hearth_session')).not.toBe(old);
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE token_hash=?').get(b64(digest(old)))!.revoked_at).toBe(timestamp);
    expect((await (await browser.request('/credentials')).json() as { credentials: unknown }).credentials).toEqual([{ id: key.id, name: 'My device', createdAt: timestamp, lastUsedAt: timestamp, current: true }]);
    expect(sqlite.prepare('SELECT * FROM auth_transaction_guards').all()).toEqual([]);
  });
  it.each([
    ['wrong origin', { origin: 'https://other.example' }], ['wrong RP', { rpID: 'other.example' }],
    ['wrong challenge', { challenge: b64(randomBytes(32)) }], ['missing UV', { flags: 1 }], ['missing presence', { flags: 4 }],
    ['cross origin', { crossOrigin: true }], ['wrong signature', { signature: b64(randomBytes(70)) }],
  ])('rejects a signed assertion with %s', async (_name, change) => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/login/options');
    const response = await browser.request('/login/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle, change) });
    expect(response.status).toBe(401);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n).toBe(1);
  });
  it.each(['origin', 'rp', 'uv', 'resident', 'crossOrigin'])('rejects invalid registration %s without consuming the grant', async issue => {
    const browser = new Browser(); const key = authenticator(); member(); const token = grant();
    const ceremony = await options(browser, '/register/options', { token });
    const response = key.register(ceremony.options.challenge, issue === 'origin' ? { origin: 'https://other.example' } : issue === 'rp' ? { rpID: 'other.example' } : issue === 'uv' ? { flags: 0x41 } : issue === 'crossOrigin' ? { crossOrigin: true } : {});
    if (issue === 'resident') response.clientExtensionResults.credProps.rk = false;
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response })).status).toBe(401);
    expect(sqlite.prepare('SELECT consumed_at FROM auth_enrollment_grants').get()!.consumed_at).toBe(null);
    expect(sqlite.prepare('SELECT status FROM auth_members').get()!.status).toBe('pending');
  });
  it('rejects a different browser, missing or wrong user handle and duplicate credential ownership', async () => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/login/options');
    const request = { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) };
    expect((await new Browser().request('/login/verify', request)).status).toBe(401);
    request.response.response.userHandle = b64(randomBytes(32));
    expect((await browser.request('/login/verify', request)).status).toBe(401);
    request.response.response.userHandle = '';
    expect((await browser.request('/login/verify', request)).status).toBe(401);
    member('sam', 'member'); const token = grant('sam');
    const registration = await options(browser, '/register/options', { token });
    expect((await browser.request('/register/verify', { ceremonyId: registration.ceremonyId, response: key.register(registration.options.challenge) })).status).toBe(409);
    expect(sqlite.prepare("SELECT status FROM auth_members WHERE id='sam'").get()!.status).toBe('pending');
    expect(sqlite.prepare("SELECT consumed_at FROM auth_enrollment_grants WHERE member_id='sam'").get()!.consumed_at).toBe(null);
  });
  it('atomically accepts exactly one concurrent registration and one concurrent assertion', async () => {
    const browser = new Browser(); const key = authenticator(); const handle = member(); const token = grant();
    const registration = await options(browser, '/register/options', { token });
    const payload = { ceremonyId: registration.ceremonyId, response: key.register(registration.options.challenge) };
    const registrations = await Promise.all([browser.request('/register/verify', payload), browser.request('/register/verify', payload)]);
    expect(registrations.map(result => result.status).sort()).toEqual([200, 409]);
    const authentication = await options(browser, '/login/options');
    const assertion = { ceremonyId: authentication.ceremonyId, response: key.assertion(authentication.options.challenge, handle) };
    const authentications = await Promise.all([browser.request('/login/verify', assertion), browser.request('/login/verify', assertion)]);
    expect(authentications.map(result => result.status).sort()).toEqual([200, 409]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credentials').get()!.n).toBe(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n).toBe(1);
  });
  it('allows only one of two independent ceremonies redeeming the same enrollment grant', async () => {
    const first = new Browser(); const second = new Browser(); member(); const token = grant();
    const firstKey = authenticator(); const secondKey = authenticator();
    const one = await options(first, '/register/options', { token });
    const two = await options(second, '/register/options', { token });
    const results = await Promise.all([
      first.request('/register/verify', { ceremonyId: one.ceremonyId, response: firstKey.register(one.options.challenge) }),
      second.request('/register/verify', { ceremonyId: two.ceremonyId, response: secondKey.register(two.options.challenge) }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credentials').get()!.n).toBe(1);
    // Cleanup also removes the losing outstanding grant-linked ceremony, before its grant.
    expect((await new Browser().request('/login/options', {})).status).toBe(200);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_enrollment_grants').get()!.n).toBe(0);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('accepts backed-up multi-device zero counters and preserves backup eligibility', async () => {
    const browser = new Browser(); const key = authenticator(); const handle = member(); const token = grant();
    const registration = await options(browser, '/register/options', { token });
    expect((await browser.request('/register/verify', { ceremonyId: registration.ceremonyId, response: key.register(registration.options.challenge, { flags: 0x5d }) })).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const assertion = await options(browser, '/login/options');
      expect((await browser.request('/login/verify', { ceremonyId: assertion.ceremonyId, response: key.assertion(assertion.options.challenge, handle, { flags: 0x1d }) })).status).toBe(200);
    }
    const changed = await options(browser, '/login/options');
    expect((await browser.request('/login/verify', { ceremonyId: changed.ceremonyId, response: key.assertion(changed.options.challenge, handle, { flags: 5 }) })).status).toBe(401);
    expect(sqlite.prepare('SELECT backup_eligible,backed_up,counter FROM auth_credentials').get()).toEqual({ backup_eligible: 1, backed_up: 1, counter: 0 });
  });
  it('accepts zero counters and rejects replaying nonzero signature counters', async () => {
    const { browser, key, handle } = await active();
    await login(browser, key, handle);
    const first = await options(browser, '/login/options');
    expect((await browser.request('/login/verify', { ceremonyId: first.ceremonyId, response: key.assertion(first.options.challenge, handle, { counter: 1 }) })).status).toBe(200);
    const second = await options(browser, '/login/options');
    expect((await browser.request('/login/verify', { ceremonyId: second.ceremonyId, response: key.assertion(second.options.challenge, handle, { counter: 1 }) })).status).toBe(401);
  });
  it('rejects sessions after idle/absolute expiry, revocation, suspension, or credential revocation', async () => {
    const { browser } = await active();
    sqlite.prepare('UPDATE auth_sessions SET last_seen_at=?').run(timestamp);
    vi.mocked(Date.now).mockReturnValue((timestamp + 604800) * 1000);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    vi.mocked(Date.now).mockReturnValue(timestamp * 1000);
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(timestamp);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();
    sqlite.prepare("UPDATE auth_members SET status='suspended'").run();
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    sqlite.prepare("UPDATE auth_members SET status='active'").run();
    sqlite.prepare('UPDATE auth_credentials SET revoked_at=?').run(timestamp);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    sqlite.prepare('UPDATE auth_credentials SET revoked_at=NULL').run();
    vi.mocked(Date.now).mockReturnValue((timestamp + 2592000) * 1000);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('expires pending grants and challenges and never accepts an enrollment token as a session', async () => {
    const browser = new Browser(); const key = authenticator(); member(); const token = grant();
    const ceremony = await options(browser, '/register/options', { token });
    browser.cookies.set('__Host-hearth_session', token);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    vi.mocked(Date.now).mockReturnValue((timestamp + 300) * 1000);
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: key.register(ceremony.options.challenge) })).status).toBe(401);
    vi.mocked(Date.now).mockReturnValue((timestamp + 86400) * 1000);
    expect((await browser.request('/register/options', { token })).status).toBe(401);
  });
});

describe('fresh verification, administration and revocation races', () => {
  it('accepts omitted reauthentication handles only for the same credential owner and session', async () => {
    const { browser, key, handle } = await active();
    const other = await active('sam', 'member');
    for (const userHandle of [undefined, null]) {
      const ceremony = await options(browser, '/reauth/options');
      const response = key.assertion(ceremony.options.challenge, handle);
      expect((await browser.request('/reauth/verify', { ceremonyId: ceremony.ceremonyId, response: { ...response, response: { ...response.response, userHandle } } })).status).toBe(200);
    }
    const wrongAccount = await options(browser, '/reauth/options');
    const otherResponse = other.key.assertion(wrongAccount.options.challenge, other.handle);
    expect((await browser.request('/reauth/verify', { ceremonyId: wrongAccount.ceremonyId, response: { ...otherResponse, response: { ...otherResponse.response, userHandle: null } } })).status).toBe(401);
    const wrongHandle = key.assertion(wrongAccount.options.challenge, other.handle);
    expect((await browser.request('/reauth/verify', { ceremonyId: wrongAccount.ceremonyId, response: wrongHandle })).status).toBe(401);
    const loginCeremony = await options(browser, '/login/options');
    const loginResponse = key.assertion(loginCeremony.options.challenge, handle);
    for (const userHandle of [undefined, null]) {
      expect((await browser.request('/login/verify', { ceremonyId: loginCeremony.ceremonyId, response: { ...loginResponse, response: { ...loginResponse.response, userHandle } } })).status).toBe(401);
    }
  });
  it('binds reauthentication to the same member and session and permits fresh credential addition', async () => {
    const { browser, key, handle } = await active();
    const other = new Browser(); await login(other, key, handle);
    vi.mocked(Date.now).mockReturnValue((timestamp + 301) * 1000);
    expect((await browser.request('/register/options', {})).status).toBe(403);
    const ceremony = await options(browser, '/reauth/options');
    other.cookies.set('__Host-hearth_ceremony', browser.cookies.get('__Host-hearth_ceremony')!);
    const payload = { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) };
    expect((await other.request('/reauth/verify', payload)).status).toBe(401);
    expect((await browser.request('/reauth/verify', payload)).status).toBe(200);
    const nextKey = authenticator();
    const registration = await options(browser, '/register/options');
    expect((await browser.request('/register/verify', { ceremonyId: registration.ceremonyId, response: nextKey.register(registration.options.challenge) })).status).toBe(200);
    expect((await browser.request('/credentials/revoke', { id: nextKey.id })).status).toBe(200);
    expect((await browser.request('/credentials/revoke', { id: key.id })).status).toBe(409);
  });
  it('rolls back assertion/session issuance if the credential is revoked after cryptographic verification', async () => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/login/options');
    beforeBatch = sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined;
        sqlite.prepare('UPDATE auth_credentials SET revoked_at=? WHERE id=?').run(timestamp, key.id);
      }
    };
    expect((await browser.request('/login/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) })).status).toBe(409);
    expect(sqlite.prepare('SELECT consumed_at FROM auth_challenges WHERE id=?').get(ceremony.ceremonyId)!.consumed_at).toBe(null);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n).toBe(1);
  });
  it('rolls back enrollment if its grant is revoked immediately before the write transaction', async () => {
    const browser = new Browser(); const key = authenticator(); member(); const token = grant();
    const ceremony = await options(browser, '/register/options', { token });
    beforeBatch = sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined; sqlite.prepare('UPDATE auth_enrollment_grants SET revoked_at=?').run(timestamp);
      }
    };
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: key.register(ceremony.options.challenge) })).status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credentials').get()!.n).toBe(0);
    expect(sqlite.prepare('SELECT status FROM auth_members').get()!.status).toBe('pending');
  });
  it('does not revive a session revoked between reauthentication verification and commit', async () => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/reauth/options');
    beforeBatch = sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined; sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(timestamp);
      }
    };
    expect((await browser.request('/reauth/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) })).status).toBe(409);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('cannot remove both of the last two credentials through concurrent revocations', async () => {
    const { browser, key } = await active(); const extra = authenticator();
    const ceremony = await options(browser, '/register/options');
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: extra.register(ceremony.options.challenge) })).status).toBe(200);
    const responses = await Promise.all([browser.request('/credentials/revoke', { id: extra.id }), browser.request('/credentials/revoke', { id: key.id })]);
    expect(responses.filter(result => result.status === 200)).toHaveLength(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credentials WHERE revoked_at IS NULL').get()!.n).toBe(1);
  });
  it('cannot suspend both administrators through concurrent administrative changes', async () => {
    const first = await active(); const second = await active('sam', 'admin');
    const responses = await Promise.all([first.browser.request('/members/sam/suspend', {}), second.browser.request('/members/alex/suspend', {})]);
    expect(responses.filter(result => result.status === 200)).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_members WHERE status='active' AND role='admin'").get()!.n).toBe(1);
  });
  it('requires an administrator, protects the final administrator, and preserves identity during recovery', async () => {
    const admin = await active(); const ordinary = await active('sam', 'member');
    expect((await ordinary.browser.request('/members')).status).toBe(403);
    expect((await admin.browser.request('/members/alex/suspend', {})).status).toBe(409);
    expect((await admin.browser.request('/members/alex/recover', {})).status).toBe(409);
    const oldId = ordinary.key.id;
    const pending = await options(ordinary.browser, '/reauth/options');
    const recovery = await admin.browser.request('/members/sam/recover', {});
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    const token = (await recovery.json() as { token: string }).token;
    expect(sqlite.prepare("SELECT status,user_handle FROM auth_members WHERE id='sam'").get()).toEqual({ status: 'pending', user_handle: ordinary.handle });
    expect(sqlite.prepare('SELECT id FROM auth_credentials WHERE id=?').get(oldId)).toBeUndefined();
    expect(sqlite.prepare('SELECT member_id,retired_at FROM auth_credential_tombstones WHERE id_hash=?').get(b64(digest(oldId)))).toEqual({ member_id: 'sam', retired_at: timestamp });
    await expect(ordinary.browser.identity()).rejects.toMatchObject({ status: 401 });
    expect(sqlite.prepare('SELECT id FROM auth_challenges WHERE id=?').get(pending.ceremonyId)).toBeUndefined();
    const newKey = authenticator(); const recovered = new Browser();
    await enroll(recovered, newKey, token); await login(recovered, newKey, ordinary.handle);
    expect((await recovered.identity()).id).toBe('sam');
    expect(sqlite.prepare("SELECT event FROM auth_audit WHERE event='member.recovery_authorized'").all()).toHaveLength(1);
  });
  it('recovers a 100-credential history with a new passkey while permanently blocking retired IDs', async () => {
    const admin = await active(); const ordinary = await active('sam', 'member');
    for (let index = 0; index < 99; index++) sqlite.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at,revoked_at) VALUES (?,'sam','cHVibGlj',0,0,?,?)").run(`retired_${index}`, timestamp, timestamp);
    sqlite.prepare("INSERT INTO records(id,kind,owner_id,data,created_at,updated_at) VALUES ('preserve','note','sam','{\"text\":\"Keep this history\"}','before','before')").run();
    const before = sqlite.prepare('SELECT * FROM records').all();
    const budget = sqlite.prepare('SELECT * FROM family_storage').get();
    expect((await admin.browser.request('/members/sam/suspend', {})).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_credentials WHERE member_id='sam'").get()!.n).toBe(100);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credential_tombstones').get()!.n).toBe(0);
    const recovery = await admin.browser.request('/members/sam/recover', {});
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    const token = (await recovery.json() as { token: string }).token;
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_credentials WHERE member_id='sam'").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_credential_tombstones WHERE member_id='sam'").get()!.n).toBe(100);
    expect(sqlite.prepare('SELECT member_id,retired_at FROM auth_credential_tombstones WHERE id_hash=?').get(b64(digest(ordinary.key.id)))).toEqual({ member_id: 'sam', retired_at: timestamp });
    expect(sqlite.prepare("SELECT user_handle FROM auth_members WHERE id='sam'").get()!.user_handle).toBe(ordinary.handle);
    const recovered = new Browser();
    const oldRegistration = await options(recovered, '/register/options', { token });
    expect((await recovered.request('/register/verify', { ceremonyId: oldRegistration.ceremonyId, response: ordinary.key.register(oldRegistration.options.challenge, { attestation: 'packed' }) })).status).toBe(409);
    expect(sqlite.prepare('SELECT consumed_at FROM auth_enrollment_grants WHERE token_hash=?').get(b64(digest(token)))!.consumed_at).toBe(null);
    const newKey = authenticator();
    await enroll(recovered, newKey, token); await login(recovered, newKey, ordinary.handle);
    expect((await recovered.identity()).id).toBe('sam');
    const oldAssertion = await options(recovered, '/login/options');
    expect((await recovered.request('/login/verify', { ceremonyId: oldAssertion.ceremonyId, response: ordinary.key.assertion(oldAssertion.options.challenge, ordinary.handle) })).status).toBe(401);
    member('new_person', 'member'); const otherToken = grant('new_person');
    const otherBrowser = new Browser(); const otherCeremony = await options(otherBrowser, '/register/options', { token: otherToken });
    expect((await otherBrowser.request('/register/verify', { ceremonyId: otherCeremony.ceremonyId, response: ordinary.key.register(otherCeremony.options.challenge, { attestation: 'packed' }) })).status).toBe(409);
    expect(sqlite.prepare('SELECT * FROM records').all()).toEqual(before);
    expect(sqlite.prepare('SELECT * FROM family_storage').get()).toEqual(budget);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rolls back registration when its credential ID is retired after verification but before commit', async () => {
    const browser = new Browser(); const key = authenticator(); member(); const token = grant();
    const ceremony = await options(browser, '/register/options', { token });
    beforeBatch = sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined;
        sqlite.prepare("INSERT INTO auth_credential_tombstones(id_hash,member_id,retired_at) VALUES (?,'alex',?)").run(b64(digest(key.id)), timestamp);
      }
    };
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: key.register(ceremony.options.challenge) })).status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credentials').get()!.n).toBe(0);
    expect(sqlite.prepare('SELECT status FROM auth_members').get()!.status).toBe('pending');
    expect(sqlite.prepare('SELECT consumed_at FROM auth_enrollment_grants').get()!.consumed_at).toBe(null);
    expect(sqlite.prepare('SELECT consumed_at FROM auth_challenges WHERE id=?').get(ceremony.ceremonyId)!.consumed_at).toBe(null);
  });
  it('does not delete a credential added concurrently with recovery snapshot hashing', async () => {
    const admin = await active(); const ordinary = await active('sam', 'member');
    beforeBatch = sql => {
      if (sql.some(text => text.startsWith('INSERT OR IGNORE INTO auth_credential_tombstones'))) {
        beforeBatch = undefined;
        sqlite.prepare("INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at) VALUES ('new_concurrent','sam','cHVibGlj',0,0,?)").run(timestamp);
      }
    };
    expect((await admin.browser.request('/members/sam/recover', {})).status).toBe(409);
    expect(sqlite.prepare("SELECT count(*) AS n FROM auth_credentials WHERE member_id='sam' AND revoked_at IS NULL").get()!.n).toBe(2);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_credential_tombstones').get()!.n).toBe(0);
    expect((await ordinary.browser.identity()).id).toBe('sam');
  });
  it('creates an email-free pending invitation, revokes it, and rejects reuse of historical owners', async () => {
    const { browser } = await active();
    const result = await browser.request('/members', { id: 'new_member', name: 'New member', role: 'member', color: '#554433' });
    expect(result.status).toBe(200);
    const token = (await result.json() as { token: string }).token;
    expect(sqlite.prepare("SELECT status FROM auth_members WHERE id='new_member'").get()!.status).toBe('pending');
    const newcomer = new Browser(); await options(newcomer, '/register/options', { token });
    expect((await browser.request('/invitations/revoke', { memberId: 'new_member' })).status).toBe(200);
    expect((await newcomer.request('/register/options', { token })).status).toBe(401);
    sqlite.prepare("INSERT INTO records(id,kind,owner_id,data,created_at,updated_at) VALUES ('history','note','departed','{}','before','before')").run();
    expect((await browser.request('/members', { id: 'departed', name: 'Different person', role: 'member', color: '#554433' })).status).toBe(409);
    expect((await browser.request('/members', { id: 'bad', name: 'Bad', role: 'owner', color: '#554433' })).status).toBe(400);
  });
  it('revokes all sessions and rejects duplicate cookie ambiguity', async () => {
    const { browser, key, handle } = await active(); const other = new Browser(); await login(other, key, handle);
    await expect(authenticatePasskey(new Request(`${origin}/api/bootstrap`, { headers: { Cookie: `${browser.cookieHeader()}; ${browser.cookieHeader()}` } }), env)).rejects.toMatchObject({ status: 401 });
    expect((await browser.request('/sessions/revoke', {})).status).toBe(200);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    await expect(other.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a verified login when logout commits before its issuance transaction', async () => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/login/options');
    const browserBinding = browser.cookies.get('__Host-hearth_ceremony');
    beforeBatch = async sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined;
        expect((await browser.request('/logout', {})).status).toBe(200);
      }
    };
    expect((await browser.request('/login/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) })).status).toBe(409);
    expect(browser.cookies.get('__Host-hearth_ceremony')).toBe(browserBinding);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()!.n).toBe(0);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('invalidates anonymous login assertions before revoke-all commits', async () => {
    const { browser, key, handle } = await active();
    const incoming = new Browser();
    const ceremony = await options(incoming, '/login/options');
    beforeBatch = async sql => {
      if (sql.some(text => text.startsWith('UPDATE auth_challenges SET consumed_at'))) {
        beforeBatch = undefined;
        expect((await browser.request('/sessions/revoke', {})).status).toBe(200);
      }
    };
    expect((await incoming.request('/login/verify', { ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) })).status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()!.n).toBe(0);
    await expect(incoming.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('revoke-all rejects a cookie from an already committed but delayed login response', async () => {
    const { browser, key, handle } = await active();
    const incoming = new Browser();
    const ceremony = await options(incoming, '/login/options');
    const pendingResponse = await passkeyRoutes.request(`${origin}/login/verify`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: incoming.cookieHeader() },
      body: JSON.stringify({ ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) }),
    }, env);
    expect(pendingResponse.status).toBe(200);
    const delayedCookie = pendingResponse.headers.getSetCookie().find(value => value.startsWith('__Host-hearth_session='))!.split(';', 1)[0].split('=')[1];
    expect((await browser.request('/sessions/revoke', {})).status).toBe(200);
    incoming.cookies.set('__Host-hearth_session', delayedCookie);
    await expect(incoming.identity()).rejects.toMatchObject({ status: 401 });
  });
  it('revokes a committed login whose new cookie arrives after logout with a stale session cookie', async () => {
    const { browser, key, handle } = await active();
    const ceremony = await options(browser, '/login/options');
    // Call the route directly to hold back its Set-Cookie from the browser jar.
    const pendingResponse = await passkeyRoutes.request(`${origin}/login/verify`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: browser.cookieHeader() },
      body: JSON.stringify({ ceremonyId: ceremony.ceremonyId, response: key.assertion(ceremony.options.challenge, handle) }),
    }, env);
    expect(pendingResponse.status).toBe(200);
    const delayedCookie = pendingResponse.headers.getSetCookie().find(value => value.startsWith('__Host-hearth_session='))!.split(';', 1)[0].split('=')[1];
    expect(delayedCookie).not.toBe(browser.cookies.get('__Host-hearth_session'));
    expect((await browser.request('/logout', {})).status).toBe(200);
    browser.cookies.set('__Host-hearth_session', delayedCookie);
    await expect(browser.identity()).rejects.toMatchObject({ status: 401 });
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()!.n).toBe(0);
    // A deliberate new assertion after logout remains possible with the stable binding.
    await login(browser, key, handle);
    expect((await browser.identity()).id).toBe('alex');
  });
  it('logs out an additive legacy session with a null browser binding', async () => {
    const { browser } = await active();
    sqlite.prepare('UPDATE auth_sessions SET browser_hash=NULL').run();
    browser.cookies.delete('__Host-hearth_ceremony');
    expect((await browser.request('/logout', {})).status).toBe(200);
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions').get()!.revoked_at).toBe(timestamp);
  });
});

describe('member rename and recolour', () => {
  it('allows an administrator to rename and recolour any member with fresh verification', async () => {
    const admin = await active(); member('sam', 'member'); const token = grant('sam'); const samKey = authenticator(); const samBrowser = new Browser();
    await enroll(samBrowser, samKey, token); await login(samBrowser, samKey, sqlite.prepare("SELECT user_handle FROM auth_members WHERE id='sam'").get()!.user_handle as string);
    const result = await admin.browser.request('/members/sam/update', { name: 'Samira', color: '#5B6FA6' });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(sqlite.prepare("SELECT name,color FROM auth_members WHERE id='sam'").get()).toEqual({ name: 'Samira', color: '#5B6FA6' });
    expect(sqlite.prepare("SELECT event FROM auth_audit WHERE target_id='sam' AND event='member.updated'").all()).toHaveLength(1);
    expect(sqlite.prepare('SELECT * FROM auth_transaction_guards').all()).toEqual([]);
  });
  it('allows a member to rename and recolour themselves', async () => {
    const ordinary = await active('sam', 'member');
    const result = await ordinary.browser.request('/members/sam/update', { name: 'Samira', color: '#5B6FA6' });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(sqlite.prepare("SELECT name,color FROM auth_members WHERE id='sam'").get()).toEqual({ name: 'Samira', color: '#5B6FA6' });
  });
  it('rejects a non-administrator updating another member', async () => {
    const ordinary = await active('sam', 'member'); member('alex', 'admin'); const token = grant('alex'); const adminKey = authenticator(); const adminBrowser = new Browser();
    await enroll(adminBrowser, adminKey, token); await login(adminBrowser, adminKey, sqlite.prepare("SELECT user_handle FROM auth_members WHERE id='alex'").get()!.user_handle as string);
    expect((await ordinary.browser.request('/members/alex/update', { name: 'Alexia' })).status).toBe(403);
    expect(sqlite.prepare("SELECT name FROM auth_members WHERE id='alex'").get()!.name).toBe('alex');
  });
  it('requires at least one field to change', async () => {
    const admin = await active();
    expect((await admin.browser.request('/members/alex/update', {})).status).toBe(400);
  });
  it('rejects an unknown member', async () => {
    const admin = await active();
    expect((await admin.browser.request('/members/nobody/update', { name: 'Ghost' })).status).toBe(409);
  });
  it('requires fresh passkey verification', async () => {
    const admin = await active();
    sqlite.prepare('UPDATE auth_sessions SET reauthenticated_at=NULL').run();
    expect((await admin.browser.request('/members/alex/update', { name: 'Alex New' })).status).toBe(403);
  });
  it('accepts name-only or color-only updates', async () => {
    const admin = await active();
    expect((await admin.browser.request('/members/alex/update', { name: 'Alexander' })).status).toBe(200);
    expect(sqlite.prepare("SELECT name,color FROM auth_members WHERE id='alex'").get()).toEqual({ name: 'Alexander', color: '#38634A' });
    expect((await admin.browser.request('/members/alex/update', { color: '#A96743' })).status).toBe(200);
    expect(sqlite.prepare("SELECT name,color FROM auth_members WHERE id='alex'").get()).toEqual({ name: 'Alexander', color: '#A96743' });
  });
  it('allows an administrator to rename and recolour a suspended member', async () => {
    const admin = await active();
    member('sam', 'member', 'suspended');
    const result = await admin.browser.request('/members/sam/update', { name: 'Samantha', color: '#557461' });
    expect(result.status, await result.clone().text()).toBe(200);
    // Status remains suspended; only name and colour change.
    expect(sqlite.prepare("SELECT name,color,status FROM auth_members WHERE id='sam'").get()).toEqual({ name: 'Samantha', color: '#557461', status: 'suspended' });
    expect(sqlite.prepare("SELECT event FROM auth_audit WHERE target_id='sam' AND event='member.updated'").all()).toHaveLength(1);
  });
});

describe('credential rename', () => {
  it('allows a member to rename their own credential with fresh verification', async () => {
    const { browser } = await active();
    const result = await browser.request('/credentials/rename', { id: sqlite.prepare('SELECT id FROM auth_credentials').get()!.id as string, name: 'My MacBook' });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(sqlite.prepare('SELECT name FROM auth_credentials').get()!.name).toBe('My MacBook');
    expect(sqlite.prepare("SELECT event FROM auth_audit WHERE event='credential.renamed'").all()).toHaveLength(1);
    expect(sqlite.prepare('SELECT * FROM auth_transaction_guards').all()).toEqual([]);
  });
  it('rejects renaming another member’s credential', async () => {
    const admin = await active(); member('sam', 'member'); const samToken = grant('sam'); const samKey = authenticator(); const samBrowser = new Browser();
    await enroll(samBrowser, samKey, samToken); await login(samBrowser, samKey, sqlite.prepare("SELECT user_handle FROM auth_members WHERE id='sam'").get()!.user_handle as string);
    const samCredId = sqlite.prepare("SELECT id FROM auth_credentials WHERE member_id='sam'").get()!.id as string;
    expect((await admin.browser.request('/credentials/rename', { id: samCredId, name: 'Stolen Name' })).status).toBe(409);
    expect(sqlite.prepare("SELECT name FROM auth_credentials WHERE id=?").get(samCredId)!.name).toBe('My device');
  });
  it('requires fresh passkey verification', async () => {
    const { browser } = await active();
    sqlite.prepare('UPDATE auth_sessions SET reauthenticated_at=NULL').run();
    expect((await browser.request('/credentials/rename', { id: sqlite.prepare('SELECT id FROM auth_credentials').get()!.id as string, name: 'Should Fail' })).status).toBe(403);
  });
  it('rejects an unknown or revoked credential id', async () => {
    const { browser } = await active();
    expect((await browser.request('/credentials/rename', { id: 'nonexistent123456789012345678901234567890123', name: 'Ghost' })).status).toBe(409);
  });
  it('rejects renaming an own revoked credential', async () => {
    const { browser, key } = await active();
    // Register a second credential so the session stays valid after revoking the first.
    const extraKey = authenticator();
    const ceremony = await options(browser, '/register/options');
    expect((await browser.request('/register/verify', { ceremonyId: ceremony.ceremonyId, response: extraKey.register(ceremony.options.challenge) })).status).toBe(200);
    const extraId = sqlite.prepare('SELECT id FROM auth_credentials WHERE id<>?').get(key.id)!.id as string;
    // Revoke the extra credential via the API while the session (tied to key.id) stays live.
    expect((await browser.request('/credentials/revoke', { id: extraId })).status).toBe(200);
    expect(sqlite.prepare('SELECT revoked_at FROM auth_credentials WHERE id=?').get(extraId)!.revoked_at).not.toBeNull();
    // Attempting to rename the now-revoked credential must be rejected.
    const rename = await browser.request('/credentials/rename', { id: extraId, name: 'Should Not Stick' });
    expect(rename.status).toBe(409);
    expect(sqlite.prepare('SELECT name FROM auth_credentials WHERE id=?').get(extraId)!.name).toBe('Passkey');
  });
});

describe('canonical deployment, CSRF and resource bounds', () => {
  it('adds browser bindings without rewriting sessions in an already-applied runtime database', () => {
    const legacy = new DatabaseSync(':memory:');
    try {
      legacy.exec('PRAGMA foreign_keys=ON');
      const dir = new URL('../migrations/', import.meta.url);
      for (const name of readdirSync(dir).filter(name => /^000[1-4]_.*\.sql$/.test(name)).sort()) legacy.exec(readFileSync(new URL(name, dir), 'utf8'));
      legacy.prepare("INSERT INTO auth_members(id,name,role,color,status,user_handle,created_at,updated_at) VALUES ('alex','Alex','admin','#38634A','active',?,?,?)").run('A'.repeat(43), timestamp, timestamp);
      legacy.prepare("INSERT INTO auth_credentials(id,member_id,public_key,counter,backup_eligible,backed_up,created_at) VALUES ('credential','alex','cHVibGlj',0,0,0,?)").run(timestamp);
      legacy.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_id,created_at,last_seen_at,expires_at) VALUES (?,'alex','credential',?,?,?)").run('S'.repeat(43), timestamp, timestamp, timestamp + 3600);
      const before = legacy.prepare('SELECT * FROM auth_sessions').get();
      legacy.exec(readFileSync(new URL('0005_passkey_browser_sessions.sql', dir), 'utf8'));
      expect(legacy.prepare('SELECT * FROM auth_sessions').get()).toEqual({ ...before, browser_hash: null });
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => legacy.prepare('UPDATE auth_sessions SET browser_hash=?').run('invalid')).toThrow(/CHECK/);
    } finally { legacy.close(); }
  });
  it('fails closed for alternate origins, broad RP IDs, nonlocal HTTP and absent explicit configuration', () => {
    for (const config of [{ APP_ORIGIN: undefined }, { WEBAUTHN_RP_ID: undefined }, { APP_ORIGIN: 'http://hearth.example' }, { WEBAUTHN_RP_ID: 'example' }, { APP_ORIGIN: `${origin}/` }]) expect(() => readPasskeyConfig({ ...env, ...config }, `${origin}/login`)).toThrow();
    expect(() => readPasskeyConfig(env, 'https://preview.example/login')).toThrow();
    expect(readPasskeyConfig({ ...env, APP_ORIGIN: 'http://localhost:5173', WEBAUTHN_RP_ID: 'localhost' }, 'http://localhost:5173/login')).toEqual({ origin: 'http://localhost:5173', rpID: 'localhost' });
  });
  it('rejects cross-site/missing-origin mutations, non-JSON data and unknown fields before state changes', async () => {
    const browser = new Browser();
    for (const headers of [{ Origin: '' }, { Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) expect((await browser.request('/login/options', {}, headers)).status).toBe(403);
    expect((await browser.request('/login/options', {}, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await browser.request('/login/options', { memberId: 'alex' })).status).toBe(400);
    expect((await browser.request('/login/options', { data: 'a'.repeat(70000) })).status).toBe(413);
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_challenges').get()!.n).toBe(0);
  });
  it('bounds per-browser challenges and global unauthenticated traffic with no IP header', async () => {
    const browser = new Browser();
    for (let i = 0; i < 5; i++) expect((await browser.request('/login/options', {})).status).toBe(200);
    expect((await browser.request('/login/options', {})).status).toBe(409);
    for (let i = 6; i < 30; i++) await new Browser().request('/login/options', {});
    const limited = await new Browser().request('/login/options', {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store, private');
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_challenges').get()!.n).toBeLessThanOrEqual(30);
  });
});
