// Runtime configuration. Secrets only ever come from the server environment.
import path from 'node:path';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4317),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 4317}`).replace(/\/$/, ''),
    dbPath: env.FERRY_DB || path.resolve('data/ferry.db'),
    devMode: env.FERRY_DEV === '1',
    oneClickBase: (env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com').replace(/\/$/, ''),
    oneClickJwt: env.ONECLICK_JWT || '',           // optional partner JWT, server-side only
    nearAiBase: (env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, ''),
    nearAiKey: env.NEAR_AI_API_KEY || '',           // absent => AI assistant reports "not configured"
    nearAiModel: env.NEAR_AI_MODEL || 'Qwen/Qwen3.6-35B-A3B-FP8',
    quoteTtlMinutes: Math.min(Math.max(Number(env.QUOTE_TTL_MINUTES || 30), 10), 120),
    slippageBps: Math.min(Math.max(Number(env.SLIPPAGE_BPS || 100), 10), 500),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 15000),
    orderTtlHours: Number(env.ORDER_TTL_HOURS || 24),
  };
}
