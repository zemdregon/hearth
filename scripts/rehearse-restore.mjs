import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { operatorSnapshotSql, parseOperatorArgs, runOperator } from './auth-operator.mjs';

// Synthetic fixtures only. No existing config, database, backup or remote target
// is accepted. The only writes are in this invocation's private temporary tree.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const b64 = value => Buffer.from(value).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const fresh = () => b64(randomBytes(32));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function rehearseRestore() {
  const directory = mkdtempSync(join(tmpdir(), 'hearth-restore-drill-'));
  const environment = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log', CLOUDFLARE_ENV: '', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') };
  let worker;
  let workerExit;
  let stage = 'initialization';
  async function stopWorker() {
    if (!worker) return;
    const signal = value => { try { if (process.platform === 'win32') worker.kill(value); else process.kill(-worker.pid,value); } catch (error) { if(error.code !== 'ESRCH') throw error; } };
    signal('SIGTERM');
    await Promise.race([workerExit,pause(5000)]);
    if (worker.exitCode === null && worker.signalCode === null) { signal('SIGKILL'); await workerExit; }
    worker = undefined;
  }
  function cli(config, args, json = false) {
    const result = spawnSync(process.execPath, [wrangler, ...args, '--local', '--config', config, ...(json ? ['--json'] : [])], {
      cwd: dirname(config), env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
    });
    // Wrangler can echo SQL. Never print captured subprocess output.
    if (result.error || result.status !== 0) {
      const categories = (result.stderr + result.stdout).match(/too many SQL variables|Expression tree is too large|parser stack overflow|statement too long|SQLITE_[A-Z_]+|CHECK constraint failed|FOREIGN KEY constraint failed|database is locked|not authorized|too many terms in compound SELECT/gi);
      console.error(`Local Wrangler failure categories: ${[...new Set(categories || ['unclassified'])].join(', ')}.`);
      throw new Error('Local Wrangler command failed; subprocess output withheld.');
    }
    if (!json) return;
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output) && output.length && output.every(item => item.success));
    return output.flatMap(item => item.results ?? []);
  }
  function query(config, sql) { return cli(config, ['d1', 'execute', 'DB', '--command', sql], true); }
  function execute(config, sql) {
    const file = join(directory, `operation-${fresh()}.sql`);
    writeFileSync(file, sql, { mode: 0o600, flag: 'wx' });
    try { cli(config, ['d1', 'execute', 'DB', '--file', file]); } finally { rmSync(file); }
  }
  function operator(config, command, extras = []) {
    const args = [command, '--config', config, '--local', ...extras];
    const review = runOperator(parseOperatorArgs(args), { print() {} }).review;
    return runOperator(parseOperatorArgs([...args, '--apply', '--review', review]), { print() {} });
  }
  const snapshotSql = `SELECT
    (SELECT json_group_array(json_object('id',id,'kind',kind,'owner',owner_id,'data',data,'created',created_at,'updated',updated_at,'version',version)) FROM (SELECT * FROM records ORDER BY id)) AS records,
    (SELECT json_group_array(json_object('id',id,'enabled',enabled)) FROM (SELECT * FROM modules ORDER BY id)) AS modules,
    (SELECT json_object('bytes',data_bytes,'count',record_count) FROM family_storage WHERE id=1) AS budget,
    (SELECT json_group_array(json_object('id',id,'handle',user_handle,'created',created_at)) FROM (SELECT * FROM auth_members ORDER BY id)) AS identities,
    (SELECT json_group_array(json_object('type',type,'name',name,'sql',sql)) FROM (SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name)) AS schema;`;
  try {
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const configs = ['source', 'restored'].map((name, index) => {
      const folder = join(directory, name); mkdirSync(folder, { mode: 0o700 });
      const config = join(folder, 'wrangler.json');
      writeFileSync(config, JSON.stringify({ name: `hearth-restore-${name}`, main: join(root, 'src/server/index.ts'), compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], workers_dev: false,
        vars: { APP_ORIGIN: origin, WEBAUTHN_RP_ID: 'localhost', FAMILY_TIMEZONE: 'UTC', FAMILY_QUESTION_PAIR: '["alex","sam"]' },
        d1_databases: [{ binding: 'DB', database_name: `hearth-restore-${name}`, database_id: `11111111-1111-4111-8111-11111111111${index}`, migrations_dir: join(root, 'migrations') }],
      }), { mode: 0o600, flag: 'wx' });
      return config;
    });
    const [source, restored] = configs;
    stage = 'source migration and synthetic fixture';
    cli(source, ['d1', 'migrations', 'apply', 'DB']);
    const now = Math.floor(Date.now() / 1000);
    const session = fresh(), grant = fresh(), handle = fresh(), credential = fresh();
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = key.publicKey.export({ format: 'jwk' });
    const publicKey = b64(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])));
    const rows = [];
    for (const [id, role, status] of [['alex','admin','active'], ['sam','member','pending'], ['former','admin','active']]) {
      rows.push(`INSERT INTO auth_members VALUES (${quote(id)},${quote(id)},${quote(role)},'#38634A',${quote(status)},${quote(id === 'alex' ? handle : fresh())},${now},${now});`);
    }
    rows.push(`INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at) VALUES (${quote(credential)},'alex',${quote(publicKey)},0,0,${now});`);
    // Reproduce the historical capacity boundary: recovery must still work after
    // 100 full credential records, without permitting reuse of their old ids.
    for (let index=0; index<99; index++) rows.push(`INSERT INTO auth_credentials(id,member_id,public_key,backup_eligible,backed_up,created_at,revoked_at) VALUES ('retired-fixture-${index}','alex',${quote(publicKey)},0,0,${now},${now});`);
    rows.push(`INSERT INTO auth_sessions(token_hash,member_id,credential_id,created_at,last_seen_at,expires_at) VALUES (${quote(b64(digest(session)))},'alex',${quote(credential)},${now},${now},${now+86400});`);
    rows.push(`INSERT INTO auth_enrollment_grants(token_hash,member_id,purpose,created_at,expires_at) VALUES (${quote(b64(digest(grant)))},'sam','enroll',${now},${now+86400});`);
    const records = [
      ['private-mood','mood','alex',{date:'2026-10-01',score:3,note:'Synthetic private mood',shared:false}],
      ['shared-task','task','alex',{title:'Synthetic task',assigneeId:'sam',done:false}],
      ['couples-answer','answer','alex',{date:'2026-10-01',questionId:'fixture',choice:1,participantIds:['alex','sam'],shareToProfile:false}],
      ['paused-recipe','recipe','former',{title:'Synthetic paused recipe',description:'',servings:2,prepMinutes:5,cookMinutes:0,ingredients:[{name:'Rice',quantity:1,unit:'cup'}],steps:['Preserve me'],tags:[],favorite:false}],
    ];
    for (const [id, kind, owner, data] of records) rows.push(`INSERT INTO records VALUES (${quote(id)},${quote(kind)},${quote(owner)},${quote(JSON.stringify(data))},'2026-10-01','2026-10-01',7);`);
    rows.push("INSERT INTO modules VALUES ('recipes',0),('moods',1),('tasks',1);");
    execute(source, rows.join('\n'));
    const before = query(source, snapshotSql)[0];
    const authBefore = query(source, operatorSnapshotSql(undefined,true))[0];

    stage = 'local D1 export';
    const backup = join(directory, 'backup.sql');
    cli(source, ['d1', 'export', 'DB', '--output', backup]);
    chmodSync(backup, 0o600);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    stage = 'isolated D1 import';
    cli(restored, ['d1', 'execute', 'DB', '--file', backup]);
    const imported = query(restored, snapshotSql)[0];
    stage = 'imported authentication equality';
    assert.deepEqual(query(restored,operatorSnapshotSql(undefined,true))[0],authBefore);
    for (const field of Object.keys(before)) {
      stage = `imported ${field} equality`;
      assert.deepEqual(imported[field], before[field]);
    }
    stage = 'imported foreign key integrity';
    assert.deepEqual(query(restored, 'PRAGMA foreign_key_check;'), []);
    // D1 exposes quick_check rather than SQLite's unrestricted integrity_check.
    stage = 'imported D1 quick check';
    assert.equal(query(restored, 'PRAGMA quick_check;')[0].quick_check, 'ok');
    console.log('Verified isolated export/import: record bytes, ownership, audiences, paused modules, identities, schema and storage totals preserved.');

    stage = 'restored authentication controls';
    const url = path => `http://127.0.0.1:${port}${path}`;
    async function request(path, body, cookie = '') {
      return fetch(url(path), { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type':'application/json', Cookie:cookie }, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(10000) });
    }
    async function startWorker() {
    worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', restored, '--ip', '127.0.0.1', '--port', String(port), '--local-upstream', `localhost:${port}`, '--upstream-protocol', 'http', '--inspector-port', '0', '--show-interactive-dev-session', 'false'], { cwd: dirname(restored), env: environment, stdio: ['ignore','pipe','pipe'], detached: process.platform !== 'win32' });
    worker.stdout.resume(); worker.stderr.resume();
    workerExit = new Promise(resolve => { worker.once('error', () => resolve()); worker.once('exit', () => resolve()); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error('Local Worker exited before readiness.');
      try { const response = await request('/api/health'); await response.body?.cancel(); if (response.ok) { ready = true; break; } } catch {}
      await pause(500);
    }
    assert.ok(ready, 'Worker readiness deadline');
    }
    await startWorker();
    assert.equal((await request('/api/bootstrap', undefined, `__Host-hearth_session=${session}`)).status, 200);
    async function assertion(assertionKey=key, assertionCredential=credential) {
      const response = await request('/api/auth/login/options', {});
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const {ceremonyId, options} = await response.json();
      const clientDataJSON = Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin,crossOrigin:false}));
      const authenticatorData = Buffer.concat([digest('localhost'), Buffer.from([5]), Buffer.alloc(4)]);
      const signature = sign('sha256', Buffer.concat([authenticatorData,digest(clientDataJSON)]),assertionKey.privateKey);
      return {cookie,body:{ceremonyId,response:{id:assertionCredential,rawId:assertionCredential,type:'public-key',response:{clientDataJSON:b64(clientDataJSON),authenticatorData:b64(authenticatorData),signature:b64(signature),userHandle:handle},clientExtensionResults:{}}}};
    }
    const valid = await assertion();
    assert.equal((await request('/api/auth/login/verify',valid.body,valid.cookie)).status,200);
    const pending = await assertion();
    assert.equal((await request('/api/auth/register/options',{token:grant})).status,200);

    stage = 'reviewed restore lock';
    const roster = join(directory,'reviewed-roster.json');
    writeFileSync(roster,JSON.stringify([
      {id:'alex',name:'Alex',role:'admin',color:'#38634A',status:'pending'},
      {id:'sam',name:'Sam',role:'member',color:'#38634A',status:'pending'},
      {id:'former',name:'Former',role:'member',color:'#38634A',status:'suspended'},
    ]),{mode:0o600,flag:'wx'});
    // Real restores remain offline while operator writes reconcile authority.
    await stopWorker();
    operator(restored,'restore-lock',['--input',roster]);
    await startWorker();
    stage = 'restore-lock data preservation';
    assert.deepEqual(query(restored,snapshotSql)[0],before);
    stage = 'restored session denial';
    assert.equal((await request('/api/bootstrap',undefined,`__Host-hearth_session=${session}`)).status,401);
    stage = 'restored pending assertion denial';
    assert.equal((await request('/api/auth/login/verify',pending.body,pending.cookie)).status,401);
    stage = 'restored invitation denial';
    assert.equal((await request('/api/auth/register/options',{token:grant})).status,401);
    stage = 'restored credential denial';
    const revoked = await assertion();
    assert.equal((await request('/api/auth/login/verify',revoked.body,revoked.cookie)).status,401);
    assert.deepEqual(query(restored,"SELECT id,role,status FROM auth_members ORDER BY id;"),[
      {id:'alex',role:'admin',status:'pending'},{id:'former',role:'member',status:'suspended'},{id:'sam',role:'member',status:'pending'},
    ]);
    console.log('Verified restore lock: old sessions, signed assertions, pending ceremonies and invitations denied; reviewed roles and suspension applied.');

    stage = 'operator recovery remains registration-only';
    const output = join(directory,'recovery.json');
    await stopWorker();
    operator(restored,'recover',['--member','alex','--output',output]);
    await startWorker();
    assert.equal(statSync(output).mode & 0o777,0o600);
    const recovery = JSON.parse(readFileSync(output,'utf8'));
    async function register(registrationCredential, registrationPublicKey) {
      const optionsResponse=await request('/api/auth/register/options',{token:recovery.token});
      assert.equal(optionsResponse.status,200);
      const cookie=optionsResponse.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const {ceremonyId,options}=await optionsResponse.json();
      const clientDataJSON=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin,crossOrigin:false}));
      const id=Buffer.from(registrationCredential,'base64url');
      const length=Buffer.alloc(2);length.writeUInt16BE(id.length);
      const authData=Buffer.concat([digest('localhost'),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),length,id,Buffer.from(registrationPublicKey,'base64url')]);
      const attestationObject=isoCBOR.encode(new Map([['fmt','none'],['authData',authData],['attStmt',new Map()]]));
      return request('/api/auth/register/verify',{ceremonyId,name:'Recovered passkey',response:{id:registrationCredential,rawId:registrationCredential,type:'public-key',response:{clientDataJSON:b64(clientDataJSON),attestationObject:b64(attestationObject),transports:['internal']},clientExtensionResults:{credProps:{rk:true}}}},cookie);
    }
    assert.equal((await request('/api/bootstrap',undefined,`__Host-hearth_session=${session}`)).status,401);
    assert.equal(query(restored,'SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL;')[0].n,0);
    assert.equal(query(restored,"SELECT count(*) AS n FROM auth_credential_tombstones WHERE member_id='alex';")[0].n,100);
    stage='retired credential registration denial';
    assert.equal((await register(credential,publicKey)).status,409);
    stage='fresh recovery enrollment at historical capacity';
    const recoveredKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const recoveredJwk=recoveredKey.publicKey.export({format:'jwk'});
    const recoveredPublicKey=b64(isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(recoveredJwk.x,'base64url')],[-3,Buffer.from(recoveredJwk.y,'base64url')]])));
    const recoveredCredential=fresh();
    assert.equal((await register(recoveredCredential,recoveredPublicKey)).status,200);
    assert.equal((await request('/api/bootstrap')).status,401);
    const recovered=await assertion(recoveredKey,recoveredCredential);
    const signedIn=await request('/api/auth/login/verify',recovered.body,recovered.cookie);
    assert.equal(signedIn.status,200);
    const recoveredCookie=signedIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert.equal((await request('/api/bootstrap',undefined,recoveredCookie)).status,200);
    assert.deepEqual(query(restored,snapshotSql)[0],before);

    stage = 'restored storage triggers';
    execute(restored,"INSERT INTO records VALUES ('trigger-probe','note','alex','{\"text\":\"é\"}','now','now',1);");
    const budget = query(restored,'SELECT data_bytes,record_count FROM family_storage WHERE id=1;')[0];
    assert.equal(budget.record_count,records.length+1);
    assert.equal(budget.data_bytes,JSON.parse(before.budget).bytes+Buffer.byteLength('{"text":"é"}'));
    execute(restored,"DELETE FROM records WHERE id='trigger-probe';");
    assert.deepEqual(query(restored,snapshotSql)[0],before);
    assert.deepEqual(query(source,snapshotSql)[0],before);
    assert.deepEqual(query(source,operatorSnapshotSql(undefined,true))[0],authBefore);
    console.log('Verified recovery at100 historical credentials: retired ids denied, fresh enrollment and separate signed assertion succeed; storage triggers and source preservation verified.');
    console.log('Local restore rehearsal passed. No remote database, production configuration or real family data was used.');
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION' && typeof error.actual === 'number' && typeof error.expected === 'number') console.error(`Numeric check: expected ${error.expected}, observed ${error.actual}.`);
    // Operator errors are already redacted; retain their fixed diagnostic text.
    if (stage === 'reviewed restore lock') console.error(error instanceof Error ? error.message : 'Operator failed.');
    throw new Error(`Restore rehearsal failed during ${stage}. Fixture data and subprocess output withheld.`);
  } finally {
    await stopWorker();
    rmSync(directory,{recursive:true,force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('This local synthetic rehearsal accepts no arguments or remote targets.'); process.exitCode=1; }
  else await rehearseRestore().catch(error => { console.error(error.message); process.exitCode=1; });
}
