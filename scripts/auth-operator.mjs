import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRosterFile } from './check-auth-roster.mjs';
import { parseEnrollmentRoster } from '../src/server/member-config.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const hashPattern = /^[A-Za-z0-9_-]{43}$/;
const sql = value => `'${String(value).replaceAll("'", "''")}'`;
const encode = value => createHash('sha256').update(value).digest('base64url');
const fresh = () => randomBytes(32).toString('base64url');
const rosterCommand = command => command === 'import' || command === 'restore-lock';
const auditEvent = command => `operator.${command.replaceAll('-', '_')}`;

export const operatorHelp = `Hearth account operator (no public signup, no session bypass).

Usage: node scripts/auth-operator.mjs import --input <roster.json> [options]
       node scripts/auth-operator.mjs bootstrap --member <stable-id> [options]
       node scripts/auth-operator.mjs recover --member <stable-id> [options]
       node scripts/auth-operator.mjs restore-lock --input <current-roster.json> [options]

Default: local database, read-only dry run. Apply migrations separately first.
  --local                  Explicitly select local D1 (the default).
  --remote                 Explicitly select the configured remote D1 database.
  --config <file>           JSON Wrangler config (default: project wrangler.jsonc).
  --persist-to <directory>  Isolated local persistence directory; local only.
  --apply --review <hash>   Apply the exact plan hash printed by a dry run.
  --output <new-file>       Required for bootstrap/recover apply; exclusive 0600.
  --expires-in <seconds>    Grant lifetime, 60–86400 (default 3600).

Review every listed permanent id against the intended person before --apply.
Import requires an empty member table and all historical identities in the roster.
Restore-lock requires exactly the existing member ids and revokes all restored
authentication access. Keep traffic offline until current authority is reconciled.
Bootstrap is one-time, for a pending administrator before any credential exists.
Recovery preserves the chosen identity, revokes prior access, and sets it pending.
Suspended identities cannot be recovered. Grants authorize registration only.
Tokens are written only to the requested private file, never printed.
Remote --apply changes the configured account; this command asks no further prompt.
`;

export function parseOperatorArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const command = args[0];
  if (!['import', 'bootstrap', 'recover', 'restore-lock'].includes(command)) throw new Error('Choose import, bootstrap, recover, or restore-lock; use --help.');
  const options = { command, remote: false, apply: false, config: resolve(projectDirectory, 'wrangler.jsonc'), expiresIn: 3600 };
  const seen = new Set();
  const values = { '--input': 'input', '--member': 'member', '--config': 'config', '--persist-to': 'persistTo', '--output': 'output', '--review': 'review', '--expires-in': 'expiresIn' };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate option; use --help.');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--local' || flag === '--remote') options.remote = flag === '--remote';
    else if (Object.hasOwn(values, flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing option value; use --help.');
      options[values[flag]] = value;
    } else throw new Error('Unknown option; use --help.');
  }
  if (seen.has('--local') && seen.has('--remote')) throw new Error('Choose exactly one database target.');
  if (options.remote && options.persistTo) throw new Error('--persist-to is local only.');
  if (rosterCommand(command) ? !options.input || options.member || options.output || seen.has('--expires-in') : !idPattern.test(options.member ?? '') || options.input) throw new Error('Invalid operation options; use --help.');
  if (!/^\d+$/.test(String(options.expiresIn)) || Number(options.expiresIn) < 60 || Number(options.expiresIn) > 86400) throw new Error('Grant lifetime must be 60–86400 seconds.');
  options.expiresIn = Number(options.expiresIn);
  if (options.apply && !hashPattern.test(options.review ?? '')) throw new Error('--apply requires the exact --review hash from a dry run.');
  if (options.apply && !rosterCommand(command) && !options.output) throw new Error('Grant issuance requires a new --output file.');
  if (!options.apply && options.review) throw new Error('--review is only valid with --apply.');
  for (const key of ['config', 'persistTo', 'input', 'output']) if (options[key]) options[key] = resolve(options[key]);
  return options;
}

