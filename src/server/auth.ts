import type { Env, FamilyConfig } from './env';
import { ApiError } from './env';
import { parseQuestionPair, parseTimezone } from './config.mjs';
import { authenticatePasskey, readPasskeyConfig, readPasskeyMembers } from './passkeys';
import type { User } from '../shared/types';

export const authenticate = authenticatePasskey;

export async function readConfig(env: Env, requestUrl: string): Promise<FamilyConfig> {
  try {
    const config = readPasskeyConfig(env, requestUrl);
    const members = await readPasskeyMembers(env.DB);
    // Validate permanent ids against the full roster, then withhold pairing while
    // either member is unavailable. Suspension must not break everyone else's API.
    const allMembers = (await env.DB.prepare('SELECT id,name,role,color FROM auth_members ORDER BY created_at,id').all<User>()).results;
    const configuredPair = parseQuestionPair(env.FAMILY_QUESTION_PAIR, allMembers);
    const questionPair = configuredPair?.every(id => members.some(member => member.id === id)) ? configuredPair : null;
    return { members, questionPair, timezone: parseTimezone(env.FAMILY_TIMEZONE), origin: config.origin };
  } catch {
    throw new ApiError(503, 'Family access is not configured.');
  }
}

export function enforceOrigin(request: Request, family: FamilyConfig): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== family.origin) throw new ApiError(403, 'This request came from an unrecognized origin.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Cross-site changes are not allowed.');
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'Send changes as application/json.');
}
