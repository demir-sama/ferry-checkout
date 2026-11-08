// Live supported-asset discovery with an in-memory TTL cache and a persisted fallback.
import { now } from './db.js';

export function createTokenCache({ db, oneClick, ttlMs = 5 * 60 * 1000, log = () => {} }) {
  let mem = null; // { at, list, source }
  function normalize(list) {
    if (!Array.isArray(list)) throw new Error('token list is not an array');
    return list
      .filter((t) => t && typeof t.assetId === 'string' && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36 && t.blockchain && t.symbol)
      .map((t) => ({ assetId: t.assetId, symbol: String(t.symbol).slice(0, 24), blockchain: String(t.blockchain), decimals: t.decimals,
        priceUsd: typeof t.price === 'number' ? t.price : null, priceUpdatedAt: t.priceUpdatedAt ?? null, contractAddress: t.contractAddress ?? null }));
  }
  async function list({ force = false } = {}) {
    if (!force && mem && Date.now() - mem.at < ttlMs) return mem;
    try {
      const fresh = normalize(await oneClick.tokens());
      mem = { at: Date.now(), fetchedAt: now(), list: fresh, source: 'live' };
      db.prepare('INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at')
        .run('tokens', JSON.stringify(fresh), mem.fetchedAt);
      return mem;
    } catch (e) {
      log('token refresh failed:', e.message);
      const row = db.prepare('SELECT v, updated_at FROM kv WHERE k = ?').get('tokens');
      if (row) { mem = { at: Date.now() - ttlMs + 30000, fetchedAt: row.updated_at, list: JSON.parse(row.v), source: 'cached' }; return mem; }
      throw new Error('Supported asset list is unavailable (1Click unreachable and no cached copy).');
    }
  }
  async function get(assetId) { return (await list()).list.find((t) => t.assetId === assetId) || null; }
  return { list, get };
}
