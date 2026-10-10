import { Hono, type Context } from 'hono';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import type { InternalMember, MemberIdentity } from '../shared/members';
import { ApiError } from './env';

export type PasskeyEnv = { DB: D1Database; APP_ORIGIN?: string; WEBAUTHN_RP_ID?: string };
type Config = { origin: string; rpID: string };
type RouteEnv = { Bindings: PasskeyEnv; Variables: { passkeyConfig: Config } };
type Ctx = Context<RouteEnv>;
type Session = MemberIdentity & { token_hash: string; credential_id: string; reauthenticated_at: number | null; user_handle: string };
type Challenge = { id: string; challenge: string; browser_hash: string; purpose: string; member_id: string | null; grant_hash: string | null; session_hash: string | null; origin: string; rp_id: string };
type Credential = { id: string; member_id: string; public_key: string; counter: number; transports: string; backup_eligible: number; user_handle: string };
const SESSION_COOKIE = '__Host-hearth_session';
const BROWSER_COOKIE = '__Host-hearth_ceremony';
const CHALLENGE_TTL = 300;
const GRANT_TTL = 86400;
const SESSION_TTL = 2592000;
const IDLE_TTL = 604800;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value: string) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const now = () => Math.floor(Date.now() / 1000);
const fail = () => new ApiError(401, 'The passkey request could not be verified. Start again.');
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const credentialId = z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/);
const displayName = z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const keyName = z.string().trim().min(1).max(64).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const responseSchema = z.object({ id: credentialId, rawId: credentialId, type: z.literal('public-key'), response: z.record(z.string(), z.unknown()), clientExtensionResults: z.record(z.string(), z.unknown()) }).passthrough();
const verificationSchema = z.object({ ceremonyId: tokenSchema, response: responseSchema }).strict();

export function readPasskeyConfig(env: PasskeyEnv, requestUrl: string): Config {
  try {
    if (!env.APP_ORIGIN || !env.WEBAUTHN_RP_ID) throw new Error();
    const configured = new URL(env.APP_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname);
    if (configured.origin !== env.APP_ORIGIN || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash || (configured.protocol !== 'https:' && !(local && configured.protocol === 'http:'))) throw new Error();
    if (env.WEBAUTHN_RP_ID !== configured.hostname || new URL(requestUrl).origin !== configured.origin) throw new Error();
    return { origin: configured.origin, rpID: configured.hostname };
  } catch { throw new ApiError(503, 'Family passkey access is not configured for this address.'); }
}

