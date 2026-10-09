// Isolated local-D1 proof fixture. Never imported by the application Worker.
// Inputs and tables are synthetic; this is not an inventory API or migration.
const cases = ['setup', 'consume', 'rollback', 'race', 'replay', 'guards', 'ledger', 'undo', 'bulk'];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);

async function rejected(action, message, expected = /CHECK constraint failed/) {
  let failed = false;
  try { await action(); } catch (error) {
    check(expected.test(String(error)), `${message}: unexpected failure ${String(error)}`);
    failed = true;
  }
  check(failed, message);
}

function operations(db) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  const snapshot = async () => {
    const rows = await db.batch([
      statement('SELECT * FROM lots ORDER BY id'),
      statement('SELECT * FROM txns ORDER BY id'),
      statement('SELECT * FROM ledger ORDER BY txn_id, lot_id'),
    ]);
    return rows.map(row => row.results);
  };
  const seed = (id, qty = 1000) => statement('INSERT INTO lots VALUES (?, ?, 1, 0)', id, qty).run();
  // Each line is a signed *applied* delta; shortfalls are not applied deltas.
  // Four set-based statements regardless of line count. A real route must also
  // authorize and validate bounded inputs before invoking this pattern.
  const batch = (id, actor, payload, lines, reverses = null) => {
    const json = JSON.stringify(lines);
    return [
      statement('INSERT INTO txns(id, actor, payload, reverses) VALUES (?, ?, ?, ?)', id, actor, payload, reverses),
      statement(`INSERT INTO assertions(ok) SELECT 0 WHERE
        COALESCE((SELECT enabled FROM modules WHERE id = 'inventory'), 0) != 1
        OR EXISTS (
          SELECT 1 FROM json_each(?1) AS j LEFT JOIN lots AS l ON l.id = json_extract(j.value, '$.id')
          WHERE l.id IS NULL OR l.version != json_extract(j.value, '$.version') OR l.archived != 0
            OR l.qty + json_extract(j.value, '$.delta') < 0
            OR l.qty + json_extract(j.value, '$.delta') > 1000000000000
        )
        OR (SELECT COUNT(*) FROM json_each(?1)) !=
           (SELECT COUNT(DISTINCT json_extract(value, '$.id')) FROM json_each(?1))`, json),
      statement(`UPDATE lots SET qty = lots.qty + json_extract(j.value, '$.delta'), version = lots.version + 1
        FROM json_each(?) AS j WHERE lots.id = json_extract(j.value, '$.id')`, json),
      statement(`INSERT INTO ledger(txn_id, lot_id, delta)
        SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.delta') FROM json_each(?)`, id, json),
    ];
  };
  const apply = async (id, actor, lines, reverses = null) => {
    // Stable ordering makes this fixture's request representation canonical.
    const ordered = [...lines].sort((a, b) => a.id.localeCompare(b.id));
    const payload = JSON.stringify({ lines: ordered, reverses });
    const previous = async () => {
      const row = await statement('SELECT actor, payload FROM txns WHERE id = ?', id).first();
      if (!row) return false;
      check(row.actor === actor && row.payload === payload, 'idempotency conflict');
      return true;
    };
    if (await previous()) return 'replayed';
    try { await db.batch(batch(id, actor, payload, ordered, reverses)); }
    catch (error) { if (await previous()) return 'replayed'; throw error; }
    return 'applied';
  };
  return { statement, snapshot, seed, batch, apply };
}

