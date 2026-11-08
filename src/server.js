// Wires config, storage, 1Click, NEAR AI and the HTTP handler. Run directly for a local long-lived server.
import http from 'node:http';
import { loadConfig } from './config.js';
import { openStore } from './db.js';
import { createOneClick } from './oneclick.js';
import { createTokenCache } from './tokens.js';
import { createService } from './service.js';
import { createNearAi, createAssistant } from './ai.js';
import { createApp } from './app.js';

export async function buildRuntime({ cfg = loadConfig(), db, fetchImpl = fetch, log = (...a) => console.log(new Date().toISOString(), ...a) } = {}) {
  db ||= await openStore(cfg);
  const oneClick = createOneClick({ baseUrl: cfg.oneClickBase, jwt: cfg.oneClickJwt, fetchImpl });
  const tokens = createTokenCache({ db, oneClick, log });
  const service = createService({ db, cfg, oneClick, tokens, log });
  const ai = createNearAi({ baseUrl: cfg.nearAiBase, apiKey: cfg.nearAiKey, model: cfg.nearAiModel, maxTokens: cfg.nearAiMaxTokens, fetchImpl });
  const assistant = createAssistant({ db, ai, tokens, service });
  const handler = createApp({ db, cfg, service, assistant, ai, tokens, oneClick, log });
  return { cfg, db, oneClick, tokens, service, ai, assistant, handler };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rt = await buildRuntime();
  const { cfg, service, db } = rt;
  // Local development only (config refuses FERRY_DEV in production). The key is printed to this terminal, never served.
  if (cfg.devMode && !(await db.get('SELECT 1 AS x FROM merchants LIMIT 1'))) {
    const { accessKey } = await service.createMerchant({ name: 'Sample Store (local dev)', isSample: true });
    console.log(`\n[dev] Created a SAMPLE merchant for local development. Access key (shown once):\n      ${accessKey}\n`);
  }
  http.createServer(rt.handler).listen(cfg.port, cfg.host, () => {
    console.log(`Ferry listening on http://${cfg.host}:${cfg.port}  (storage ${db.kind}; NEAR AI ${rt.ai.configured ? 'configured' : 'NOT configured'}; 1Click ${rt.oneClick.authenticated ? 'partner JWT' : 'unauthenticated'})`);
  });
  const tick = async () => { try { await service.pollActive(); } catch (e) { console.error('poller', e.message); } setTimeout(tick, cfg.pollIntervalMs).unref(); };
  setTimeout(tick, 2000).unref();
}