function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return tokenSchema.safeParse(value).success ? value : null;
}
function setCookie(c: Ctx, name: string, value: string, ttl: number) {
  c.header('Set-Cookie', `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ttl}`, { append: true });
}
function stmt(db: D1Database, sql: string, ...bindings: (string | number | null)[]) { return db.prepare(sql).bind(...bindings); }
function guard(db: D1Database, id: string, condition: string, bindings: (string | number | null)[] = []) {
  return stmt(db, `INSERT INTO auth_transaction_guards (id, allowed) VALUES (?, CASE WHEN (${condition}) THEN 1 ELSE 0 END)`, id, ...bindings);
}
async function atomic(db: D1Database, statements: D1PreparedStatement[], guardIds: string[]) {
  try {
    await db.batch([...statements, ...guardIds.map(id => stmt(db, 'DELETE FROM auth_transaction_guards WHERE id = ?', id))]);
  } catch { throw new ApiError(409, 'This operation is no longer available. Start again.'); }
}
function audit(db: D1Database, actor: string | null, target: string | null, event: string, timestamp: number) {
  return stmt(db, 'INSERT INTO auth_audit (id,actor_id,target_id,event,created_at) VALUES (?,?,?,?,?)', random(), actor, target, event, timestamp);
}
const validSessionSQL = `SELECT 1 FROM auth_sessions s JOIN auth_members m ON m.id=s.member_id JOIN auth_credentials k ON k.id=s.credential_id AND k.member_id=m.id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at>? AND m.status='active' AND k.revoked_at IS NULL`;
function sessionGuard(db: D1Database, id: string, session: Session, timestamp: number, admin = false, fresh = true) {
  return guard(db, id, `EXISTS (${validSessionSQL}${fresh ? ' AND s.reauthenticated_at>=?' : ''}${admin ? " AND m.role='admin'" : ''})`, [session.token_hash, timestamp, timestamp - IDLE_TTL, ...(fresh ? [timestamp - CHALLENGE_TTL] : [])]);
}
async function sessionFor(request: Request, env: PasskeyEnv, fresh = false, admin = false): Promise<Session> {
  readPasskeyConfig(env, request.url);
  const token = cookie(request, SESSION_COOKIE);
  if (!token) throw new ApiError(401, 'Sign in with a family passkey.');
  const timestamp = now();
  const tokenHash = await hash(token);
  const session = await stmt(env.DB, `SELECT m.id,m.name,m.role,m.color,m.user_handle,s.token_hash,s.credential_id,s.reauthenticated_at FROM auth_sessions s JOIN auth_members m ON m.id=s.member_id JOIN auth_credentials k ON k.id=s.credential_id AND k.member_id=m.id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at>? AND m.status='active' AND k.revoked_at IS NULL`, tokenHash, timestamp, timestamp - IDLE_TTL).first<Session>();
  if (!session) throw new ApiError(401, 'Your session has ended. Sign in with a passkey.');
  if (admin && session.role !== 'admin') throw new ApiError(403, 'An administrator is required.');
  if (fresh && (session.reauthenticated_at === null || session.reauthenticated_at < timestamp - CHALLENGE_TTL)) throw new ApiError(403, 'Verify your passkey again to continue.');
  return session;
}
export async function authenticatePasskey(request: Request, env: PasskeyEnv): Promise<MemberIdentity> {
  const session = await sessionFor(request, env);
  const timestamp = now();
  const updated = await stmt(env.DB, `UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=? AND EXISTS (${validSessionSQL} AND m.role=?) RETURNING member_id`, timestamp, session.token_hash, session.token_hash, timestamp, timestamp - IDLE_TTL, session.role).first();
  if (!updated) throw new ApiError(401, 'Your session has ended. Sign in with a passkey.');
  const { id, name, role, color } = session;
  return { id, name, role, color };
}
export async function readPasskeyMembers(db: D1Database): Promise<MemberIdentity[]> {
  return (await stmt(db, "SELECT id,name,role,color FROM auth_members WHERE status='active' ORDER BY created_at,id").all<MemberIdentity>()).results;
}
async function body<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  if (!reader) throw new ApiError(400, 'Send a JSON request.');
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 65536) { await reader.cancel(); throw new ApiError(413, 'The request is too large.'); }
    chunks.push(chunk.value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))); }
  catch { throw new ApiError(400, 'The request is invalid.'); }
}
async function cleanAndRateLimit(c: Ctx) {
  const db = c.env.DB;
  const timestamp = now();
  await db.batch([
    stmt(db, 'DELETE FROM auth_challenges WHERE expires_at<=? OR consumed_at IS NOT NULL OR session_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<=? OR last_seen_at<=? OR revoked_at IS NOT NULL) OR grant_hash IN (SELECT token_hash FROM auth_enrollment_grants WHERE expires_at<=? OR consumed_at IS NOT NULL OR revoked_at IS NOT NULL)', timestamp, timestamp, timestamp - IDLE_TTL, timestamp),
    stmt(db, 'DELETE FROM auth_enrollment_grants WHERE expires_at<=? OR consumed_at IS NOT NULL OR revoked_at IS NOT NULL', timestamp),
    stmt(db, 'DELETE FROM auth_sessions WHERE expires_at<=? OR last_seen_at<=? OR revoked_at IS NOT NULL', timestamp, timestamp - IDLE_TTL),
    stmt(db, 'DELETE FROM auth_rate_windows WHERE window_start<?', timestamp - 120),
    stmt(db, 'DELETE FROM auth_audit WHERE created_at<? OR id IN (SELECT id FROM auth_audit ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 999)', timestamp - 90 * 86400),
  ]);
  const window = Math.floor(timestamp / 60) * 60;
  const bump = (key: string) => stmt(db, `INSERT INTO auth_rate_windows(key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=CASE WHEN auth_rate_windows.window_start=excluded.window_start THEN min(auth_rate_windows.count+1,10000) ELSE 1 END RETURNING count`, key, window).first<{ count: number }>();
  if ((await bump('global'))!.count > 120) throw new ApiError(429, 'Too many requests. Wait a minute and try again.');
  const ip = c.req.header('CF-Connecting-IP');
  const trusted = ip && ip.length <= 45 && /^[a-fA-F0-9:.]+$/.test(ip);
  if ((await bump(trusted ? `ip:${await hash(ip)}` : 'unknown'))!.count > 30) throw new ApiError(429, 'Too many requests. Wait a minute and try again.');
}