export function loadOperatorTarget(options) {
  let config;
  try { config = JSON.parse(readFileSync(options.config, 'utf8')); }
  catch { throw new Error('Cannot read the JSON Wrangler configuration.'); }
  const bindings = config?.d1_databases?.filter?.(entry => entry?.binding === 'DB');
  if (bindings?.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(bindings[0].database_name ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(bindings[0].database_id ?? '')) throw new Error('Configure exactly one DB binding with a database name and UUID.');
  if (bindings[0].preview_database_id && bindings[0].preview_database_id !== bindings[0].database_id) throw new Error('Operator config must not select a different preview database.');
  return {
    config: options.config, remote: options.remote,
    persistTo: options.remote ? null : options.persistTo ?? resolve(dirname(options.config), '.wrangler/state'),
    databaseName: bindings[0].database_name, databaseId: bindings[0].database_id,
    accountId: config.account_id ?? null,
  };
}

// Family record payloads never leave the database. Restore review additionally
// reads full authentication rows into private process memory, never console output.
export const referenceSql = `SELECT owner_id AS id, 'text' AS type FROM records
UNION SELECT j.value AS id, j.type FROM records r, json_each(CASE WHEN r.kind = 'answer' AND json_type(r.data, '$.participantIds') = 'array' THEN json_extract(r.data, '$.participantIds') ELSE '[]' END) j
UNION SELECT json_extract(data, '$.assigneeId'), json_type(data, '$.assigneeId') FROM records WHERE kind = 'task' AND json_type(data, '$.assigneeId') IS NOT NULL
UNION SELECT json_extract(data, '$.userId'), json_type(data, '$.userId') FROM records WHERE kind = 'habit'`;
const invalidReferenceSql = `SELECT count(*) FROM records WHERE
 (kind = 'answer' AND json_type(data, '$.participantIds') IS NOT NULL AND json_type(data, '$.participantIds') != 'array')
 OR (kind = 'habit' AND COALESCE(json_type(data, '$.userId'), '') != 'text')`;

function revisionSql(member) {
  const where = `member_id = ${sql(member ?? '')}`;
  return `json_object(
    'members', (SELECT json_group_array(json_object('id', id, 'role', role, 'status', status, 'handle', user_handle, 'updated', updated_at)) FROM (SELECT * FROM auth_members ORDER BY id)),
    'credentials', (SELECT json_group_array(json_object('id', id, 'revoked', revoked_at)) FROM (SELECT id, revoked_at FROM auth_credentials WHERE ${where} ORDER BY id)),
    'tombstones', (SELECT json_group_array(json_object('hash', id_hash, 'retired', retired_at)) FROM (SELECT id_hash, retired_at FROM auth_credential_tombstones WHERE ${where} ORDER BY id_hash)),
    'grants', (SELECT json_group_array(json_object('hash', token_hash, 'consumed', consumed_at, 'revoked', revoked_at)) FROM (SELECT token_hash, consumed_at, revoked_at FROM auth_enrollment_grants WHERE ${where} ORDER BY token_hash)),
    'sessions', (SELECT json_group_array(json_object('hash', token_hash, 'revoked', revoked_at)) FROM (SELECT token_hash, revoked_at FROM auth_sessions WHERE ${where} ORDER BY token_hash)),
    'challenges', (SELECT json_group_array(json_object('id', id, 'consumed', consumed_at)) FROM (SELECT id, consumed_at FROM auth_challenges WHERE ${where} ORDER BY id)),
    'bootstrap', (SELECT count(*) FROM auth_operator_state WHERE id = 'bootstrap'),
    'tombstone_count', (SELECT count(*) FROM auth_credential_tombstones),
    'credential_count', (SELECT count(*) FROM auth_credentials))`;
}

// Fixed schema identifiers only. Full rows prevent restored roles, credentials,
// anonymous ceremonies or unrelated sessions changing between review and commit.
const restoreTables = {
  auth_members: ['id', 'name', 'role', 'color', 'status', 'user_handle', 'created_at', 'updated_at'],
  auth_credentials: ['id', 'member_id', 'public_key', 'counter', 'transports', 'backup_eligible', 'backed_up', 'created_at', 'last_used_at', 'revoked_at', 'name'],
  auth_credential_tombstones: ['id_hash', 'member_id', 'retired_at'],
  auth_enrollment_grants: ['token_hash', 'member_id', 'purpose', 'created_at', 'expires_at', 'consumed_at', 'revoked_at'],
  auth_sessions: ['token_hash', 'member_id', 'credential_id', 'created_at', 'last_seen_at', 'expires_at', 'reauthenticated_at', 'revoked_at', 'browser_hash'],
  auth_challenges: ['id', 'challenge', 'browser_hash', 'purpose', 'member_id', 'grant_hash', 'origin', 'rp_id', 'created_at', 'expires_at', 'consumed_at', 'session_hash'],
  auth_audit: ['id', 'actor_id', 'target_id', 'event', 'created_at'],
  auth_rate_windows: ['key', 'window_start', 'count'],
  auth_operator_state: ['id', 'created_at'],
  auth_transaction_guards: ['id', 'allowed'],
};
function restoreRevisionSql() {
  return `json_object(${Object.entries(restoreTables).map(([table, columns]) => `${sql(table)}, (SELECT json_group_array(json_array(${columns.join(',')})) FROM (SELECT * FROM ${table} ORDER BY ${columns[0]}))`).join(',')})`;
}

export function operatorSnapshotSql(member, allAuth = false) {
  return `SELECT
    ${sql(allAuth ? 'all' : 'member')} AS auth_scope,
    (SELECT json_group_array(json_object('id', id, 'role', role, 'status', status, 'created', created_at)) FROM (SELECT id, role, status, created_at FROM auth_members ORDER BY id)) AS members,
    (SELECT json_group_array(json_object('id', id, 'type', type)) FROM (${referenceSql} ORDER BY id)) AS references_json,
    (${invalidReferenceSql}) AS invalid_references,
    (SELECT count(*) FROM auth_credentials) AS credential_count,
    (SELECT count(*) FROM auth_credential_tombstones) AS tombstone_count,
    (SELECT count(*) FROM auth_operator_state WHERE id = 'bootstrap') AS bootstrap_count,
    ${allAuth ? restoreRevisionSql() : revisionSql(member)} AS revision;`;
}

export function createOperatorPlan(options, target, snapshot, roster) {
  const members = JSON.parse(snapshot.members);
  const references = JSON.parse(snapshot.references_json);
  if (!Array.isArray(members) || !Array.isArray(references) || !members.every(member => idPattern.test(member.id))) throw new Error('Unexpected database identity state.');
  if (snapshot.invalid_references || references.some(reference => reference.type !== 'text' || !idPattern.test(reference.id))) throw new Error('Historical identity references are malformed. Review the database privately before importing.');
  const ids = [...new Set(references.map(reference => reference.id))].sort();
  if (rosterCommand(options.command)) {
    roster = parseEnrollmentRoster(JSON.stringify(roster));
    if (!roster || (options.command === 'import' && members.length)) throw new Error('Initial import requires a validated roster and an empty member table; existing identities are never overwritten.');
    const proposed = new Set(roster.map(member => member.id));
    const missing = ids.filter(id => !proposed.has(id));
    if (missing.length) throw new Error(`Roster omits historical permanent ids: ${missing.join(', ')}. Preserve each identity, including departed members as suspended.`);
    if (options.command === 'restore-lock') {
      if (snapshot.auth_scope !== 'all') throw new Error('Restore-lock requires a complete authentication snapshot.');
      if (members.length !== roster.length || members.some(member => !proposed.has(member.id))) throw new Error('Restore roster must contain exactly the existing permanent member ids. It cannot add, drop, or replace identities.');
    }
  } else {
    const member = members.find(member => member.id === options.member);
    if (!member) throw new Error('The selected permanent member id does not exist.');
    if (member.status === 'suspended') throw new Error('Suspended members cannot receive enrollment authorizations.');
    if (options.command === 'bootstrap' && (member.role !== 'admin' || member.status !== 'pending' || members.some(value => value.status === 'active') || snapshot.credential_count !== 0 || snapshot.tombstone_count !== 0 || snapshot.bootstrap_count !== 0)) throw new Error('Bootstrap requires a pending administrator, no active members or credential history, and no prior operator bootstrap. Use explicit recovery for a lost bootstrap authorization.');
  }
  const plan = { command: options.command, member: options.member ?? null, target, roster: roster ?? null, historicalIds: ids, revision: snapshot.revision, expiresIn: options.expiresIn };
  return { ...plan, review: encode(JSON.stringify(plan)) };
}

function guard(condition, operationId) {
  return `INSERT INTO auth_transaction_guards (id, allowed) VALUES (${sql(operationId)}, CASE WHEN ${condition} THEN 1 ELSE 0 END);\nDELETE FROM auth_transaction_guards WHERE id = ${sql(operationId)};`;
}

function restoreGuards(revision, operationId) {
  const state = JSON.parse(revision);
  if (Object.keys(state).length !== Object.keys(restoreTables).length || Object.keys(restoreTables).some(table => !Array.isArray(state[table]))) throw new Error('Restore-lock requires a complete authentication snapshot.');
  const statements = [];
  for (const [table, columns] of Object.entries(restoreTables)) {
    const rows = state[table];
    statements.push(guard(`(SELECT count(*) FROM ${table}) = ${rows.length}`, operationId));
    let conditions = [];
    let length = 0;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error('Unexpected restore authentication row.');
      const condition = `EXISTS (SELECT 1 FROM ${table} WHERE ${columns[0]} = ${sql(row[0])} AND json_array(${columns.join(',')}) = json(${sql(JSON.stringify(row))}))`;
      const bytes = Buffer.byteLength(condition);
      if (bytes > 48 * 1024) throw new Error('Restore authentication row exceeds the operator safety bound.');
      // D1 has a lower expression-depth limit than standalone SQLite: a guard
      // with 100 row comparisons fails even when its SQL is well below 48 KiB.
      if ((length + bytes > 48 * 1024 || conditions.length >= 20) && conditions.length) { statements.push(guard(conditions.join(' AND '), operationId)); conditions = []; length = 0; }
      conditions.push(condition); length += bytes + 5;
    }
    if (conditions.length) statements.push(guard(conditions.join(' AND '), operationId));
  }
  return statements;
}

