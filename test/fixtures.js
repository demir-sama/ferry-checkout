// TEST FIXTURES ONLY. Synthetic 1Click and NEAR AI responses used to exercise logic offline.
// Shapes follow https://1click.chaindefuser.com/docs/v0/openapi.yaml; values are fabricated and labelled as such.
export const TOKENS = [
  { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 90000, priceUpdatedAt: '2026-11-07T00:00:00Z' },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3, priceUpdatedAt: '2026-11-07T00:00:00Z' },
];

export function fakeOneClick({ tamper } = {}) {
  const quotes = new Map(); const statuses = new Map(); let n = 0;
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url); calls.push({ path: u.pathname, method: init.method, auth: init.headers?.authorization });
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v0/tokens') return json(TOKENS);
    if (u.pathname === '/v0/quote') {
      const req = JSON.parse(init.body);
      if (req.refundTo === 'reject-me') return json({ message: 'refundTo is not valid' }, 400);
      const depositAddress = `0xFAKEDEPOSIT${String(++n).padStart(30, '0')}`;
      const resp = { correlationId: `fixture-${n}`, timestamp: new Date().toISOString(), signature: `ed25519:FIXTURE${n}`,
        quoteRequest: { ...req, ...(tamper?.(req) || {}) },
        quote: { depositAddress, amountIn: '2025044', amountInFormatted: '2.025044', amountInUsd: '2.02', minAmountIn: '2004839', amountOut: req.amount, amountOutFormatted: '2.0', amountOutUsd: '2', minAmountOut: req.amount, deadline: req.deadline, timeEstimate: 35, refundFee: '2400' } };
      quotes.set(depositAddress, resp); statuses.set(depositAddress, { status: 'PENDING_DEPOSIT' });
      return json(resp);
    }
    if (u.pathname === '/v0/status') {
      const a = u.searchParams.get('depositAddress'); const q = quotes.get(a);
      if (!q) return json({ message: 'Deposit address not found' }, 404);
      const st = statuses.get(a);
      return json({ correlationId: 'fixture-status', quoteResponse: st.quoteResponse || q, status: st.status, updatedAt: new Date().toISOString(),
        swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...(st.swapDetails || {}) } });
    }
    if (u.pathname === '/v1/chat/completions') return json({ id: 'fixture-chat', model: 'fixture-model', choices: [{ message: { content: JSON.stringify(fakeOneClick.aiDraft) } }] });
    return json({ message: 'not found' }, 404);
  }
  return { fetchImpl, quotes, statuses, calls, setStatus: (addr, s) => statuses.set(addr, { ...statuses.get(addr), ...s }) };
}

fakeOneClick.aiDraft = {
  tagline: 'Hand-bound notebooks, shipped worldwide', about: 'A two-person bindery making durable notebooks.', buttonLabel: 'Buy with crypto', accent: 'ocean',
  productCopy: [{ name: 'A5 Notebook', description: 'Lay-flat, 160 pages.' }], faq: [{ q: 'Do you ship abroad?', a: 'Yes.' }],
  suggestedAssetIds: ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'],
};