export const passkeyRoutes = new Hono<RouteEnv>();
passkeyRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private'); c.header('Vary', 'Cookie'); c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  const config = readPasskeyConfig(c.env, c.req.url);
  c.set('passkeyConfig', config);
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    if (c.req.header('Origin') !== config.origin || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'This request came from an unrecognized origin.');
    if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new ApiError(400, 'Send changes as application/json.');
  }
  await cleanAndRateLimit(c);
  await next();
});
passkeyRoutes.onError((error, c) => {
  c.header('Cache-Control', 'no-store, private'); c.header('Vary', 'Cookie');
  if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
  return c.json({ error: 'Passkey access is temporarily unavailable.' }, 503);
});

async function issueChallenge(c: Ctx, purpose: Challenge['purpose'], challenge: string, member: string | null = null, grantHash: string | null = null, session: Session | null = null) {
  const db = c.env.DB;
  const browser = cookie(c.req.raw, BROWSER_COOKIE) || random();
  const browserHash = await hash(browser);
  const timestamp = now();
  const id = random();
  const check = random();
  const config = c.get('passkeyConfig');
  const statements = [guard(db, check, '(SELECT count(*) FROM auth_challenges)<1000 AND (SELECT count(*) FROM auth_challenges WHERE browser_hash=? AND consumed_at IS NULL AND expires_at>?)<5', [browserHash, timestamp])];
  const checks = [check];
  if (session) { const sid = random(); checks.push(sid); statements.push(sessionGuard(db, sid, session, timestamp, false, purpose === 'registration')); }
  if (grantHash) {
    const gid = random(); checks.push(gid);
    statements.push(guard(db, gid, "EXISTS (SELECT 1 FROM auth_enrollment_grants g JOIN auth_members m ON m.id=g.member_id WHERE g.token_hash=? AND g.member_id=? AND g.expires_at>? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND m.status='pending')", [grantHash, member, timestamp]));
  }
  statements.push(stmt(db, 'INSERT INTO auth_challenges(id,challenge,browser_hash,purpose,member_id,grant_hash,session_hash,origin,rp_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, challenge, browserHash, purpose, member, grantHash, session?.token_hash || null, config.origin, config.rpID, timestamp, timestamp + CHALLENGE_TTL));
  await atomic(db, statements, checks);
  // Keep the browser binding through logout and delayed login responses. Individual
  // challenges still expire after five minutes; this cookie authenticates nothing.
  setCookie(c, BROWSER_COOKIE, browser, SESSION_TTL);
  return id;
}
async function findChallenge(c: Ctx, id: string, purpose: string): Promise<Challenge> {
  const browser = cookie(c.req.raw, BROWSER_COOKIE);
  if (!browser) throw fail();
  const config = c.get('passkeyConfig');
  const row = await stmt(c.env.DB, 'SELECT id,challenge,browser_hash,purpose,member_id,grant_hash,session_hash,origin,rp_id FROM auth_challenges WHERE id=? AND browser_hash=? AND purpose=? AND origin=? AND rp_id=? AND consumed_at IS NULL AND expires_at>?', id, await hash(browser), purpose, config.origin, config.rpID, now()).first<Challenge>();
  if (!row) throw fail();
  return row;
}
function consumeChallenge(db: D1Database, challenge: Challenge, timestamp: number, check: string): D1PreparedStatement[] {
  return [stmt(db, 'UPDATE auth_challenges SET consumed_at=? WHERE id=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>?', timestamp, challenge.id, challenge.browser_hash, timestamp), guard(db, check, 'changes()=1')];
}
function checkClientData(encoded: unknown) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 8192) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(bytes(encoded)));
    if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new Error();
  } catch { throw fail(); }
}

