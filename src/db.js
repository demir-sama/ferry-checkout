// Storage adapters with one async interface:
//   all(sql, params) → rows, get(sql, params) → row|undefined, run(sql, params) → { changes, rows }
//   tx(async (t) => ...) runs statements atomically; t has the same methods.
// SQL is written with `?` placeholders; the Postgres adapter rewrites them to $1..$n.
// SQLite (node:sqlite) is for local development and tests. Postgres (pg, e.g. Neon) is for hosting.

const TABLES = (serial) => `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, access_key_hash TEXT NOT NULL UNIQUE,
  payout_asset_id TEXT, payout_chain TEXT, payout_symbol TEXT, payout_decimals INTEGER, payout_recipient TEXT,
  accepted_assets TEXT NOT NULL DEFAULT '[]', profile TEXT NOT NULL DEFAULT '{}', is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', price_base TEXT NOT NULL, asset_id TEXT NOT NULL, decimals INTEGER NOT NULL,
  symbol TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, checkout_secret_hash TEXT NOT NULL UNIQUE, merchant_id TEXT NOT NULL REFERENCES merchants(id),
  product_id TEXT, item_name TEXT NOT NULL, item_description TEXT NOT NULL DEFAULT '', amount_out_base TEXT NOT NULL,
  dest_asset_id TEXT NOT NULL, dest_chain TEXT NOT NULL, dest_symbol TEXT NOT NULL, dest_decimals INTEGER NOT NULL,
  recipient TEXT NOT NULL, accepted_assets TEXT NOT NULL, status TEXT NOT NULL, paid_quote_id TEXT, status_note TEXT,
  quote_count INTEGER NOT NULL DEFAULT 0, quote_lock_until TEXT, extra_payment INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), origin_asset_id TEXT NOT NULL, origin_symbol TEXT NOT NULL,
  origin_chain TEXT NOT NULL, origin_decimals INTEGER NOT NULL, refund_to TEXT NOT NULL, deposit_address TEXT NOT NULL,
  deposit_memo TEXT, amount_in TEXT NOT NULL, min_amount_in TEXT NOT NULL, amount_out TEXT NOT NULL, deadline TEXT NOT NULL,
  time_estimate INTEGER, refund_fee TEXT, signature TEXT NOT NULL, correlation_id TEXT, raw TEXT NOT NULL,
  remote_status TEXT NOT NULL DEFAULT 'PENDING_DEPOSIT', remote_detail TEXT, verified INTEGER, verify_problems TEXT,
  last_polled_at TEXT, created_at TEXT NOT NULL, UNIQUE (deposit_address, deposit_memo));
CREATE TABLE IF NOT EXISTS order_events (
  id ${serial}, order_id TEXT NOT NULL REFERENCES orders(id), kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_drafts (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, brief TEXT NOT NULL, model TEXT NOT NULL,
  draft TEXT NOT NULL, validation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, window_start BIGINT NOT NULL, n INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_order ON quotes(order_id);
CREATE INDEX IF NOT EXISTS idx_quotes_open ON quotes(remote_status);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, id);
`;
export const SQLITE_SCHEMA = TABLES('INTEGER PRIMARY KEY AUTOINCREMENT');
export const PG_SCHEMA = TABLES('BIGSERIAL PRIMARY KEY');

export const now = () => new Date().toISOString();

export async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') { const fs = await import('node:fs'); const path = await import('node:path'); fs.mkdirSync(path.dirname(file), { recursive: true }); }
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SQLITE_SCHEMA);
  const ops = {
    all: async (sql, p = []) => raw.prepare(sql).all(...p),
    get: async (sql, p = []) => raw.prepare(sql).get(...p),
    run: async (sql, p = []) => {
      const st = raw.prepare(sql);
      if (/\bRETURNING\b/i.test(sql)) { const rows = st.all(...p); return { changes: rows.length, rows }; }
      const r = st.run(...p); return { changes: Number(r.changes), rows: [] };
    },
  };
  // One connection: serialise transactions so other requests cannot interleave statements inside them.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
  const guarded = Object.fromEntries(Object.entries(ops).map(([k, f]) => [k, (...a) => exclusive(() => f(...a))]));
  return {
    kind: 'sqlite', ...guarded,
    tx: (fn) => exclusive(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await fn(ops); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    }),
    close: async () => raw.close(),
  };
}

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

export async function openPostgres(url, { max = 5 } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  const wrap = (c) => ({
    all: async (sql, p = []) => (await c.query(toPg(sql), p)).rows,
    get: async (sql, p = []) => (await c.query(toPg(sql), p)).rows[0],
    run: async (sql, p = []) => { const r = await c.query(toPg(sql), p); return { changes: r.rowCount ?? 0, rows: r.rows }; },
  });
  return {
    kind: 'pg', ...wrap(pool), pool,
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(wrap(c)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    migrate: async () => { await pool.query(PG_SCHEMA); },
    close: () => pool.end(),
  };
}

export async function openStore(cfg) {
  if (cfg.databaseUrl) { const s = await openPostgres(cfg.databaseUrl); if (cfg.autoMigrate) await s.migrate(); return s; }
  return openSqlite(cfg.dbPath);
}

// Fixed-window rate limit stored in the database, so it holds across serverless instances.
export async function rateHit(db, key, limit, windowSec) {
  const w = Math.floor(Date.now() / 1000 / windowSec);
  const r = await db.run(`INSERT INTO rate_limits(k, window_start, n) VALUES (?, ?, 1)
    ON CONFLICT(k) DO UPDATE SET n = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.n + 1 ELSE 1 END,
    window_start = excluded.window_start RETURNING n`, [key, w]);
  return Number(r.rows[0]?.n ?? 1) <= limit;
}
