// Shared end-to-end HTTP suite. Runs against SQLite (http.test.js) and real Postgres via PGlite (pg.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './harness.js';
import { fakeOneClick, TOKENS } from './fixtures.js';

const USDC_NEAR = TOKENS[0].assetId, USDC_BASE = TOKENS[1].assetId, XLM = TOKENS[4].assetId;
const EVM = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D';

export function defineSuite(label, getOpts) {
  const boot = async (extra = {}) => start({ ...(await getOpts()), ...extra });
  async function merchantWithProduct(t, price = '2') {
    const { accessKey } = await t.rt.service.createMerchant({ name: 'Ferry Sample Store' });
    assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey } })).status, 200);
    const s = await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_NEAR, payoutRecipient: 'ferry-sample.near' } });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const p = await t.req('/api/merchant/products', { method: 'POST', body: { name: 'Sample notebook', price } });
    assert.equal(p.status, 201); return p.data.product;
  }
  const newCheckout = async (t, prod) => (await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).data.checkoutPath.split('/').pop();
  const quote = (t, secret, body = {}) => t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: EVM, ...body } });
  const orderId = async (t, secret) => (await t.req(`/api/checkout/${secret}`)).data.id;

  test(`[${label}] auth, CSRF and authorization guards`, async () => {
    const t = await boot();
    try {
      assert.equal((await t.req('/api/merchant')).status, 401);
      assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey: 'fk_wrongwrongwrongwrongwrong' } })).status, 401);
      const { accessKey } = await t.rt.service.createMerchant({ name: 'S' });
      assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey }, headers: { origin: 'https://evil.example' } })).status, 403);
      assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey } })).status, 200);
      assert.equal((await t.req('/api/merchant', { method: 'PUT', body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
      const r = await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_BASE, payoutRecipient: 'ferry-sample.near' } });
      assert.equal(r.status, 400); assert.match(r.data.error, /0x-prefixed/);
      assert.equal((await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: 'nep141:btc.omft.near', payoutRecipient: 'bc1q0000' } })).status, 400); // unsupported payout chain
      assert.equal((await t.req('/api/merchant/products', { method: 'POST', body: { name: 'x', price: '1' } })).status, 409); // no payout yet
      assert.equal((await t.req('/api/merchant', { method: 'PUT', body: 'x'.repeat(70000) })).status, 413);
      assert.equal((await t.req('/api/dev/bootstrap', { method: 'POST', body: {} })).status, 404); // no public bootstrap route
      const h = await t.req('/', { raw: true });
      assert.match(h.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(h.headers.get('x-frame-options'), 'DENY');
    } finally { await t.close(); }
  });

  test(`[${label}] order → exact-output quote → paid only after verified SUCCESS; survives restart`, async () => {
    const t = await boot();
    let secret;
    try {
      const prod = await merchantWithProduct(t);
      secret = await newCheckout(t, prod);
      assert.ok(secret.startsWith('chk_'));
      const view = await t.req(`/api/checkout/${secret}`);
      assert.equal(view.data.amount.base, '2000000'); assert.equal(view.data.status, 'open'); assert.ok(!JSON.stringify(view.data).includes(secret));
      assert.equal((await quote(t, secret, { refundTo: 'ferry-sample.near' })).status, 400); // wrong-chain refund refused before 1Click
      assert.equal(t.fake.calls.filter((c) => c.path === '/v0/quote').length, 0, 'invalid refund must not reach the provider');
      const q = await quote(t, secret);
      assert.equal(q.status, 201, JSON.stringify(q.data));
      const sent = JSON.parse(t.fake.calls.find((c) => c.path === '/v0/quote').body);
      assert.deepEqual([sent.swapType, sent.amount, sent.recipient, sent.dry, sent.depositType, sent.recipientType], ['EXACT_OUTPUT', '2000000', 'ferry-sample.near', false, 'ORIGIN_CHAIN', 'DESTINATION_CHAIN']);
      const dep = q.data.quotes[0].depositAddress;
      assert.equal(q.data.status, 'awaiting_deposit');
      assert.equal(q.data.quotes[0].amountInFormatted, '2.025107'); // from the real dry-quote shape
      assert.equal((await t.req(`/api/checkout/${secret}/paid`, { method: 'POST', body: { txHash: '0xabc' } })).status, 404);
      const qr = await t.req(`/api/checkout/${secret}/qr/${q.data.quotes[0].id}.svg`, { raw: true });
      assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type'), /svg/); assert.match(qr.text, /^<svg/);
      t.fake.setStatus(dep, { status: 'PROCESSING' });
      assert.equal((await t.req(`/api/checkout/${secret}/status`)).data.status, 'processing');
      assert.equal((await quote(t, secret, { replace: true })).status, 409); // blocked while processing
      t.fake.setStatus(dep, { status: 'SUCCESS', swapDetails: { amountOut: '2000000', amountOutFormatted: '2.0' } });
      await t.rt.service.refreshOrder(await orderId(t, secret), { force: true });
      const paid = await t.req(`/api/checkout/${secret}`);
      assert.equal(paid.data.status, 'paid'); assert.equal(paid.data.quotes[0].verified, true);
    } finally { await t.close(); }
    if (label === 'sqlite') {
      const t2 = await start({ dbPath: t.dbPath });
      try { const v = await t2.req(`/api/checkout/${secret}`); assert.equal(v.data.status, 'paid'); assert.equal(v.data.amount.base, '2000000'); } finally { await t2.close(); }
    }
  });

  test(`[${label}] SUCCESS whose proof differs from the stored quote is never marked paid`, async () => {
    const mutations = {
      recipient: (r) => (r.quoteRequest.recipient = 'attacker.near'),
      refundTo: (r) => (r.quoteRequest.refundTo = '0x000000000000000000000000000000000000dEaD'),
      depositMemo: (r) => (r.quote.depositMemo = 'OTHER-MEMO'),
      amountIn: (r) => (r.quote.amountIn = '1'),
      minAmountIn: (r) => (r.quote.minAmountIn = '1'),
      originAsset: (r) => (r.quoteRequest.originAsset = 'nep141:wrap.near'),
      amount: (r) => (r.quoteRequest.amount = '1999999'),
      signature: (r) => (r.signature = 'ed25519:forged'),
    };
    const t = await boot();
    try {
      const prod = await merchantWithProduct(t);
      for (const [name, mut] of Object.entries(mutations)) {
        const secret = await newCheckout(t, prod);
        const q = await quote(t, secret); assert.equal(q.status, 201);
        const dep = q.data.quotes[0].depositAddress;
        const proof = structuredClone(t.fake.quotes.get(dep)); mut(proof);
        t.fake.setStatus(dep, { status: 'SUCCESS', quoteResponse: proof, swapDetails: { amountOut: '2000000' } });
        await t.rt.service.refreshOrder(q.data.id, { force: true });
        const v = await t.req(`/api/checkout/${secret}`);
        assert.equal(v.data.status, 'needs_review', name); assert.equal(v.data.quotes[0].verified, false, name);
      }
      // Settled below the order amount.
      const secret = await newCheckout(t, prod); const q = await quote(t, secret);
      t.fake.setStatus(q.data.quotes[0].depositAddress, { status: 'SUCCESS', swapDetails: { amountOut: '1999999' } });
      await t.rt.service.refreshOrder(q.data.id, { force: true });
      assert.equal((await t.req(`/api/checkout/${secret}`)).data.status, 'needs_review');
    } finally { await t.close(); }
  });

  test(`[${label}] quote responses that do not match the request are rejected and not stored`, async () => {
    const cases = {
      recipient: (r) => (r.quoteRequest.recipient = 'attacker.near'),
      refundTo: (r) => (r.quoteRequest.refundTo = '0x000000000000000000000000000000000000dEaD'),
      amountOut: (r) => (r.quote.amountOut = '1999999'),
      minAmountOut: (r) => (r.quote.minAmountOut = '1'),
      minAmountInAboveAmountIn: (r) => (r.quote.minAmountIn = String(BigInt(r.quote.amountIn) + 1n)),
      decimalAmountIn: (r) => (r.quote.amountIn = '2.025107'),
      missingDeposit: (r) => delete r.quote.depositAddress,
      dryEcho: (r) => (r.quoteRequest.dry = true),
    };
    for (const [name, mut] of Object.entries(cases)) {
      const t = await boot({ fake: fakeOneClick({ tamperQuote: mut }) });
      try {
        const prod = await merchantWithProduct(t); const secret = await newCheckout(t, prod);
        const q = await quote(t, secret);
        assert.equal(q.status, 502, name); assert.equal(q.data.code, 'QUOTE_MISMATCH', name);
        assert.equal((await t.req(`/api/checkout/${secret}`)).data.quotes.length, 0, name);
      } finally { await t.close(); }
    }
  });

  test(`[${label}] quote lifecycle: single-flight, explicit replacement, cap, memo chains, decimal drift`, async () => {
    const fake = fakeOneClick();
    const t = await boot({ fake });
    try {
      const prod = await merchantWithProduct(t);
      const secret = await newCheckout(t, prod);
      const [a, b] = await Promise.all([quote(t, secret), quote(t, secret)]);
      const codes = [a.status, b.status].sort();
      assert.deepEqual(codes, [201, 409], JSON.stringify([a.data, b.data]));
      assert.equal(fake.quotes.size, 1);
      const live = await quote(t, secret);
      assert.equal(live.status, 409); assert.equal(live.data.code, 'LIVE_QUOTE_EXISTS');
      const r = await quote(t, secret, { replace: true }); assert.equal(r.status, 201); assert.equal(r.data.quotes.length, 2);
      for (let i = 0; i < 3; i++) assert.equal((await quote(t, secret, { replace: true })).status, 201);
      // 6 quotes per order max (5 created + 1 lost race counted? no: losing request never reserved because lease failed)
      const capHit = [];
      for (let i = 0; i < 3; i++) capHit.push((await quote(t, secret, { replace: true })).status);
      assert.ok(capHit.includes(429), JSON.stringify(capHit));
      // MEMO-only chain gets depositMode MEMO and a memo is required.
      const s2 = await newCheckout(t, prod);
      const m = await quote(t, s2, { originAssetId: XLM, refundTo: 'GSAMPLESTELLARADDRESSFERRY' });
      assert.equal(m.status, 201, JSON.stringify(m.data)); assert.match(m.data.quotes[0].depositMemo, /FERRYSAMPLEMEMO/);
      assert.equal(JSON.parse(fake.calls.filter((c) => c.path === '/v0/quote').at(-1).body).depositMode, 'MEMO');
      // Output-token decimals changed upstream after order creation → refuse to quote.
      const s3 = await newCheckout(t, prod);
      fake.state.tokens[0].decimals = 18; await t.rt.tokens.list({ force: true });
      const d = await quote(t, s3); assert.equal(d.status, 409); assert.equal(d.data.code, 'DECIMALS_CHANGED');
    } finally { await t.close(); }
  });

  test(`[${label}] a second settled deposit after payment is flagged as an extra payment`, async () => {
    const t = await boot();
    try {
      const prod = await merchantWithProduct(t); const secret = await newCheckout(t, prod);
      const q1 = await quote(t, secret); const q2 = await quote(t, secret, { replace: true });
      const [d1, d2] = q2.data.quotes.map((q) => q.depositAddress);
      t.fake.setStatus(d1, { status: 'SUCCESS', swapDetails: { amountOut: '2000000' } });
      await t.rt.service.refreshOrder(q1.data.id, { force: true });
      assert.equal((await t.req(`/api/checkout/${secret}`)).data.status, 'paid');
      t.fake.setStatus(d2, { status: 'SUCCESS', swapDetails: { amountOut: '2000000' } });
      await t.rt.service.refreshOrder(q1.data.id, { force: true });
      const v = await t.req(`/api/checkout/${secret}`);
      assert.equal(v.data.status, 'paid'); assert.equal(v.data.extraPayment, true); assert.match(v.data.statusNote, /refund/);
    } finally { await t.close(); }
  });

  test(`[${label}] payout change does not alter existing orders`, async () => {
    const t = await boot();
    try {
      const prod = await merchantWithProduct(t); const secret = await newCheckout(t, prod);
      await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_BASE, payoutRecipient: EVM } });
      const v = await t.req(`/api/checkout/${secret}`);
      assert.equal(v.data.recipient, 'ferry-sample.near'); assert.equal(v.data.amount.assetId, USDC_NEAR);
      assert.equal((await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).status, 409);
    } finally { await t.close(); }
  });

  test(`[${label}] NEAR AI: unconfigured, truncated, forbidden-field and approved paths`, async () => {
    const t = await boot();
    try {
      await merchantWithProduct(t);
      const r = await t.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal(r.status, 503); assert.equal(r.data.code, 'NEAR_AI_NOT_CONFIGURED');
      assert.equal(t.fake.calls.filter((c) => c.path === '/v1/chat/completions').length, 0);
    } finally { await t.close(); }
    const fake = fakeOneClick();
    const t2 = await boot({ aiKey: 'sample-key-not-real', fake });
    try {
      await merchantWithProduct(t2);
      fake.state.aiFinish = 'length';
      const tr = await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal(tr.status, 502); assert.equal(tr.data.code, 'NEAR_AI_TRUNCATED');
      fake.state.aiFinish = 'stop';
      const sentBody = JSON.parse(fake.calls.find((c) => c.path === '/v1/chat/completions').body);
      assert.equal(sentBody.response_format.json_schema.strict, true); assert.equal(sentBody.chat_template_kwargs.enable_thinking, false);
      assert.ok(!JSON.stringify(sentBody).includes('ferry-sample.near')); // payout recipient never sent to the model
      fake.state.aiDraft = { ...fakeOneClick.aiDraft, payoutRecipient: 'attacker.near' };
      const bad = await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal(bad.data.draft.status, 'invalid'); assert.match(bad.data.draft.validation.errors.join(), /forbidden/);
      assert.equal((await t2.req(`/api/merchant/ai/drafts/${bad.data.draft.id}/approve`, { method: 'POST', body: { fields: ['tagline'] } })).status, 409);
      fake.state.aiDraft = structuredClone(fakeOneClick.aiDraft);
      const before = (await t2.req('/api/merchant')).data.merchant;
      const ok = await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal(ok.status, 201); assert.equal(ok.data.draft.status, 'pending');
      assert.equal(fake.calls.filter((c) => c.path === '/v1/chat/completions').at(-1).auth, 'Bearer sample-key-not-real');
      assert.deepEqual((await t2.req('/api/merchant')).data.merchant, before);
      const id = ok.data.draft.id;
      assert.equal((await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: ['tagline', 'product:0'] } })).status, 400);
      assert.equal((await t2.req('/api/merchant')).data.merchant.profile.tagline, undefined);
      const ap = await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: ['tagline', 'product:0', 'suggestedAssetIds'], productPrices: { 0: '12.5' } } });
      assert.equal(ap.status, 200, JSON.stringify(ap.data));
      assert.equal(ap.data.merchant.profile.tagline, 'Hand-bound notebooks, shipped worldwide');
      assert.equal(ap.data.merchant.payout.recipient, 'ferry-sample.near');
      assert.equal(ap.data.createdProducts[0].priceBase, '12500000');
      assert.ok(ap.data.merchant.acceptedAssets.includes(USDC_BASE));
      assert.equal((await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: [] } })).status, 409);
    } finally { await t2.close(); }
  });

  test(`[${label}] rate limits are enforced from the database`, async () => {
    const t = await boot();
    try {
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await t.req('/api/auth/login', { method: 'POST', body: { accessKey: 'fk_wrongwrongwrongwrongwrong' } })).status);
      assert.ok(statuses.includes(429), JSON.stringify(statuses));
    } finally { await t.close(); }
  });
}