passkeyRoutes.post('/login/options', async c => {
  await body(c, z.object({}).strict());
  const options = await generateAuthenticationOptions({ rpID: c.get('passkeyConfig').rpID, userVerification: 'required', timeout: CHALLENGE_TTL * 1000 });
  return c.json({ ceremonyId: await issueChallenge(c, 'authentication', options.challenge), options });
});
passkeyRoutes.post('/reauth/options', async c => {
  await body(c, z.object({}).strict());
  const session = await sessionFor(c.req.raw, c.env);
  const credentials = (await stmt(c.env.DB, 'SELECT id FROM auth_credentials WHERE member_id=? AND revoked_at IS NULL', session.id).all<{ id: string }>()).results;
  const options = await generateAuthenticationOptions({ rpID: c.get('passkeyConfig').rpID, userVerification: 'required', timeout: CHALLENGE_TTL * 1000, allowCredentials: credentials });
  return c.json({ ceremonyId: await issueChallenge(c, 'reauthentication', options.challenge, session.id, null, session), options });
});

async function verifyAssertion(c: Ctx, reauth: boolean) {
  const input = await body(c, verificationSchema);
  const challenge = await findChallenge(c, input.ceremonyId, reauth ? 'reauthentication' : 'authentication');
  const session = reauth ? await sessionFor(c.req.raw, c.env) : null;
  if (session && (challenge.session_hash !== session.token_hash || challenge.member_id !== session.id)) throw fail();
  const db = c.env.DB;
  const credential = await stmt(db, "SELECT k.*,m.user_handle FROM auth_credentials k JOIN auth_members m ON m.id=k.member_id WHERE k.id=? AND k.revoked_at IS NULL AND m.status='active'", input.response.id).first<Credential>();
  // allowCredentials assertions may legitimately omit userHandle. Reauthentication
  // already binds the credential owner to the exact session/member/challenge;
  // discoverable login still requires the handle, and any supplied handle must match.
  const userHandle = input.response.response.userHandle;
  const omittedReauthHandle = session !== null && (userHandle === undefined || userHandle === null);
  if (!credential || (session && credential.member_id !== session.id) || (!omittedReauthHandle && userHandle !== credential.user_handle)) throw fail();
  checkClientData(input.response.response.clientDataJSON);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({ response: input.response as unknown as AuthenticationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rp_id, requireUserVerification: true, credential: { id: credential.id, publicKey: bytes(credential.public_key), counter: credential.counter, transports: JSON.parse(credential.transports) } });
  } catch { throw fail(); }
  if (!verified.verified || Number(verified.authenticationInfo.credentialDeviceType === 'multiDevice') !== credential.backup_eligible) throw fail();
  const timestamp = now();
  const check = random();
  const stateCheck = random();
  const checks = [check, stateCheck];
  const statements = consumeChallenge(db, challenge, timestamp, check);
  statements.push(guard(db, stateCheck, "EXISTS (SELECT 1 FROM auth_credentials k JOIN auth_members m ON m.id=k.member_id WHERE k.id=? AND k.member_id=? AND k.revoked_at IS NULL AND k.counter=? AND m.status='active' AND m.user_handle=?)", [credential.id, credential.member_id, credential.counter, credential.user_handle]));
  if (session) { const sid = random(); checks.push(sid); statements.push(sessionGuard(db, sid, session, timestamp, false, false)); }
  statements.push(stmt(db, 'UPDATE auth_credentials SET counter=?,backed_up=?,last_used_at=? WHERE id=?', verified.authenticationInfo.newCounter, Number(verified.authenticationInfo.credentialBackedUp), timestamp, credential.id));
  let sessionToken: string | null = null;
  if (session) statements.push(stmt(db, 'UPDATE auth_sessions SET reauthenticated_at=?,last_seen_at=? WHERE token_hash=?', timestamp, timestamp, session.token_hash));
  else {
    sessionToken = random();
    const old = cookie(c.req.raw, SESSION_COOKIE);
    if (old) statements.push(stmt(db, 'UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', timestamp, await hash(old)));
    // Rotate and retire the oldest sessions atomically before creating the next one.
    statements.push(stmt(db, 'UPDATE auth_sessions SET revoked_at=? WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE member_id=? AND revoked_at IS NULL ORDER BY created_at DESC,token_hash DESC LIMIT -1 OFFSET 19)', timestamp, credential.member_id));
    statements.push(stmt(db, 'INSERT INTO auth_sessions(token_hash,member_id,credential_id,created_at,last_seen_at,expires_at,reauthenticated_at,browser_hash) VALUES (?,?,?,?,?,?,?,?)', await hash(sessionToken), credential.member_id, credential.id, timestamp, timestamp, timestamp + SESSION_TTL, timestamp, challenge.browser_hash));
  }
  statements.push(audit(db, credential.member_id, credential.member_id, reauth ? 'session.reauthenticated' : 'session.created', timestamp));
  await atomic(db, statements, checks);
  if (sessionToken) setCookie(c, SESSION_COOKIE, sessionToken, SESSION_TTL);
  return c.json({ ok: true });
}
passkeyRoutes.post('/login/verify', c => verifyAssertion(c, false));
passkeyRoutes.post('/reauth/verify', c => verifyAssertion(c, true));