async function run(name, db) {
  const { statement: sql, snapshot, seed, batch, apply } = operations(db);
  if (name === 'setup') {
    await db.batch([
      sql("CREATE TABLE modules (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)))"),
      sql('CREATE TABLE lots (id TEXT PRIMARY KEY, qty INTEGER NOT NULL CHECK (typeof(qty) = \'integer\' AND qty BETWEEN 0 AND 1000000000000), version INTEGER NOT NULL, archived INTEGER NOT NULL)'),
      sql('CREATE TABLE assertions (ok INTEGER NOT NULL CHECK (ok = 1))'),
      sql('CREATE TABLE txns (id TEXT PRIMARY KEY, actor TEXT NOT NULL, payload TEXT NOT NULL, reverses TEXT UNIQUE REFERENCES txns(id))'),
      sql('CREATE TABLE ledger (txn_id TEXT NOT NULL REFERENCES txns(id), lot_id TEXT NOT NULL REFERENCES lots(id), delta INTEGER NOT NULL CHECK (typeof(delta) = \'integer\'), PRIMARY KEY(txn_id, lot_id))'),
      ...['txns', 'ledger'].flatMap(table => ['UPDATE', 'DELETE'].map(operation => sql(
        `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'INVENTORY_LEDGER_IMMUTABLE'); END`,
      ))),
      sql("INSERT INTO modules VALUES ('inventory', 1)"),
    ]);
    return 'synthetic schema and immutable ledger created';
  }
  if (name === 'consume') {
    await seed('flour'); await seed('milk', 500);
    equal(await apply('cook', 'fixture-a', [{ id: 'flour', version: 1, delta: -450 }, { id: 'milk', version: 1, delta: -200 }]), 'applied', 'consume');
    equal((await sql('SELECT id, qty, version FROM lots ORDER BY id').all()).results,
      [{ id: 'flour', qty: 550, version: 2 }, { id: 'milk', qty: 300, version: 2 }], 'both stock updates');
    return 'set-based json_each / UPDATE FROM consumption';
  }
  if (name === 'rollback') {
    const before = await snapshot();
    await rejected(() => apply('stale', 'fixture-a', [{ id: 'flour', version: 2, delta: -1 }, { id: 'milk', version: 1, delta: -1 }]), 'stale guard did not fire');
    equal(await snapshot(), before, 'guard failure must roll back transaction header and all lots');
    // Prove rollback after the stock update too, not just a guard before it.
    const commands = batch('late-error', 'fixture-a', 'fixture', [{ id: 'flour', version: 2, delta: -1 }]);
    commands.push(sql('INSERT INTO assertions VALUES (0)'));
    await rejected(() => db.batch(commands), 'late constraint did not fire');
    equal(await snapshot(), before, 'late failure must restore stock and ledger');
    return 'guard and post-update failures roll back every table';
  }
  if (name === 'race') {
    await seed('race');
    const lines = [{ id: 'race', version: 1, delta: -100 }];
    const attempts = await Promise.allSettled([apply('race-a', 'fixture-a', lines), apply('race-b', 'fixture-b', lines)]);
    equal(attempts.filter(result => result.status === 'fulfilled').length, 1, 'exactly one race winner');
    equal(await sql("SELECT qty, version FROM lots WHERE id = 'race'").first(), { qty: 900, version: 2 }, 'one decrement');
    return 'two concurrent versioned batches have exactly one winner';
  }
  if (name === 'replay') {
    await seed('retry');
    const lines = [{ id: 'retry', version: 1, delta: -100 }];
    const results = await Promise.all([apply('retry', 'fixture-a', lines), apply('retry', 'fixture-a', lines)]);
    equal([...results].sort(), ['applied', 'replayed'], 'concurrent retry');
    equal(await apply('retry', 'fixture-a', lines), 'replayed', 'stale-version retry');
    await rejected(() => apply('retry', 'fixture-b', lines), 'actor conflict', /idempotency conflict/);
    await rejected(() => apply('retry', 'fixture-a', [{ ...lines[0], delta: -101 }]), 'payload conflict', /idempotency conflict/);
    equal(await sql("SELECT qty FROM lots WHERE id = 'retry'").first('qty'), 900, 'retry changed stock');
    return 'concurrent/stale retries apply once; changed actor or payload rejected';
  }
  if (name === 'guards') {
    const lines = [{ id: 'flour', version: 2, delta: -1 }];
    const before = await snapshot();
    await sql("UPDATE modules SET enabled = 0 WHERE id = 'inventory'").run();
    await rejected(() => apply('disabled', 'fixture-a', lines), 'disabled guard');
    await sql("DELETE FROM modules WHERE id = 'inventory'").run();
    await rejected(() => apply('missing-module', 'fixture-a', lines), 'missing module guard');
    await sql("INSERT INTO modules VALUES ('inventory', 1)").run();
    await rejected(() => apply('overdraw', 'fixture-a', [{ ...lines[0], delta: -551 }]), 'overdraw guard');
    await rejected(() => apply('overflow', 'fixture-a', [{ ...lines[0], delta: 1000000000000 }]), 'upper-bound guard');
    await rejected(() => apply('fractional-stock', 'fixture-a', [{ ...lines[0], delta: -0.5 }]), 'integer stock constraint');
    await rejected(() => apply('duplicate-lot', 'fixture-a', [...lines, ...lines]), 'duplicate allocation guard');
    await rejected(() => apply('missing-lot', 'fixture-a', [{ id: 'absent', version: 1, delta: -1 }]), 'missing lot guard');
    equal(await snapshot(), before, 'failed guards changed state');
    return 'module, stock bounds, integer storage, duplicate and missing lot guards fire';
  }
  if (name === 'ledger') {
    const before = await snapshot();
    for (const table of ['txns', 'ledger']) {
      await rejected(() => sql(`DELETE FROM ${table}`).run(), `${table} delete trigger`, /INVENTORY_LEDGER_IMMUTABLE/);
      await rejected(() => sql(`UPDATE ${table} SET ${table === 'txns' ? "actor = 'changed'" : 'delta = 0'}`).run(), `${table} update trigger`, /INVENTORY_LEDGER_IMMUTABLE/);
    }
    equal(await snapshot(), before, 'append-only trigger failure changed data');
    await sql('CREATE TABLE mutable_copy AS SELECT * FROM ledger').run();
    check((await sql('DELETE FROM mutable_copy').run()).meta.changes > 0, 'negative control must mutate without trigger');
    return 'ledger and transaction immutability triggers fire; unguarded control changes';
  }
  if (name === 'undo') {
    equal(await apply('undo-cook', 'fixture-a', [{ id: 'flour', version: 2, delta: 450 }, { id: 'milk', version: 2, delta: 200 }], 'cook'), 'applied', 'compensation');
    equal(await sql("SELECT qty FROM lots WHERE id = 'flour'").first('qty'), 1000, 'undo restored applied amount');
    const before = await snapshot();
    await rejected(() => apply('second-undo', 'fixture-a', [{ id: 'flour', version: 3, delta: 450 }], 'cook'), 'duplicate undo', /UNIQUE constraint failed/);
    await rejected(() => apply('stale-undo', 'fixture-a', [{ id: 'flour', version: 2, delta: 450 }], 'retry'), 'stale undo');
    equal(await snapshot(), before, 'failed undo changed state');
    await seed('archived');
    await sql("UPDATE lots SET archived = 1 WHERE id = 'archived'").run();
    await rejected(() => apply('archived-undo', 'fixture-a', [{ id: 'archived', version: 1, delta: 1 }], 'retry'), 'archival guard');
    return 'compensation restores applied deltas; repeated/stale/archived undo rejected';
  }
  if (name === 'bulk') {
    const lots = Array.from({ length: 100 }, (_, index) => ({ id: `bulk-${index}`, version: 1, delta: -1 }));
    await sql("INSERT INTO lots SELECT json_extract(value, '$.id'), 1000, 1, 0 FROM json_each(?)", JSON.stringify(lots)).run();
    equal(batch('bulk', 'fixture-a', 'fixture', lots).length, 4, 'bounded statement count');
    await apply('bulk', 'fixture-a', lots);
    equal(await sql("SELECT COUNT(*) FROM lots WHERE id LIKE 'bulk-%' AND qty = 999 AND version = 2").first('COUNT(*)'), 100, 'bulk stock');
    equal(await sql("SELECT COUNT(*) FROM ledger WHERE txn_id = 'bulk'").first('COUNT(*)'), 100, 'bulk ledger');
    equal((await sql('PRAGMA foreign_key_check').all()).results, [], 'foreign key integrity');
    return '100-lot mutation uses four statements and preserves foreign keys';
  }
  throw new Error('unknown case');
}

export default {
  async fetch(request, env) {
    if (request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response(null, { status: 403 });
    const name = new URL(request.url).pathname.slice(1);
    if (name === 'health') return Response.json({ ok: true });
    if (request.method !== 'POST' || !cases.includes(name)) return new Response(null, { status: 404 });
    try { return Response.json({ ok: true, message: await run(name, env.DB) }); }
    catch (error) { return Response.json({ ok: false, message: String(error) }, { status: 500 }); }
  },
};
