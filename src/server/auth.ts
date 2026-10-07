import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env, FamilyConfig } from './env';
import { ApiError } from './env';
import type { User } from '../shared/types';
import { parseAccessDomain, parseFamilyMembers, parseTimezone } from './config.mjs';

export function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

export function readConfig(env: Env, requestUrl: string): FamilyConfig {
  try {
    const url = new URL(requestUrl);
    const dev = env.DEV_AUTH === 'true' && isLoopback(url.hostname);
    const members = parseFamilyMembers(env.FAMILY_MEMBERS);
    const timezone = parseTimezone(env.FAMILY_TIMEZONE);
    const originUrl = new URL(env.APP_ORIGIN || (dev ? url.origin : ''));
    if (originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash || (!dev && originUrl.protocol !== 'https:')) throw new Error('Invalid origin');
    if (dev && !isLoopback(originUrl.hostname)) throw new Error('Development origin must be local');
    if (!dev) {
      if (!env.ACCESS_AUD?.trim()) throw new Error('Missing Access audience');
      parseAccessDomain(env.ACCESS_TEAM_DOMAIN);
    }
    return { members, timezone, origin: originUrl.origin, dev };
  } catch {
    throw new ApiError(503, 'Family access is not configured.');
  }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Env, family: FamilyConfig): Promise<User> {
  let email: string | undefined;
  if (family.dev) {
    // A local development identity is still restricted to the explicit family allowlist.
    email = request.headers.get('X-Dev-User')?.trim().toLowerCase() || family.members[0]?.email;
  } else {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16_384) throw new ApiError(401, 'Sign in through Cloudflare Access.');
    try {
      const issuer = `https://${parseAccessDomain(env.ACCESS_TEAM_DOMAIN)}`;
      let keySet = keySets.get(issuer);
      if (!keySet) {
        keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
        keySets.set(issuer, keySet);
      }
      const { payload } = await jwtVerify(token, keySet, { issuer, audience: env.ACCESS_AUD!, algorithms: ['RS256'], clockTolerance: 5, requiredClaims: ['exp', 'sub', 'email', 'type'] });
      if (payload.type !== 'app' || typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub) throw new Error('Invalid identity');
      email = payload.email.trim().toLowerCase();
    } catch {
      throw new ApiError(401, 'Your family sign-in could not be verified.');
    }
  }
  const user = family.members.find(member => member.email === email);
  if (!user) throw new ApiError(403, 'This account is not a member of this family.');
  return user;
}

export function enforceOrigin(request: Request, family: FamilyConfig): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== family.origin) throw new ApiError(403, 'This request came from an unrecognized origin.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Cross-site changes are not allowed.');
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'Send changes as application/json.');
}