passkeyRoutes.post('/register/options', async c => {
  const { token } = await body(c, z.object({ token: tokenSchema.optional() }).strict());
  let session: Session | null = null;
  let member: { id: string; user_handle: string } | null;
  const grantHash = token ? await hash(token) : null;
  if (grantHash) member = await stmt(c.env.DB, "SELECT m.id,m.user_handle FROM auth_enrollment_grants g JOIN auth_members m ON m.id=g.member_id WHERE g.token_hash=? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>? AND m.status='pending'", grantHash, now()).first();
  else { session = await sessionFor(c.req.raw, c.env, true); member = session; }
  if (!member) throw fail();
  const credentials = (await stmt(c.env.DB, 'SELECT id FROM auth_credentials WHERE member_id=? AND revoked_at IS NULL', member.id).all<{ id: string }>()).results;
  if (credentials.length >= 10) throw new ApiError(409, 'This member already has ten passkeys.');
  const options = await generateRegistrationOptions({ rpName: 'Hearth', rpID: c.get('passkeyConfig').rpID, userID: bytes(member.user_handle), userName: `hearth-${member.id}`, userDisplayName: 'Hearth member', timeout: CHALLENGE_TTL * 1000, attestationType: 'none', excludeCredentials: credentials, authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, extensions: { credProps: true }, supportedAlgorithmIDs: [-7, -257] });
  return c.json({ ceremonyId: await issueChallenge(c, 'registration', options.challenge, member.id, grantHash, session), options });
});
passkeyRoutes.post('/register/verify', async c => {
  const input = await body(c, verificationSchema.extend({ name: keyName.optional() }));
  const challenge = await findChallenge(c, input.ceremonyId, 'registration');
  const session = challenge.grant_hash ? null : await sessionFor(c.req.raw, c.env, true);
  if (session && (challenge.session_hash !== session.token_hash || challenge.member_id !== session.id)) throw fail();
  if (input.response.clientExtensionResults.credProps && (input.response.clientExtensionResults.credProps as { rk?: unknown }).rk === false) throw fail();
  checkClientData(input.response.response.clientDataJSON);
  let verification;
  try { verification = await verifyRegistrationResponse({ response: input.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rp_id, requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257] }); }
  catch { throw fail(); }
  if (!verification.verified) throw fail();
  const info = verification.registrationInfo;
  if (info.credential.id !== input.response.id) throw fail();
  const db = c.env.DB;
  const timestamp = now();
  const check = random(); const capacity = random();
  const checks = [check, capacity];
  const statements = consumeChallenge(db, challenge, timestamp, check);
  statements.push(guard(db, capacity, '(SELECT count(*) FROM auth_credentials WHERE member_id=? AND revoked_at IS NULL)<10 AND (SELECT count(*) FROM auth_credentials WHERE member_id=?)<100 AND NOT EXISTS (SELECT 1 FROM auth_credential_tombstones WHERE id_hash=?)', [challenge.member_id, challenge.member_id, await hash(info.credential.id)]));
  if (challenge.grant_hash) {
    const grantCheck = random(); checks.push(grantCheck);
    statements.push(stmt(db, "UPDATE auth_enrollment_grants SET consumed_at=? WHERE token_hash=? AND member_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM auth_members WHERE id=? AND status='pending')", timestamp, challenge.grant_hash, challenge.member_id, timestamp, challenge.member_id), guard(db, grantCheck, 'changes()=1'));
    statements.push(stmt(db, "UPDATE auth_members SET status='active',updated_at=? WHERE id=?", timestamp, challenge.member_id));
  } else if (session) { const sid = random(); checks.push(sid); statements.push(sessionGuard(db, sid, session, timestamp)); }
  else throw fail();
  const transports = (info.credential.transports || []).filter(value => ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'].includes(value)).slice(0, 8);
  statements.push(stmt(db, 'INSERT INTO auth_credentials(id,member_id,public_key,counter,transports,backup_eligible,backed_up,created_at,name) VALUES (?,?,?,?,?,?,?,?,?)', info.credential.id, challenge.member_id, b64(info.credential.publicKey), info.credential.counter, JSON.stringify(transports), Number(info.credentialDeviceType === 'multiDevice'), Number(info.credentialBackedUp), timestamp, input.name || 'Passkey'));
  statements.push(audit(db, session?.id || null, challenge.member_id, 'credential.registered', timestamp));
  await atomic(db, statements, checks);
  return c.json({ ok: true });
});

