// Starts a real Ferry HTTP server on a random port over SQLite (default) or real Postgres (PGlite via the wire protocol).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRuntime } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { openSqlite, openPostgres } from '../src/db.js';
import { fakeOneClick } from './fixtures.js';

export async function pgliteServer() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const pgl = await PGlite.create();
  const port = 15432 + Math.floor(Math.random() * 2000);
  const srv = new PGLiteSocketServer({ db: pgl, port, host: '127.0.0.1' });
  await srv.start();
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, stop: async () => { await srv.stop(); await pgl.close(); } };
}

export async function start({ aiKey = '', store = 'sqlite', dbPath, sharedDb, fake = fakeOneClick() } = {}) {
  let db;
  if (store === 'pg') db = sharedDb; // PGlite's socket accepts one client connection, so the suite shares one pool
  else { dbPath ||= path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-')), 'test.db'); db = await openSqlite(dbPath); }
  const cfg = { ...loadConfig({}), dbPath, nearAiKey: aiKey, oneClickBase: 'http://fake-1click', nearAiBase: 'http://fake-ai/v1' };
  const rt = await buildRuntime({ cfg, db, fetchImpl: fake.fetchImpl, log: () => {} });
  const srv = http.createServer(rt.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`; rt.cfg.publicBaseUrl = base;
  let cookie = '';
  const req = async (p, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data, headers: r.headers };
  };
  return { rt, fake, req, dbPath, close: async () => { await new Promise((r) => srv.close(r)); if (store !== 'pg') await rt.db.close(); } };
}
