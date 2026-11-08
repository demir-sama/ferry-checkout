// Runtime configuration. Secrets come only from the server environment and are never sent to browsers.
import path from 'node:path';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL_ENV);
  const port = Number(env.PORT || 4317);
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  const cfg = {
    production,
    port, host: env.HOST || '127.0.0.1',
    publicBaseUrl: (env.PUBLIC_BASE_URL || vercelUrl || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || '',
    autoMigrate: env.FERRY_AUTO_MIGRATE === '1',
    dbPath: env.FERRY_DB || path.resolve('data/ferry.db'),
    devMode: env.FERRY_DEV === '1' && !production,
    oneClickBase: (env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com').replace(/\/$/, ''),
    oneClickJwt: env.ONECLICK_JWT || '',
    nearAiBase: (env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, ''),
    nearAiKey: env.NEAR_AI_API_KEY || '',
    nearAiModel: env.NEAR_AI_MODEL || 'Qwen/Qwen3.8-27B',
    nearAiMaxTokens: clamp(Number(env.NEAR_AI_MAX_TOKENS || 1500), 300, 4000),
    cronSecret: env.CRON_SECRET || '',
    quoteTtlMinutes: clamp(Number(env.QUOTE_TTL_MINUTES || 30), 10, 120),
    slippageBps: clamp(Number(env.SLIPPAGE_BPS || 100), 10, 500),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 15000),
    orderTtlHours: clamp(Number(env.ORDER_TTL_HOURS || 24), 1, 24 * 30),
  };
  if (production) {
    // Upstream endpoints are operator-configured only; require https so a misconfiguration cannot downgrade or redirect traffic.
    for (const k of ['oneClickBase', 'nearAiBase', 'publicBaseUrl']) if (!cfg[k].startsWith('https://')) throw new Error(`${k} must be https in production`);
    if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required in production (SQLite is local-only)');
  }
  return cfg;
}
const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo);
