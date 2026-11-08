// Entry point: wires config, database, 1Click, NEAR AI and the HTTP server, plus a background status poller.
import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createOneClick } from './oneclick.js';
import { createTokenCache } from './tokens.js';
import { createService } from './service.js';
import { createNearAi, createAssistant } from './ai.js';
import { createApp } from './app.js';

export function buildRuntime({ cfg = loadConfig(), fetchImpl = fetch, log = (...a) => console.log(new Date().toISOString(), ...a) } = {}) {
  const db = openDb(cfg.dbPath);
  const oneClick = createOneClick({ baseUrl: cfg.oneClickBase, jwt: cfg.oneClickJwt, fetchImpl });
  const tokens = createTokenCache({ db, oneClick, log });
  const service = createService({ db, cfg, oneClick, tokens, log });
  const ai = createNearAi({ baseUrl: cfg.nearAiBase, apiKey: cfg.nearAiKey, model: cfg.nearAiModel, fetchImpl });
  const assistant = createAssistant({ db, ai, tokens, service });
  const handler = createApp({ db, cfg, service, assistant, ai, tokens, oneClick, log });
  return { cfg, db, oneClick, tokens, service, ai, assistant, handler };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rt = buildRuntime();
  const { cfg, service, db } = rt;
  if (cfg.devMode && !db.prepare('SELECT 1 FROM merchants LIMIT 1').get()) {
    const { accessKey } = service.createMerchant({ name: 'Sample Store (local dev)', isSample: true });
    console.log(`\n[dev] Created a SAMPLE merchant for local development. Access key (shown once):\n      ${accessKey}\n`);
  }
  http.createServer(rt.handler).listen(cfg.port, cfg.host, () => {
    console.log(`Ferry listening on http://${cfg.host}:${cfg.port}  (NEAR AI ${rt.ai.configured ? 'configured' : 'NOT configured'}; 1Click ${rt.oneClick.authenticated ? 'partner JWT' : 'unauthenticated'})`);
  });
  const tick = async () => { try { await service.pollActive(); } catch (e) { console.error('poller', e.message); } setTimeout(tick, cfg.pollIntervalMs).unref(); };
  setTimeout(tick, 2000).unref();
}
