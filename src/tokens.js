// Live supported-asset discovery: in-memory TTL cache, persisted fallback copy in the database.
import { now } from './db.js';

export function normalizeTokens(list) {
  if (!Array.isArray(list)) throw new Error('token list is not an array');
  return list
    .filter((t) => t && typeof t.assetId === 'string' && t.assetId.length <= 200 && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36 && typeof t.blockchain === 'string' && typeof t.symbol === 'string')
    .map((t) => ({ assetId: t.assetId, symbol: t.symbol.slice(0, 24), blockchain: t.blockchain.slice(0, 24), decimals: t.decimals,
      priceUsd: typeof t.price === 'number' ? t.price : null, priceUpdatedAt: t.priceUpdatedAt ?? null, contractAddress: t.contractAddress ?? null }));
}

export function createTokenCache({ db, oneClick, ttlMs = 5 * 60 * 1000, log = () => {} }) {
  let mem = null;
  let inflight = null;
  async function refresh() {
    try {
      const fresh = normalizeTokens(await oneClick.tokens());
      mem = { at: Date.now(), fetchedAt: now(), list: fresh, source: 'live' };
      await db.run('INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at', ['tokens', JSON.stringify(fresh), mem.fetchedAt]);
      return mem;
    } catch (e) {
      log('token refresh failed:', e.message);
      const row = await db.get('SELECT v, updated_at FROM kv WHERE k = ?', ['tokens']);
      if (row) { mem = { at: Date.now() - ttlMs + 30000, fetchedAt: row.updated_at, list: JSON.parse(row.v), source: 'cached' }; return mem; }
      throw Object.assign(new Error('Supported asset list is unavailable (1Click unreachable and no cached copy).'), { status: 503 });
    }
  }
  async function list({ force = false } = {}) {
    if (!force && mem && Date.now() - mem.at < ttlMs) return mem;
    inflight ||= refresh().finally(() => { inflight = null; });
    return inflight;
  }
  async function get(assetId) { return (await list()).list.find((t) => t.assetId === assetId) || null; }
  return { list, get };
}