export function createOperatorMutation(plan, { now = Math.floor(Date.now() / 1000), token, operationId = fresh(), handles } = {}) {
  if (!rosterCommand(plan.command)) token ??= fresh();
  if (!Number.isSafeInteger(now) || now < 0 || !hashPattern.test(operationId) || (!rosterCommand(plan.command) && !hashPattern.test(token))) throw new Error('Invalid operation material.');
  const statements = plan.command === 'restore-lock' ? restoreGuards(plan.revision, operationId) : [guard(`(SELECT ${revisionSql(plan.member)}) = ${sql(plan.revision)}`, operationId)];
  if (rosterCommand(plan.command)) {
    const rosterJson = sql(JSON.stringify(plan.roster));
    const memberCondition = plan.command === 'import' ? 'NOT EXISTS (SELECT 1 FROM auth_members)' : `(SELECT count(*) FROM auth_members) = ${plan.roster.length} AND NOT EXISTS (SELECT 1 FROM auth_members existing WHERE NOT EXISTS (SELECT 1 FROM json_each(${rosterJson}) proposed WHERE json_extract(proposed.value, '$.id') = existing.id))`;
    statements.push(guard(`${memberCondition} AND (${invalidReferenceSql}) = 0 AND NOT EXISTS (SELECT 1 FROM (${referenceSql}) refs WHERE refs.type != 'text' OR refs.id IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(${rosterJson}) m WHERE json_extract(m.value, '$.id') = refs.id))`, operationId));
    for (const [index, member] of plan.roster.entries()) {
      if (plan.command === 'import') {
        const handle = handles?.[index] ?? fresh();
        if (!hashPattern.test(handle)) throw new Error('Invalid operation material.');
        statements.push(`INSERT INTO auth_members (id, name, role, color, status, user_handle, created_at, updated_at) VALUES (${sql(member.id)}, ${sql(member.name)}, ${sql(member.role)}, ${sql(member.color)}, ${sql(member.status)}, ${sql(handle)}, ${now}, ${now});`);
      } else statements.push(`UPDATE auth_members SET name=${sql(member.name)}, role=${sql(member.role)}, color=${sql(member.color)}, status=${sql(member.status)}, updated_at=MAX(created_at, updated_at, ${now}) WHERE id=${sql(member.id)};`);
    }
    statements.push(guard(`(SELECT count(*) FROM auth_members) = ${plan.roster.length}`, operationId));
    if (plan.command === 'restore-lock') {
      for (const table of ['auth_credentials', 'auth_sessions', 'auth_enrollment_grants']) statements.push(`UPDATE ${table} SET revoked_at=MAX(created_at, ${now}) WHERE revoked_at IS NULL;`);
      statements.push('DELETE FROM auth_challenges;');
      statements.push(`INSERT INTO auth_operator_state (id, created_at) SELECT 'bootstrap', ${now} WHERE NOT EXISTS (SELECT 1 FROM auth_operator_state WHERE id='bootstrap');`);
    }
  } else {
    const member = sql(plan.member);
    statements.push(guard(`EXISTS (SELECT 1 FROM auth_members WHERE id = ${member} AND status IN ('pending', 'active') AND created_at <= ${now})`, operationId));
    if (plan.command === 'bootstrap') {
      statements.push(guard(`EXISTS (SELECT 1 FROM auth_members WHERE id = ${member} AND role = 'admin' AND status = 'pending') AND NOT EXISTS (SELECT 1 FROM auth_members WHERE status = 'active') AND NOT EXISTS (SELECT 1 FROM auth_credentials) AND NOT EXISTS (SELECT 1 FROM auth_credential_tombstones)`, operationId));
      statements.push(`INSERT INTO auth_operator_state (id, created_at) VALUES ('bootstrap', ${now});`);
    }
    statements.push(`UPDATE auth_sessions SET revoked_at = MAX(created_at, ${now}) WHERE member_id = ${member} AND revoked_at IS NULL;`);
    statements.push(`UPDATE auth_credentials SET revoked_at = MAX(created_at, ${now}) WHERE member_id = ${member} AND revoked_at IS NULL;`);
    statements.push(`UPDATE auth_enrollment_grants SET revoked_at = MAX(created_at, ${now}) WHERE member_id = ${member} AND revoked_at IS NULL;`);
    statements.push(`DELETE FROM auth_challenges WHERE member_id = ${member} OR grant_hash IN (SELECT token_hash FROM auth_enrollment_grants WHERE member_id = ${member}) OR session_hash IN (SELECT token_hash FROM auth_sessions WHERE member_id = ${member});`);
    if (plan.command === 'recover') {
      const credentials = JSON.parse(plan.revision).credentials;
      if (!Array.isArray(credentials)) throw new Error('Recovery requires a complete selected-member credential snapshot.');
      for (const credential of credentials) {
        const idHash = sql(encode(credential.id));
        statements.push(guard(`NOT EXISTS (SELECT 1 FROM auth_credential_tombstones WHERE id_hash=${idHash} AND member_id<>${member})`, operationId));
        statements.push(`INSERT INTO auth_credential_tombstones(id_hash,member_id,retired_at) SELECT ${idHash},member_id,revoked_at FROM auth_credentials WHERE id=${sql(credential.id)} AND member_id=${member} ON CONFLICT(id_hash) DO NOTHING;`);
      }
      // Session metadata references the full credential row. The credential-id
      // tombstone is retained permanently, preventing registration of an old id.
      statements.push(`DELETE FROM auth_sessions WHERE member_id=${member};`);
      statements.push(`DELETE FROM auth_credentials WHERE member_id=${member};`);
      statements.push(`INSERT INTO auth_operator_state (id, created_at) SELECT 'bootstrap', ${now} WHERE NOT EXISTS (SELECT 1 FROM auth_operator_state WHERE id='bootstrap');`);
    }
    statements.push(`UPDATE auth_members SET status = 'pending', updated_at = MAX(updated_at, ${now}) WHERE id = ${member};`);
    statements.push(`INSERT INTO auth_enrollment_grants (token_hash, member_id, purpose, created_at, expires_at) VALUES (${sql(encode(token))}, ${member}, ${sql(plan.command)}, ${now}, ${now + plan.expiresIn});`);
  }
  statements.push(`INSERT INTO auth_audit (id, actor_id, target_id, event, created_at) VALUES (${sql(operationId)}, NULL, ${plan.member ? sql(plan.member) : 'NULL'}, ${sql(auditEvent(plan.command))}, ${now});`);
  return { sql: statements.join('\n'), operationId, grant: rosterCommand(plan.command) ? null : { memberId: plan.member, purpose: plan.command, token, createdAt: now, expiresAt: now + plan.expiresIn } };
}

