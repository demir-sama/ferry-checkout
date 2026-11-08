// Same suite against real Postgres semantics: PGlite (Postgres compiled to WASM) speaking the Postgres wire
// protocol to the production `pg` driver and the production schema/migration.
import { after, before } from 'node:test';
import { defineSuite } from './suite.js';
import { pgliteServer } from './harness.js';
import { openPostgres } from '../src/db.js';
let srv, db;
before(async () => { srv = await pgliteServer(); db = await openPostgres(srv.url, { max: 1 }); await db.migrate(); });
after(async () => { await db?.close(); await srv?.stop(); });
defineSuite('postgres', async () => {
  await db.run('TRUNCATE order_events, quotes, orders, products, sessions, ai_drafts, merchants, kv, rate_limits RESTART IDENTITY CASCADE');
  return { store: 'pg', sharedDb: db };
});
