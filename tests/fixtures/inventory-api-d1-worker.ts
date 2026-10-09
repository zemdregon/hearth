// Isolated local-D1 proof fixture. Never imported by the application Worker.
// Runs the production inventory routes against a temporary local D1 that has the real
// migrations applied. Authentication is replaced by a token + x-member header; the SQL
// endpoint exists only in this temporary Worker and only accepts the probe token.
import { Hono } from 'hono';
import { inventoryRoutes } from '../../src/server/inventory';
import { ApiError } from '../../src/server/env';
import { createHabitWithHistory } from '../../src/server/db';
import type { Env, Variables } from '../../src/server/env';

const app = new Hono<{ Bindings: Env & { PROBE_TOKEN: string }; Variables: Variables }>();
app.use('*', async (c, next) => {
  if (c.req.header('Authorization') !== `Bearer ${c.env.PROBE_TOKEN}`) return c.body(null, 403);
  await next();
});
app.get('/health', c => c.json({ ok: true }));
app.post('/__sql', async c => {
  const { statements } = await c.req.json<{ statements: { sql: string; args?: unknown[] }[] }>();
  try {
    const results = await c.env.DB.batch(statements.map(({ sql, args }) => c.env.DB.prepare(sql).bind(...(args ?? []))));
    return c.json({ ok: true, results: results.map(result => result.results) });
  } catch (error) { return c.json({ ok: false, message: String(error) }); }
});
// Production habit-backfill batch, called directly (the full app's authentication is not mounted here).
app.post('/__habit', async c => {
  const { dates } = await c.req.json<{ dates: string[] }>();
  try {
    const habit = await createHabitWithHistory(c.env.DB, { id: 'alex', name: 'alex', role: 'admin', color: '#000000' }, { title: 'Walk', userId: 'alex', color: '#2f624b' }, dates);
    return c.json({ ok: true, id: habit.id });
  } catch (error) { return c.json({ ok: false, message: error instanceof ApiError ? error.message : String(error) }); }
});
app.use('/api/*', async (c, next) => {
  const id = c.req.header('x-member') ?? 'alex';
  c.set('user', { id, name: id, role: id === 'alex' ? 'admin' : 'member', color: '#000000' });
  await next();
});
app.route('/api/inventory', inventoryRoutes);
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
  return c.json({ error: `unexpected ${error.name}: ${error.message}` }, 500);
});
export default app;
