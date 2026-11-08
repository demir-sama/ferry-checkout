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

  test(`[${label}] NEAR AI status wording: key set is never reported as working until a real response succeeds`, async () => {
    const t = await boot();
    try {
      const h = (await t.req('/api/health')).data.nearAi;
      assert.equal(h.status, 'unset'); assert.match(h.label, /Not configured/);
    } finally { await t.close(); }
    const fake = fakeOneClick();
    const t2 = await boot({ aiKey: 'sample-key-not-real', fake });
    try {
      await merchantWithProduct(t2);
      let s = (await t2.req('/api/health')).data.nearAi;
      assert.equal(s.status, 'unverified'); assert.equal(s.label, 'Key set — connection not verified. No successful NEAR AI response yet.');
      assert.doesNotMatch(JSON.stringify(s), /sample-key-not-real|Connected/);
      assert.deepEqual((await t2.req('/api/merchant')).data.nearAi, s);
      fake.state.aiHttp = 401;
      const r = await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal(r.status, 502); assert.equal(r.data.code, 'NEAR_AI_AUTH'); assert.match(r.data.error, /API key rejected/);
      s = (await t2.req('/api/health')).data.nearAi;
      assert.equal(s.status, 'auth_failed'); assert.match(s.label, /rejected the API key/); assert.ok(s.checkedAt);
      fake.state.aiHttp = 503;
      await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
      assert.equal((await t2.req('/api/health')).data.nearAi.status, 'auth_failed'); // non-auth outage does not claim anything new
      fake.state.aiHttp = 0;
      assert.equal((await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } })).status, 201);
      s = (await t2.req('/api/health')).data.nearAi;
      assert.equal(s.status, 'verified'); assert.match(s.label, /^Connected/);
    } finally { await t2.close(); }
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

  test(`[${label}] inbox evidence: provenance, unknowns, contradictions, stale refresh, notes, CSV, isolation`, async () => {
    const t = await boot();
    try {
      const { accessKey: keyA } = await t.rt.service.createMerchant({ name: 'Store A' });
      assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey: keyA } })).status, 200);
      assert.equal((await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_NEAR, payoutRecipient: 'ferry-sample.near' } })).status, 200);
      const inv = await t.req('/api/merchant/orders', { method: 'POST', body: { title: '=1+1', description: 'note', amount: '2' } });
      assert.equal(inv.status, 201, JSON.stringify(inv.data));
      const listed = await t.req('/api/merchant/orders');
      const orderA = listed.data.orders.find((o) => o.item === '=1+1');
      assert.equal(orderA.lane, 'open');
      const created = await t.req('/api/merchant/orders', { method: 'POST', body: { title: 'Notebook', description: '', amount: '2' } });
      const checkoutUrl = created.data.checkoutUrl;
      const sec = checkoutUrl.split('/').pop();
      const q = await quote(t, sec);
      assert.equal(q.status, 201, JSON.stringify(q.data));
      const stored = await t.rt.db.get('SELECT raw, signature, correlation_id, amount_in, min_amount_in FROM quotes WHERE id=?', [q.data.quotes[0].id]);
      const raw = JSON.parse(stored.raw);
      assert.equal(raw.signature, stored.signature);
      assert.equal(raw.correlationId, stored.correlation_id);
      assert.ok(BigInt(stored.amount_in) > BigInt(stored.min_amount_in));
      const dep = q.data.quotes[0].depositAddress;
      const mid = ((BigInt(q.data.quotes[0].minAmountIn) + BigInt(q.data.quotes[0].amountIn)) / 2n).toString();
      t.fake.state.omitUpdatedAt = true;
      t.fake.setStatus(dep, { status: 'PROCESSING', swapDetails: { depositedAmount: mid } });
      await t.rt.service.refreshOrder(q.data.id, { force: true });
      let view = await t.req(`/api/merchant/orders/${q.data.id}`);
      assert.equal(view.data.status, 'processing');
      assert.equal(view.data.quotes[0].evidence.deposited.known, true);
      assert.equal(view.data.quotes[0].evidence.providerUpdatedAt, null);
      assert.equal(view.data.quotes[0].evidence.settledOut.known, false);
      assert.ok(view.data.diagnosis.findings.some((f) => f.id === 'within_buffer'));
      assert.ok(!view.data.diagnosis.findings.some((f) => f.id === 'below_minimum'));
      assert.equal(view.data.diagnosis.changesPaymentState, false);
      assert.equal(view.data.diagnosis.label.includes('Deterministic rules'), true);
      t.fake.state.omitUpdatedAt = false;
      t.fake.setStatus(dep, { status: 'SUCCESS', swapDetails: { amountOut: '2000000', depositedAmount: '1000' } });
      await t.rt.service.refreshOrder(q.data.id, { force: true });
      view = await t.req(`/api/merchant/orders/${q.data.id}`);
      assert.equal(view.data.status, 'paid');
      assert.equal(view.data.diagnosis.lane, 'attention');
      assert.ok(view.data.diagnosis.findings.some((f) => f.id === 'contradictory_deposit'));
      assert.ok(view.data.diagnosis.unknowns.every((u) => u.value === 'UNKNOWN'));
      const before = view.data.status;
      const note = await t.req(`/api/merchant/orders/${q.data.id}/notes`, { method: 'POST', body: { body: 'Reviewed the mismatch. No refund sent.', status: 'refunded', executeRefund: true } });
      assert.equal(note.status, 201, JSON.stringify(note.data));
      assert.equal(note.data.note.status, before);
      view = await t.req(`/api/merchant/orders/${q.data.id}`);
      assert.equal(view.data.status, 'paid');
      assert.equal(view.data.amount.base, '2000000');
      assert.equal(view.data.notes.at(-1).body, 'Reviewed the mismatch. No refund sent.');
      const otherSecret = await newCheckout(t, (await t.req('/api/merchant/products', { method: 'POST', body: { name: 'Second', price: '2' } })).data.product);
      const q2 = await quote(t, otherSecret);
      t.fake.state.statusHttp = 503;
      await t.rt.service.refreshOrder(q2.data.id, { force: true });
      const failed = await t.req(`/api/merchant/orders/${q2.data.id}`);
      assert.equal(failed.data.quotes[0].remoteStatus, 'PENDING_DEPOSIT');
      assert.equal(failed.data.diagnosis.freshness.state, 'refresh_failed');
      assert.match(failed.data.quotes[0].evidence.pollError, /503|outage|status/i);
      assert.equal(failed.data.status, 'awaiting_deposit');
      await t.rt.db.run('UPDATE quotes SET last_polled_at=?, remote_detail=? WHERE id=?', ['2020-01-01T00:00:00.000Z', '{}', q2.data.quotes[0].id]);
      const stale = await t.req(`/api/merchant/orders/${q2.data.id}`);
      assert.equal(stale.data.diagnosis.freshness.state, 'stale');
      assert.equal(stale.data.diagnosis.lane, 'attention');
      const csv = await t.req('/api/merchant/reconciliation.csv', { raw: true });
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      assert.match(csv.text, /'=1\+1/);
      assert.doesNotMatch(csv.text, /(^|,|\n)=1\+1/);
      assert.match(csv.text, /UNKNOWN/);
      assert.doesNotMatch(csv.text, /ferry-sample\.near/); // payout recipient is not a CSV column
      const sim = await t.req('/api/simulated-cases');
      assert.equal(sim.data.simulated, true);
      assert.equal(sim.data.liveSettlement, false);
      assert.ok(sim.data.cases.every((c) => c.label === 'SIMULATED' && c.liveSettlement === false));
      assert.equal(sim.data.cases.find((c) => c.id === 'sim-unknown-partial').diagnosis.quotes[0].comparison.shortfallBase, null);
      assert.equal((await t.req('/api/merchant/orders')).data.orders.some((o) => String(o.id).startsWith('ord_simulated')), false);
      const keyBmerchant = await t.rt.service.createMerchant({ name: 'Store B' });
      assert.equal((await t.req('/api/auth/logout', { method: 'POST' })).status, 200);
      assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey: keyBmerchant.accessKey } })).status, 200);
      assert.equal((await t.req(`/api/merchant/orders/${q.data.id}`)).status, 404);
      assert.equal((await t.req(`/api/merchant/orders/${q.data.id}/notes`, { method: 'POST', body: { body: 'stolen note' } })).status, 404);
      assert.equal((await t.req(`/api/merchant/orders/${q.data.id}/explain`, { method: 'POST', body: {} })).status, 404);
      const csvB = await t.req('/api/merchant/reconciliation.csv', { raw: true });
      assert.doesNotMatch(csvB.text, new RegExp(q.data.id));
      assert.equal((await t.req('/api/merchant/orders/ord_nope/explain', { method: 'POST', body: {} })).status, 404);
    } finally { await t.close(); }
  });

  test(`[${label}] NEAR AI order narrative cannot act, and a failed refresh must be admitted`, async () => {
    const fake = fakeOneClick();
    const t = await boot({ aiKey: 'sample-key-not-real', fake });
    try {
      const prod = await merchantWithProduct(t);
      const secret = await newCheckout(t, prod);
      const q = await quote(t, secret);
      const id = q.data.id;
      const evidenceId = `quote:${q.data.quotes[0].id}`;
      fake.state.statusHttp = 503;
      fake.state.aiNarrative = { summary: 'Everything is confirmed and settled.', evidenceCited: [evidenceId], unknowns: ['none'], suggestedReviewStep: 'No action.' };
      const bad = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(bad.status, 200, JSON.stringify(bad.data));
      assert.equal(bad.data.explanation.status, 'invalid');
      assert.equal(bad.data.explanation.narrative, null);
      assert.match(bad.data.explanation.errors.join(' '), /claimIds|allowlist|unexpected/);
      assert.equal(bad.data.unchanged, true);
      assert.equal((await t.req(`/api/merchant/orders/${id}`)).data.status, 'awaiting_deposit');
      const sent = JSON.parse(fake.calls.filter((c) => c.path === '/v1/chat/completions').at(-1).body);
      assert.equal(sent.response_format.json_schema.name, 'ferry_case_narrative');
      assert.equal(sent.response_format.json_schema.strict, true);
      assert.equal(sent.response_format.json_schema.schema.additionalProperties, false);
      assert.deepEqual(sent.response_format.json_schema.schema.required, ['claimIds', 'stepId']);
      assert.equal(sent.tools, undefined);
      assert.equal(sent.chat_template_kwargs.enable_thinking, false);
      assert.doesNotMatch(sent.messages[1].content, /ferry-sample\.near/);
      assert.doesNotMatch(JSON.stringify(sent.messages), new RegExp(EVM));
      const menu = JSON.parse(sent.messages[1].content);
      assert.ok(menu.mandatoryClaimIds.includes('claim:refresh-failed'));
      fake.state.aiNarrative = { claimIds: ['claim:display-amount', 'claim:refresh-failed'], stepId: 'step:read-again-later', executeRefund: true, setStatus: 'paid' };
      const acted = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(acted.data.explanation.status, 'invalid');
      assert.match(acted.data.explanation.errors.join(' '), /executeRefund|unexpected/);
      assert.equal((await t.req(`/api/merchant/orders/${id}`)).data.status, 'awaiting_deposit');
      fake.state.aiNarrative = { claimIds: ['claim:forged'], stepId: 'step:save-note' };
      const forged = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(forged.data.explanation.status, 'invalid');
      assert.match(forged.data.explanation.errors.join(' '), /allowlist/);
      fake.state.aiNarrative = { claimIds: ['claim:display-amount'], stepId: 'step:save-note' };
      const omitted = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(omitted.data.explanation.status, 'invalid');
      assert.match(omitted.data.explanation.errors.join(' '), /refresh-failed/);
      assert.equal(omitted.data.explanation.narrative, null);
      fake.state.aiNarrative = { claimIds: menu.mandatoryClaimIds, stepId: 'step:read-again-later' };
      const ok = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(ok.data.explanation.status, 'stored', JSON.stringify(ok.data));
      assert.equal(ok.data.explanation.authority, 'none');
      assert.equal(ok.data.explanation.composedBy, 'ferry');
      assert.equal(ok.data.explanation.selectedBy, 'near-ai');
      assert.equal(ok.data.unchanged, true);
      assert.match(ok.data.explanation.narrative.summary, /not refreshed/);
      assert.doesNotMatch(ok.data.explanation.narrative.summary, /Everything is confirmed|executeRefund/);
      const after = await t.req(`/api/merchant/orders/${id}`);
      assert.equal(after.data.status, 'awaiting_deposit');
      assert.equal(after.data.amount.base, '2000000');
      assert.equal(after.data.recipient, 'ferry-sample.near');
      assert.equal(after.data.narratives.at(-1).narrative.summary.includes('refresh'), true);
      assert.equal((await t.req('/api/merchant')).data.merchant.payout.recipient, 'ferry-sample.near');
    } finally { await t.close(); }
  });

  test(`[${label}] a no-quote explanation cannot repeat the live false claims, and older text stays stored but hidden`, async () => {
    const fake = fakeOneClick();
    const t = await boot({ aiKey: 'sample-key-not-real', fake });
    try {
      await merchantWithProduct(t, '1');
      const inv = await t.req('/api/merchant/orders', { method: 'POST', body: { title: 'One USDC', description: '', amount: '1' } });
      assert.equal(inv.status, 201, JSON.stringify(inv.data));
      const id = inv.data.orderId;
      assert.equal((await t.req(`/api/merchant/orders/${id}/notes`, { method: 'POST', body: { body: 'QA note four' } })).status, 201);
      assert.equal((await t.req(`/api/merchant/orders/${id}/notes`, { method: 'POST', body: { body: 'QA note five' } })).status, 201);
      const before = await t.req(`/api/merchant/orders/${id}`);
      assert.equal(before.data.amount.base, '1000000');
      assert.equal(before.data.amount.formatted, '1');
      assert.equal(before.data.status, 'open');
      assert.equal(before.data.quotes.length, 0);
      assert.equal(before.data.diagnosis.freshness.state, 'no_quote');
      const evidenceIds = [`order:${id}`, ...before.data.events.map((e) => `event:${e.id}`)];
      assert.ok(evidenceIds.length >= 3);
      const attacks = [
        { summary: 'The order is for 1,000,000 USDC on NEAR. A refresh was attempted but failed to produce quotes; the status was not rechecked.', evidenceCited: evidenceIds.slice(0, 12), unknowns: ['refresh attempted but failed to produce quotes'], suggestedReviewStep: 'Generate a quote. Funds may be lost after the quote deadline.' },
        { claimIds: ['claim:display-amount', 'claim:no-quote', 'claim:provider-not-called'], stepId: 'step:nothing-in-flight', summary: '100 USDC. 1 million USDC. 1M.' },
        { claimIds: ['claim:display-amount', 'claim:no-quote', 'claim:provider-not-called'], stepId: 'step:nothing-in-flight', suggestedReviewStep: 'No deposit was sent, funds may be lost' },
        { claimIds: ['claim:display-amount', 'claim:no-quote', 'claim:provider-not-called'], stepId: 'step:nothing-in-flight', summary: 'The status check errored. You could lose your money if you wait.' },
        { claimIds: ['claim:display-amount', 'claim:no-quote', 'claim:provider-not-called'], stepId: 'step:generate-quote' },
      ];
      const statusCalls = fake.calls.filter((c) => c.path === '/v0/status').length;
      for (const attack of attacks) {
        fake.state.aiNarrative = attack;
        const bad = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
        assert.equal(bad.status, 200, JSON.stringify(bad.data));
        assert.equal(bad.data.explanation.status, 'invalid', JSON.stringify(attack));
        assert.equal(bad.data.explanation.narrative, null);
        assert.equal(bad.data.explanation.accepted, false);
        assert.equal(bad.data.unchanged, true);
      }
      assert.equal(fake.calls.filter((c) => c.path === '/v0/status').length, statusCalls);
      const sent = JSON.parse(fake.calls.filter((c) => c.path === '/v1/chat/completions').at(-1).body);
      const menu = JSON.parse(sent.messages[1].content);
      assert.ok(menu.claims.some((c) => c.id === 'claim:display-amount' && c.text.includes('1 USDC') && c.text.includes('1000000 base units')));
      assert.ok(menu.claims.some((c) => c.id === 'claim:provider-not-called' && /not called/i.test(c.text)));
      assert.equal(menu.steps.some((s) => s.id === 'step:generate-quote'), false);
      assert.doesNotMatch(JSON.stringify(menu), /ferry-sample\.near/);
      const hidden = await t.req(`/api/merchant/orders/${id}`);
      assert.equal(hidden.data.status, 'open');
      assert.equal(hidden.data.amount.formatted, '1');
      assert.equal(hidden.data.narratives.at(-1).narrative, null);
      assert.doesNotMatch(JSON.stringify(hidden.data), /1,000,000|100 USDC|1 million|1M|lose your money|funds may be lost|status check errored|Generate a quote/);
      fake.state.aiNarrative = { claimIds: menu.mandatoryClaimIds, stepId: 'step:nothing-in-flight' };
      const ok = await t.req(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      assert.equal(ok.data.explanation.status, 'stored', JSON.stringify(ok.data));
      assert.equal(ok.data.explanation.narrative.narrativeVersion, 2);
      assert.equal(ok.data.explanation.narrative.composedBy, 'ferry');
      assert.equal(ok.data.explanation.narrative.selectedBy, 'near-ai');
      assert.equal(ok.data.explanation.accepted, true);
      assert.match(ok.data.explanation.narrative.summary, /1 USDC/);
      assert.match(ok.data.explanation.narrative.summary, /was not called/);
      assert.doesNotMatch(`${ok.data.explanation.narrative.summary} ${ok.data.explanation.narrative.suggestedReviewStep}`, /100 USDC|1 million|\b1M\b|lose your money|funds may be lost|status check errored|Generate a quote/);
      await t.rt.db.run('INSERT INTO order_events(order_id, kind, detail, at) VALUES (?,?,?,?)', [id, 'ai_narrative', JSON.stringify({ narrativeId: 'nar_legacy', status: 'stored', narrative: { claimsChecked: true, summary: '100 USDC. 1 million USDC. 1M. The status check errored. You could lose your money if you wait. No deposit was sent, funds may be lost. Generate a new quote.', evidenceCited: [`order:${id}`], unknowns: ['none'], suggestedReviewStep: 'Generate a new quote.' } }), new Date().toISOString()]);
      const after = await t.req(`/api/merchant/orders/${id}`);
      const legacy = after.data.narratives.find((n) => n.id === 'nar_legacy');
      assert.equal(legacy.status, 'withheld');
      assert.equal(legacy.narrative, null);
      assert.match(legacy.errors.join(' '), /check mark/);
      assert.doesNotMatch(JSON.stringify(after.data), /100 USDC|1 million|lose your money|funds may be lost|status check errored|Generate a new quote/);
      const raw = await t.rt.db.get("SELECT detail FROM order_events WHERE order_id=? AND kind='ai_narrative' ORDER BY id DESC LIMIT 1", [id]);
      assert.match(String(raw.detail), /100 USDC/);
      assert.match(String(raw.detail), /claimsChecked/);
      assert.equal(after.data.status, 'open');
      assert.equal(after.data.amount.base, '1000000');
    } finally { await t.close(); }
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
