import { randomBytes, createHash } from 'node:crypto';

// Local e2e fixture only. Production runtime contains no test identity branch.
export function authSeed() {
  const now = Math.floor(Date.now() / 1000);
  const random = () => randomBytes(32).toString('base64url');
  const hash = value => createHash('sha256').update(value).digest('base64url');
  const sessions = { alex: random(), sam: random() };
  const enrollment = random();
  const rows = [
    'DELETE FROM auth_challenges;', 'DELETE FROM auth_sessions;', 'DELETE FROM auth_enrollment_grants;',
    'DELETE FROM auth_credentials;', 'DELETE FROM auth_audit;', 'DELETE FROM auth_members;',
    'DELETE FROM auth_rate_windows;',
  ];
  for (const [id, name, role, color] of [['alex','Alex','admin','#557461'],['sam','Sam','member','#b56d51'],['passkey-test','Passkey tester','member','#426c85']]) {
    rows.push(`INSERT INTO auth_members(id,name,role,color,status,user_handle,created_at,updated_at) VALUES ('${id}','${name}','${role}','${color}','${id === 'passkey-test' ? 'pending' : 'active'}','${random()}',${now},${now});`);
    if (id in sessions) {
      rows.push(`INSERT INTO auth_credentials(id,member_id,public_key,counter,transports,backup_eligible,backed_up,created_at) VALUES ('fixture-${id}','${id}','cHVibGlj',0,'[]',0,0,${now});`);
      rows.push(`INSERT INTO auth_sessions(token_hash,member_id,credential_id,created_at,last_seen_at,expires_at,reauthenticated_at) VALUES ('${hash(sessions[id])}','${id}','fixture-${id}',${now},${now},${now + 86400},${now});`);
    }
  }
  rows.push(`INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES ('${hash(enrollment)}','passkey-test','enroll',${now},${now+86400});`);
  return { sql: rows.join('\n'), sessions, enrollment };
}