export function wranglerArguments(target, { command, file }) {
  return [resolve(projectDirectory, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--config', target.config, target.remote ? '--remote' : '--local', ...(target.persistTo ? ['--persist-to', target.persistTo] : []), '--json', '--yes', ...(file ? ['--file', file] : ['--command', command])];
}

export function parseWranglerOutput(stdout, allowImportProgress = false) {
  let json = stdout;
  // Remote --file writes non-interactive upload progress to stdout even with
  // --json. Accept only its bounded, known prelude; query output stays strict.
  if (allowImportProgress) {
    const start = stdout.indexOf('\n[');
    if (start >= 0 && stdout.slice(0, start).trim()) {
      const prefix = stdout.slice(0, start);
      const lines = prefix.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (Buffer.byteLength(prefix) > 8192 || lines[0] !== '├ Checking if file needs uploading' || !lines.every(line => line === '├ Checking if file needs uploading' || line === '│' || /^├ 🌀 Uploading [^\r\n]{1,1024}$/.test(line) || line === '│ 🌀 Uploading complete.')) throw new Error('D1 returned an unexpected response; operation outcome is unconfirmed.');
      json = stdout.slice(start + 1);
    }
  }
  let results;
  try { results = JSON.parse(json); } catch { throw new Error('D1 returned an unexpected response; operation outcome is unconfirmed.'); }
  if (!Array.isArray(results) || !results.length || results.some(result => !result || result.success !== true || !Array.isArray(result.results))) throw new Error('D1 did not confirm successful execution.');
  return results.flatMap(result => result.results);
}

function executeWrangler(target, request) {
  // Pin the reviewed DB binding. Shared-worktree config changes during apply must
  // not redirect a write, and deployment/dev bindings are irrelevant here.
  const directory = mkdtempSync(resolve(tmpdir(), 'hearth-operator-db-'));
  let result;
  try {
    const config = resolve(directory, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name: 'hearth-auth-operator', ...(target.accountId ? { account_id: target.accountId } : {}), d1_databases: [{ binding: 'DB', database_name: target.databaseName, database_id: target.databaseId }] }), { mode: 0o600, flag: 'wx' });
    result = spawnSync(process.execPath, wranglerArguments({ ...target, config }, request), {
      cwd: projectDirectory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log', CLOUDFLARE_ENV: '', WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Child output can contain SQL or environment details. Never forward it.
  if (result.error || result.status !== 0) throw new Error('D1 operation failed. Check configuration, applied migrations, database availability, and concurrent changes. Child output was suppressed.');
  return parseWranglerOutput(result.stdout, Boolean(target.remote && request.file));
}

export function runOperator(options, { execute = executeWrangler, print = console.log } = {}) {
  const target = loadOperatorTarget(options);
  const roster = rosterCommand(options.command) ? checkRosterFile(options.input) : undefined;
  const rows = execute(target, { command: operatorSnapshotSql(options.member, options.command === 'restore-lock') });
  if (rows.length !== 1) throw new Error('D1 returned an unexpected identity snapshot.');
  const plan = createOperatorPlan(options, target, rows[0], roster);
  print(`Target: ${target.remote ? 'REMOTE' : 'local'} DB ${target.databaseName} (${target.databaseId}).`);
  print(`Operation: ${plan.command}${plan.member ? `; permanent member id: ${plan.member}` : ''}.`);
  print(`Historical permanent ids (${plan.historicalIds.length}): ${plan.historicalIds.join(', ') || '(none)'}.`);
  if (plan.roster) print(`Proposed roster: ${plan.roster.map(member => `${member.id}:${member.role}:${member.status}`).join(', ')}.`);
  if (plan.command === 'restore-lock') print('Restore lock will revoke every credential, session and authorization, delete all ceremonies, and reconcile member authority from this roster. Keep traffic offline; no enrollment token will be issued.');
  print(`Review hash: ${plan.review}`);
  if (!options.apply) {
    print('Dry run complete. No database changes, output file, or enrollment token were created. Review identity ownership, then repeat with --apply --review <hash>.');
    return { applied: false, review: plan.review };
  }
  if (options.review !== plan.review) throw new Error('Plan changed or review hash does not match. Run a fresh dry run and review it before applying.');
  let descriptor;
  let directory;
  let mutationStarted = false;
  try {
    if (!rosterCommand(options.command)) {
      descriptor = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Output must be a newly created private regular file owned by the operator.');
    }
    const mutation = createOperatorMutation(plan);
    if (descriptor !== undefined) {
      writeFileSync(descriptor, JSON.stringify({ ...mutation.grant, warning: 'Use only after this operator command confirms success. This token permits passkey registration, never direct sign-in.' }, null, 2) + '\n');
      fsyncSync(descriptor);
    }
    directory = mkdtempSync(resolve(tmpdir(), 'hearth-operator-'));
    const filename = resolve(directory, 'operation.sql');
    writeFileSync(filename, mutation.sql, { mode: 0o600, flag: 'wx' });
    mutationStarted = true;
    execute(target, { file: filename });
    const confirmation = execute(target, { command: `SELECT id FROM auth_audit WHERE id = ${sql(mutation.operationId)} AND event = ${sql(auditEvent(plan.command))};` });
    if (confirmation.length !== 1 || confirmation[0].id !== mutation.operationId) throw new Error('D1 did not return the operation receipt.');
    print(`Applied ${plan.command}; database receipt verified. ${mutation.grant ? 'Enrollment authorization saved only to the requested private output file. Registration and a separate passkey sign-in are required.' : plan.command === 'restore-lock' ? 'All restored authentication access was revoked; reviewed member authority was reconciled. Permanent ids, user handles and family records were preserved. Keep traffic offline until the recovery and restore checks are complete.' : 'Permanent ids and historical records were preserved.'}`);
    return { applied: true, review: plan.review };
  } catch {
    if (mutationStarted) throw new Error(rosterCommand(plan.command) ? 'Apply outcome is unconfirmed. Keep traffic offline and inspect database state before reviewing a fresh plan. No enrollment token was issued by this operation.' : 'Apply outcome is unconfirmed. Preserve the private output file and inspect database state before retrying. A fresh recovery can revoke an uncertain authorization; never reuse the output path.');
    throw new Error(rosterCommand(plan.command) ? 'Apply stopped before database mutation. Check the local operation inputs and temporary-file permissions.' : 'Apply stopped before database mutation. Check that the private output path is new, writable, and owner-only. Existing files are never overwritten.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOperatorArgs(process.argv.slice(2));
    if (options.help) console.log(operatorHelp);
    else runOperator(options);
  } catch (error) {
    // Only trusted errors are printable; parser/file-system errors can echo input.
    const safe = error instanceof Error && !error.code && !error.name?.includes('Syntax') ? error.message : 'Operator command failed. Check inputs privately; no source content is displayed.';
    console.error(safe);
    process.exitCode = 1;
  }
}
