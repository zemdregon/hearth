import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import app from '../../src/server/index';
import type { Env } from '../../src/server/env';
import type { User } from '../../src/shared/types';

export const base = 'http://localhost:8787';
export const members: User[] = [
  { id: 'alex', name: 'Alex', role: 'admin', color: '#38634A' },
  { id: 'sam', name: 'Sam', role: 'member', color: '#A96743' },
];

/** Real SQLite runs the production migrations and SQL; this adapter only models D1's result shape. */
export function harness() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  class Statement {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async first() { return sqlite.prepare(this.sql).get(...this.values as (string | number | null)[]) ?? null; }
    async all() {
      const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n);
      const results = sqlite.prepare(this.sql).all(...this.values as (string | number | null)[]);
      return { results, success: true, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n) - before } };
    }
    async run() { return this.all(); }
  }
  const db = {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const env: Env = { DB: db, WEBAUTHN_RP_ID: 'localhost', FAMILY_TIMEZONE: 'UTC', APP_ORIGIN: base };
  const tokens = new Map<string, string>();
  const now = Math.floor(Date.now() / 1000);
  for (const member of members) {
    const token = Buffer.from(randomBytes(32)).toString('base64url');
    tokens.set(member.id, token);
    sqlite.prepare("INSERT INTO auth_members (id,name,role,color,status,user_handle,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,?)")
      .run(member.id, member.name, member.role, member.color, Buffer.from(randomBytes(32)).toString('base64url'), now, now);
    sqlite.prepare("INSERT INTO auth_credentials (id,member_id,public_key,counter,transports,backup_eligible,backed_up,created_at) VALUES (?,?, 'cHVibGlj',0,'[]',0,0,?)").run(`test-${member.id}`, member.id, now);
    sqlite.prepare('INSERT INTO auth_sessions (token_hash,member_id,credential_id,created_at,last_seen_at,expires_at,reauthenticated_at) VALUES (?,?,?,?,?,?,?)')
      .run(createHash('sha256').update(token).digest('base64url'), member.id, `test-${member.id}`, now, now, now + 86400, now);
  }
  function request(path: string, options: { method?: string; body?: unknown; user?: string; headers?: Record<string, string> } = {}) {
    return app.request(`${base}${path}`, {
      method: options.method || 'GET',
      headers: { Origin: base, 'Content-Type': 'application/json', Cookie: `__Host-hearth_session=${tokens.get(options.user || 'alex') || ''}`, ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, env);
  }
  return { db, sqlite, env, request, close: () => sqlite.close() };
}
