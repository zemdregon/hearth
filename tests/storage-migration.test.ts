import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';

const initial = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0002_storage_budget.sql', import.meta.url), 'utf8');

describe('storage-budget migration compatibility', () => {
  it('executes complete Wrangler-split statements and preserves UTF-8 accounting', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(initial);
      const statements = unstable_splitSqlQuery(migration);
      expect(statements).toHaveLength(7);
      for (const statement of statements) db.exec(statement);
      expect(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'records_budget_%'").get()?.n).toBe(5);
      const data = JSON.stringify({ text: '🌳é' });
      db.prepare("INSERT INTO records(id,kind,owner_id,data,created_at,updated_at) VALUES('fixture','note','alex',?,'before','before')").run(data);
      expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: Buffer.byteLength(data), record_count: 1 });
      db.prepare("UPDATE records SET data=? WHERE id='fixture'").run('{}');
      expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: 2, record_count: 1 });
      db.exec("DELETE FROM records WHERE id='fixture'");
      expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: 0, record_count: 0 });
    } finally { db.close(); }
  });

  it('lets pre-existing oversized data shrink while rejecting growth without changing records or accounting', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(initial);
      const data = JSON.stringify({ text: 'x'.repeat(8_388_608) });
      db.prepare("INSERT INTO records(id,kind,owner_id,data,created_at,updated_at) VALUES('legacy','note','alex',?,'before','before')").run(data);
      for (const statement of unstable_splitSqlQuery(migration)) db.exec(statement);
      const update = db.prepare("UPDATE records SET data=? WHERE id='legacy'");
      // Both remain over the limit: equal-size edits and gradual shrinking
      // must stay possible so the operator can recover existing capacity.
      const equal = JSON.stringify({ text: 'y'.repeat(8_388_608) });
      const smaller = JSON.stringify({ text: 'y'.repeat(8_388_607) });
      update.run(equal);
      update.run(smaller);
      expect(() => update.run(equal)).toThrow('FAMILY_STORAGE_LIMIT');
      expect(db.prepare("SELECT data FROM records WHERE id='legacy'").get()?.data).toBe(smaller);
      expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: Buffer.byteLength(smaller), record_count: 1 });
      expect(() => db.exec("INSERT INTO records(id,kind,owner_id,data,created_at,updated_at) VALUES('blocked','note','alex','{}','after','after')")).toThrow('FAMILY_STORAGE_LIMIT');
      expect(db.prepare('SELECT count(*) n FROM records').get()?.n).toBe(1);
      db.exec("DELETE FROM records WHERE id='legacy'");
      expect(db.prepare('SELECT * FROM family_storage').get()).toEqual({ id: 1, data_bytes: 0, record_count: 0 });
    } finally { db.close(); }
  });
});
