// TEST FIXTURES ONLY — clearly synthetic. The quote shape is cloned from a REAL dry-run 1Click response captured
// on 2026-11-08 (test/data/live-dry-quote-base-usdc.json). Fields a dry quote omits (depositAddress, deadline,
// timeWhenInactive) and every status response are SYNTHETIC, built to the OpenAPI GetExecutionStatusResponse
// schema (https://1click.chaindefuser.com/docs/v0/openapi.yaml). Deposit addresses are labelled FERRYSAMPLE.
import fs from 'node:fs';
const LIVE = JSON.parse(fs.readFileSync(new URL('./data/live-dry-quote-base-usdc.json', import.meta.url)));
export const LIVE_DRY_QUOTE = LIVE;

export const TOKENS = [
  { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 90000, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:stellar-sample.omft.near', decimals: 7, blockchain: 'stellar', symbol: 'XLM', price: 0.1, priceUpdatedAt: '2026-11-07T00:00:00Z' },
];

export function fakeOneClick({ tamperQuote, tokens = TOKENS } = {}) {
  const quotes = new Map(); const statuses = new Map(); let n = 0;
  const calls = []; const state = { tokens: structuredClone(tokens), aiDraft: structuredClone(fakeOneClick.aiDraft), aiNarrative: null, aiFinish: 'stop', statusHttp: 0, omitUpdatedAt: false };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url); calls.push({ path: u.pathname, method: init.method, auth: init.headers?.authorization, body: init.body });
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v0/tokens') return json(state.tokens);
    if (u.pathname === '/v0/quote') {
      const req = JSON.parse(init.body);
      if (req.refundTo === 'reject-me') return json({ message: 'refundTo is not valid' }, 400);
      await new Promise((r) => setTimeout(r, 30)); // simulate network so concurrent requests overlap
      const depositAddress = `0xFERRYSAMPLE${String(++n).padStart(28, '0')}`;
      const resp = structuredClone(LIVE);
      resp.correlationId = `ferry-sample-${n}`; resp.signature = `ed25519:FERRYSAMPLESIG${n}`; resp.timestamp = new Date().toISOString();
      resp.quoteRequest = { ...resp.quoteRequest, ...req };
      resp.quote = { ...resp.quote, depositAddress, amountOut: req.amount, minAmountOut: req.amount, deadline: req.deadline, timeWhenInactive: req.deadline };
      if (req.depositMode === 'MEMO') resp.quote.depositMemo = `FERRYSAMPLEMEMO${n}`;
      tamperQuote?.(resp, req);
      quotes.set(depositAddress, resp); statuses.set(depositAddress, { status: 'PENDING_DEPOSIT' });
      return json(resp);
    }
    if (u.pathname === '/v0/status') {
      if (state.statusHttp) return json({ message: state.statusMessage || 'sample status outage' }, state.statusHttp);
      const a = u.searchParams.get('depositAddress'); const q = quotes.get(a);
      if (!q) return json({ message: 'Deposit address not found' }, 404);
      const st = statuses.get(a);
      const body = { correlationId: 'ferry-sample-status', quoteResponse: st.quoteResponse || q, status: st.status,
        swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...(st.swapDetails || {}) } };
      if (!state.omitUpdatedAt) body.updatedAt = new Date().toISOString();
      return json(body);
    }
    if (u.pathname === '/v1/chat/completions') {
      if (state.aiHttp) return json({ error: 'sample upstream error' }, state.aiHttp);
      let content = state.aiDraft;
      try { const req = JSON.parse(init.body || '{}'); if (req.response_format?.json_schema?.name === 'ferry_case_narrative') content = state.aiNarrative ?? state.aiDraft; } catch { /* sample body stays the draft */ }
      return json({ id: 'ferry-sample-chat', model: 'ferry-sample-model', choices: [{ finish_reason: state.aiFinish, message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 700, completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 0 } } });
    }
    return json({ message: 'not found' }, 404);
  }
  return { fetchImpl, quotes, statuses, calls, state, setStatus: (addr, s) => statuses.set(addr, { ...statuses.get(addr), ...s }) };
}

fakeOneClick.aiDraft = {
  tagline: 'Hand-bound notebooks, shipped worldwide', about: 'A two-person bindery making durable notebooks.', buttonLabel: 'Buy with crypto', accent: 'ocean',
  productCopy: [{ name: 'A5 Notebook', description: 'Lay-flat, 160 pages.' }], faq: [{ q: 'Do you ship abroad?', a: 'Yes.' }],
  suggestedAssetIds: ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'],
};
