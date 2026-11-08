// SQLite persistence (node:sqlite). Orders, quotes, status history, drafts and token cache survive restarts.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_key_hash TEXT NOT NULL UNIQUE,
  payout_asset_id TEXT,
  payout_chain TEXT,
  payout_symbol TEXT,
  payout_decimals INTEGER,
  payout_recipient TEXT,
  accepted_assets TEXT NOT NULL DEFAULT '[]',
  profile TEXT NOT NULL DEFAULT '{}',
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_base TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  checkout_secret_hash TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  product_id TEXT,
  item_name TEXT NOT NULL,
  item_description TEXT NOT NULL DEFAULT '',
  amount_out_base TEXT NOT NULL,
  dest_asset_id TEXT NOT NULL,
  dest_chain TEXT NOT NULL,
  dest_symbol TEXT NOT NULL,
  dest_decimals INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  accepted_assets TEXT NOT NULL,
  status TEXT NOT NULL,
  paid_quote_id TEXT,
  status_note TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  origin_asset_id TEXT NOT NULL,
  origin_symbol TEXT NOT NULL,
  origin_chain TEXT NOT NULL,
  origin_decimals INTEGER NOT NULL,
  refund_to TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deposit_memo TEXT,
  amount_in TEXT NOT NULL,
  min_amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  deadline TEXT NOT NULL,
  time_estimate INTEGER,
  refund_fee TEXT,
  signature TEXT NOT NULL,
  correlation_id TEXT,
  raw TEXT NOT NULL,
  remote_status TEXT NOT NULL DEFAULT 'PENDING_DEPOSIT',
  remote_detail TEXT,
  verified INTEGER,
  verify_problems TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (deposit_address, deposit_memo)
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_drafts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  brief TEXT NOT NULL,
  model TEXT NOT NULL,
  draft TEXT NOT NULL,
  validation TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_order ON quotes(order_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
