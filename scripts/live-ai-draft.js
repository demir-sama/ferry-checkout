// One live NEAR AI Cloud draft call through Ferry's real client + validator. Reads NEAR_AI_API_KEY from the
// environment and never prints it. Prints model, finish reason, token usage and validator result.
import { createNearAi, validateDraft } from '../src/ai.js';
import { createOneClick } from '../src/oneclick.js';
import { normalizeTokens } from '../src/tokens.js';
if (!process.env.NEAR_AI_API_KEY) { console.error('NEAR_AI_API_KEY is not set'); process.exit(1); }
const live = normalizeTokens(await createOneClick({ baseUrl: 'https://1click.chaindefuser.com' }).tokens());
const menu = live.filter((t) => ['USDC', 'USDT'].includes(t.symbol)).slice(0, 12).map((t) => `${t.assetId} | ${t.symbol} | ${t.blockchain}`).join('\n');
const ai = createNearAi({ baseUrl: process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1', apiKey: process.env.NEAR_AI_API_KEY, model: process.env.NEAR_AI_MODEL || 'Qwen/Qwen3.8-27B', maxTokens: Number(process.env.NEAR_AI_MAX_TOKENS || 1500) });
const t0 = Date.now();
try {
  const out = await ai.draft({ brief: process.argv[2] || 'Small studio selling two hand-bound notebooks (A5 and pocket). Ships worldwide. Prefers stablecoins.', storeName: 'Sample Bindery (test)', assetMenu: menu });
  const v = validateDraft(out.draft, { liveAssetIds: new Set(live.map((t) => t.assetId)) });
  console.log(JSON.stringify({ live: true, at: new Date().toISOString(), model: out.model, finishReason: out.finishReason, usage: out.usage, ms: Date.now() - t0, responseId: out.responseId,
    validatorOk: v.ok, validatorErrors: v.errors, draft: v.ok ? v.value : null, rawPreview: v.ok ? undefined : out.rawContent?.slice(0, 400) }, null, 2));
} catch (e) { console.log(JSON.stringify({ live: true, ok: false, code: e.code, error: e.message, ms: Date.now() - t0 })); }