passkeyRoutes.post('/logout', async c => {
  await body(c, z.object({}).strict());
  const db = c.env.DB;
  const timestamp = now();
  const token = cookie(c.req.raw, SESSION_COOKIE);
  const browser = cookie(c.req.raw, BROWSER_COOKIE);
  const statements: D1PreparedStatement[] = [];
  if (browser) {
    const browserHash = await hash(browser);
    statements.push(stmt(db, 'DELETE FROM auth_challenges WHERE browser_hash=?', browserHash));
    statements.push(stmt(db, 'UPDATE auth_sessions SET revoked_at=? WHERE browser_hash=? AND revoked_at IS NULL', timestamp, browserHash));
  }
  // Nullable browser bindings permit additive migration of pre-existing sessions.
  if (token) statements.push(stmt(db, 'UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', timestamp, await hash(token)));
  if (statements.length) await db.batch(statements);
  setCookie(c, SESSION_COOKIE, '', 0);
  return c.json({ ok: true });
});
passkeyRoutes.post('/sessions/revoke', async c => {
  await body(c, z.object({}).strict());
  const session = await sessionFor(c.req.raw, c.env, true);
  const timestamp = now(); const check = random();
  // Discoverable login challenges have no member until verification. Invalidate
  // the bounded anonymous set as well so a pre-existing assertion cannot create
  // another session after this revocation commits. Other pending logins can retry.
  await atomic(c.env.DB, [sessionGuard(c.env.DB, check, session, timestamp), stmt(c.env.DB, "DELETE FROM auth_challenges WHERE member_id=? OR (purpose='authentication' AND member_id IS NULL)", session.id), stmt(c.env.DB, 'UPDATE auth_sessions SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL', timestamp, session.id), audit(c.env.DB, session.id, session.id, 'session.revoked_all', timestamp)], [check]);
  setCookie(c, SESSION_COOKIE, '', 0);
  return c.json({ ok: true });
});
passkeyRoutes.get('/credentials', async c => {
  const session = await sessionFor(c.req.raw, c.env);
  const rows = (await stmt(c.env.DB, 'SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt FROM auth_credentials WHERE member_id=? AND revoked_at IS NULL ORDER BY created_at,id', session.id).all<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }>()).results;
  // `current` marks the passkey that opened this session, so a list of identically named keys stays distinguishable.
  return c.json({ credentials: rows.map(row => ({ ...row, current: row.id === session.credential_id })) });
});
passkeyRoutes.post('/credentials/revoke', async c => {
  const { id } = await body(c, z.object({ id: credentialId }).strict());
  const session = await sessionFor(c.req.raw, c.env, true);
  const timestamp = now(); const check = random(); const last = random();
  await atomic(c.env.DB, [sessionGuard(c.env.DB, check, session, timestamp), guard(c.env.DB, last, 'EXISTS (SELECT 1 FROM auth_credentials WHERE id=? AND member_id=? AND revoked_at IS NULL) AND (SELECT count(*) FROM auth_credentials WHERE member_id=? AND revoked_at IS NULL)>1', [id, session.id, session.id]), stmt(c.env.DB, 'UPDATE auth_credentials SET revoked_at=? WHERE id=?', timestamp, id), stmt(c.env.DB, 'DELETE FROM auth_challenges WHERE session_hash IN (SELECT token_hash FROM auth_sessions WHERE credential_id=?)', id), stmt(c.env.DB, 'UPDATE auth_sessions SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL', timestamp, id), audit(c.env.DB, session.id, session.id, 'credential.revoked', timestamp)], [check, last]);
  if (session.credential_id === id) setCookie(c, SESSION_COOKIE, '', 0);
  return c.json({ ok: true });
});
passkeyRoutes.get('/members', async c => {
  await sessionFor(c.req.raw, c.env, false, true);
  const members = (await stmt(c.env.DB, 'SELECT id,name,role,color,status FROM auth_members ORDER BY created_at,id').all<InternalMember>()).results;
  return c.json({ members });
});
passkeyRoutes.post('/members', async c => {
  const input = await body(c, z.object({ id: memberId, name: displayName, role: z.enum(['admin', 'member']), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).strict());
  const session = await sessionFor(c.req.raw, c.env, true, true);
  const db = c.env.DB; const timestamp = now(); const check = random(); const capacity = random(); const token = random();
  await atomic(db, [sessionGuard(db, check, session, timestamp, true), guard(db, capacity, '(SELECT count(*) FROM auth_members)<20 AND NOT EXISTS (SELECT 1 FROM records WHERE owner_id=?) AND NOT EXISTS (SELECT 1 FROM records,json_tree(records.data) WHERE json_tree.type=\'text\' AND json_tree.value=?)', [input.id, input.id]), stmt(db, "INSERT INTO auth_members(id,name,role,color,status,user_handle,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?)", input.id, input.name, input.role, input.color, random(), timestamp, timestamp), stmt(db, "INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES (?,?,'enroll',?,?)", await hash(token), input.id, timestamp, timestamp + GRANT_TTL), audit(db, session.id, input.id, 'member.enrollment_authorized', timestamp)], [check, capacity]);
  return c.json({ token, expiresAt: timestamp + GRANT_TTL });
});
async function changeMember(c: Ctx, recovery: boolean) {
  await body(c, z.object({}).strict());
  const parsed = memberId.safeParse(c.req.param('id'));
  if (!parsed.success) throw new ApiError(400, 'The member is invalid.');
  const target = parsed.data;
  const session = await sessionFor(c.req.raw, c.env, true, true);
  const db = c.env.DB; const timestamp = now(); const check = random(); const last = random(); const token = recovery ? random() : null;
  const checks = [check, last];
  const statements = [sessionGuard(db, check, session, timestamp, true), guard(db, last, "EXISTS (SELECT 1 FROM auth_members WHERE id=?) AND NOT EXISTS (SELECT 1 FROM auth_members WHERE id=? AND status='active' AND role='admin' AND (SELECT count(*) FROM auth_members WHERE status='active' AND role='admin')<=1)", [target, target])];
  if (recovery) {
    const rows = (await stmt(db, 'SELECT id,created_at,revoked_at FROM auth_credentials WHERE member_id=? ORDER BY id LIMIT 101', target).all<{ id: string; created_at: number; revoked_at: number | null }>()).results;
    if (rows.length > 100) throw new ApiError(409, 'This member needs operator recovery for its credential history.');
    const snapshot = JSON.stringify(await Promise.all(rows.map(async row => ({ ...row, id_hash: await hash(row.id), retired_at: row.revoked_at ?? Math.max(row.created_at, timestamp) }))));
    const unchanged = random(); checks.push(unchanged);
    // The hash work happens outside D1. Recheck the entire selected credential
    // set before archiving so a concurrent registration or revocation rolls back.
    statements.push(guard(db, unchanged, `(SELECT count(*) FROM auth_credentials WHERE member_id=?)=? AND NOT EXISTS (SELECT 1 FROM auth_credentials k WHERE k.member_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) old WHERE json_extract(old.value,'$.id')=k.id AND json_extract(old.value,'$.created_at')=k.created_at AND json_extract(old.value,'$.revoked_at') IS k.revoked_at)) AND NOT EXISTS (SELECT 1 FROM auth_credential_tombstones t JOIN json_each(?) old ON t.id_hash=json_extract(old.value,'$.id_hash') WHERE t.member_id<>?)`, [target, rows.length, target, snapshot, snapshot, target]));
    statements.push(stmt(db, "INSERT OR IGNORE INTO auth_credential_tombstones(id_hash,member_id,retired_at) SELECT json_extract(value,'$.id_hash'),?,json_extract(value,'$.retired_at') FROM json_each(?)", target, snapshot));
    // Challenge -> session -> credential deletion order preserves every FK.
    statements.push(stmt(db, 'DELETE FROM auth_challenges WHERE member_id=? OR session_hash IN (SELECT token_hash FROM auth_sessions WHERE member_id=?)', target, target));
    statements.push(stmt(db, 'DELETE FROM auth_sessions WHERE member_id=?', target));
    statements.push(stmt(db, 'DELETE FROM auth_credentials WHERE member_id=?', target));
  } else {
    statements.push(stmt(db, 'DELETE FROM auth_challenges WHERE member_id=?', target));
    statements.push(stmt(db, 'UPDATE auth_credentials SET revoked_at=MAX(created_at,?) WHERE member_id=? AND revoked_at IS NULL', timestamp, target));
    statements.push(stmt(db, 'UPDATE auth_sessions SET revoked_at=MAX(created_at,?) WHERE member_id=? AND revoked_at IS NULL', timestamp, target));
  }
  statements.push(stmt(db, 'UPDATE auth_enrollment_grants SET revoked_at=MAX(created_at,?) WHERE member_id=? AND revoked_at IS NULL', timestamp, target));
  statements.push(stmt(db, 'UPDATE auth_members SET status=?,updated_at=MAX(updated_at,?) WHERE id=?', recovery ? 'pending' : 'suspended', timestamp, target));
  if (token) statements.push(stmt(db, "INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES (?,?,'recover',?,?)", await hash(token), target, timestamp, timestamp + GRANT_TTL));
  statements.push(audit(db, session.id, target, recovery ? 'member.recovery_authorized' : 'member.suspended', timestamp));
  await atomic(db, statements, checks);
  if (session.id === target) setCookie(c, SESSION_COOKIE, '', 0);
  return c.json(token ? { token, expiresAt: timestamp + GRANT_TTL } : { ok: true });
}
passkeyRoutes.post('/members/:id/recover', c => changeMember(c, true));
passkeyRoutes.post('/members/:id/suspend', c => changeMember(c, false));
passkeyRoutes.post('/invitations/revoke', async c => {
  const { memberId: target } = await body(c, z.object({ memberId }).strict());
  const session = await sessionFor(c.req.raw, c.env, true, true);
  const timestamp = now(); const check = random();
  await atomic(c.env.DB, [sessionGuard(c.env.DB, check, session, timestamp, true), stmt(c.env.DB, 'DELETE FROM auth_challenges WHERE grant_hash IN (SELECT token_hash FROM auth_enrollment_grants WHERE member_id=?)', target), stmt(c.env.DB, 'UPDATE auth_enrollment_grants SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL', timestamp, target), audit(c.env.DB, session.id, target, 'member.invitation_revoked', timestamp)], [check]);
  return c.json({ ok: true });
});
