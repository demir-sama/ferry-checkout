// End-to-end HTTP tests against a real server instance with a fake (fixture) 1Click and NEAR AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRuntime } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { fakeOneClick, TOKENS } from './fixtures.js';

const USDC_NEAR = TOKENS[0].assetId, USDC_BASE = TOKENS[1].assetId;

async function start({ aiKey = '', dbPath, fake = fakeOneClick() } = {}) {
  const dir = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-'));
  const cfg = { ...loadConfig({}), dbPath: dbPath || path.join(dir, 'test.db'), nearAiKey: aiKey, oneClickBase: 'http://fake-1click', nearAiBase: 'http://fake-ai/v1' };
  const rt = buildRuntime({ cfg, fetchImpl: fake.fetchImpl, log: () => {} });
  const srv = http.createServer(rt.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`; rt.cfg.publicBaseUrl = base;
  let cookie = '';
  const req = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data, headers: r.headers };
  };
  return { rt, fake, req, dir, close: () => { srv.close(); rt.db.close(); } };
}

async function merchantWithProduct(t) {
  const { accessKey } = t.rt.service.createMerchant({ name: 'Test Store' });
  assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey } })).status, 200);
  const s = await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_NEAR, payoutRecipient: 'shop.near' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const p = await t.req('/api/merchant/products', { method: 'POST', body: { name: 'Notebook', price: '2' } });
  assert.equal(p.status, 201); return p.data.product;
}

test('auth, CSRF and authorization guards', async () => {
  const t = await start();
  try {
    assert.equal((await t.req('/api/merchant')).status, 401);
    assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey: 'fk_wrong' } })).status, 401);
    const { accessKey } = t.rt.service.createMerchant({ name: 'S' });
    assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { accessKey } })).status, 200);
    assert.equal((await t.req('/api/merchant', { method: 'PUT', body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
    const r = await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_BASE, payoutRecipient: 'shop.near' } });
    assert.equal(r.status, 400); assert.match(r.data.error, /0x-prefixed/);
    assert.equal((await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: 'nep141:btc.omft.near', payoutRecipient: 'bc1q0000' } })).status, 400);
    const h = await t.req('/');
    assert.match(h.headers.get('content-security-policy'), /script-src 'self'/);
    // Another merchant cannot read this merchant's order.
    const p = await t.req('/api/merchant/products', { method: 'POST', body: { name: 'x', price: '1' } });
    assert.equal(p.status, 409); // no payout yet
  } finally { t.close(); }
});

test('order → exact-output quote → paid only after verified server-side SUCCESS; survives restart', async () => {
  const t = await start();
  let dbPath = t.rt.cfg.dbPath, secret;
  try {
    const prod = await merchantWithProduct(t);
    const o = await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' });
    assert.equal(o.status, 201); secret = o.data.checkoutPath.split('/').pop();
    assert.ok(secret.startsWith('chk_') && !secret.includes('ord_'));
    const view = await t.req(`/api/checkout/${secret}`);
    assert.equal(view.data.amount.base, '2000000'); assert.equal(view.data.status, 'open');
    // Bad refund address is refused before 1Click is called.
    assert.equal((await t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: 'shop.near' } })).status, 400);
    const q = await t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' } });
    assert.equal(q.status, 201, JSON.stringify(q.data));
    const sent = JSON.parse([...t.fake.quotes.values()][0].quoteRequest ? JSON.stringify([...t.fake.quotes.values()][0].quoteRequest) : '{}');
    assert.equal(sent.swapType, 'EXACT_OUTPUT'); assert.equal(sent.amount, '2000000'); assert.equal(sent.recipient, 'shop.near'); assert.equal(sent.dry, false);
    const dep = q.data.quotes[0].depositAddress; assert.equal(q.data.status, 'awaiting_deposit');
    assert.equal(q.data.quotes[0].amountInFormatted, '2.025044');
    // There is no endpoint to claim payment; random client posts do nothing.
    assert.equal((await t.req(`/api/checkout/${secret}/paid`, { method: 'POST', body: { txHash: '0xabc' } })).status, 404);
    t.fake.setStatus(dep, { status: 'PROCESSING' });
    assert.equal((await t.req(`/api/checkout/${secret}/status`)).data.status, 'processing'); // status endpoint polls 1Click server-side
    await t.rt.service.refreshOrder(q.data.id, { force: true });
    assert.equal((await t.req(`/api/checkout/${secret}`)).data.status, 'processing');
    // New quote blocked while processing.
    assert.equal((await t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' } })).status, 409);
    t.fake.setStatus(dep, { status: 'SUCCESS', swapDetails: { amountOut: '2000000', amountOutFormatted: '2.0' } });
    await t.rt.service.refreshOrder(q.data.id, { force: true });
    const paid = await t.req(`/api/checkout/${secret}`);
    assert.equal(paid.data.status, 'paid'); assert.equal(paid.data.quotes[0].verified, true);
  } finally { t.close(); }
  // Restart on the same database file.
  const t2 = await start({ dbPath });
  try {
    const v = await t2.req(`/api/checkout/${secret}`);
    assert.equal(v.status, 200); assert.equal(v.data.status, 'paid'); assert.equal(v.data.amount.base, '2000000');
  } finally { t2.close(); }
});

test('SUCCESS for a tampered quote does not mark paid', async () => {
  const t = await start();
  try {
    const prod = await merchantWithProduct(t);
    const secret = (await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).data.checkoutPath.split('/').pop();
    const q = await t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' } });
    const dep = q.data.quotes[0].depositAddress; const original = t.fake.quotes.get(dep);
    t.fake.setStatus(dep, { status: 'SUCCESS', quoteResponse: { ...original, quoteRequest: { ...original.quoteRequest, recipient: 'attacker.near' } } });
    await t.rt.service.refreshOrder(q.data.id, { force: true });
    const v = await t.req(`/api/checkout/${secret}`);
    assert.equal(v.data.status, 'needs_review'); assert.equal(v.data.quotes[0].verified, false);
  } finally { t.close(); }
});

test('quote response that does not match the request is rejected', async () => {
  const t = await start({ fake: fakeOneClick({ tamper: () => ({ recipient: 'attacker.near' }) }) });
  try {
    const prod = await merchantWithProduct(t);
    const secret = (await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).data.checkoutPath.split('/').pop();
    const q = await t.req(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: USDC_BASE, refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' } });
    assert.equal(q.status, 502); assert.match(q.data.error, /recipient/);
    assert.equal((await t.req(`/api/checkout/${secret}`)).data.quotes.length, 0);
  } finally { t.close(); }
});

test('payout change does not alter existing orders; prices are immutable', async () => {
  const t = await start();
  try {
    const prod = await merchantWithProduct(t);
    const secret = (await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).data.checkoutPath.split('/').pop();
    await t.req('/api/merchant', { method: 'PUT', body: { payoutAssetId: USDC_BASE, payoutRecipient: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' } });
    const v = await t.req(`/api/checkout/${secret}`);
    assert.equal(v.data.recipient, 'shop.near'); assert.equal(v.data.amount.assetId, USDC_NEAR);
    // Product priced in the old asset can no longer create orders.
    assert.equal((await t.req(`/api/public/products/${prod.id}/orders`, { method: 'POST' })).status, 409);
  } finally { t.close(); }
});

test('NEAR AI: honest unconfigured state, then validated draft with human approval', async () => {
  const t = await start();
  try {
    await merchantWithProduct(t);
    const r = await t.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
    assert.equal(r.status, 503); assert.equal(r.data.code, 'NEAR_AI_NOT_CONFIGURED');
    assert.equal(t.fake.calls.filter((c) => c.path === '/v1/chat/completions').length, 0);
  } finally { t.close(); }
  const t2 = await start({ aiKey: 'test-key-not-real' });
  try {
    await merchantWithProduct(t2);
    const before = (await t2.req('/api/merchant')).data.merchant;
    const r = await t2.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
    assert.equal(r.status, 201); assert.equal(r.data.draft.status, 'pending');
    assert.equal(t2.fake.calls.find((c) => c.path === '/v1/chat/completions').auth, 'Bearer test-key-not-real');
    // Nothing applied before approval.
    assert.deepEqual((await t2.req('/api/merchant')).data.merchant, before);
    // Product without merchant price is refused, nothing is written.
    const id = r.data.draft.id;
    assert.equal((await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: ['tagline', 'product:0'] } })).status, 400);
    assert.equal((await t2.req('/api/merchant')).data.merchant.profile.tagline, undefined);
    const ok = await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: ['tagline', 'product:0', 'suggestedAssetIds'], productPrices: { 0: '12.5' } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.merchant.profile.tagline, 'Hand-bound notebooks, shipped worldwide');
    assert.equal(ok.data.merchant.payout.recipient, 'shop.near');
    assert.equal(ok.data.createdProducts[0].priceBase, '12500000');
    assert.ok(ok.data.merchant.acceptedAssets.includes(USDC_BASE));
    assert.equal((await t2.req(`/api/merchant/ai/drafts/${id}/approve`, { method: 'POST', body: { fields: [] } })).status, 409);
  } finally { t2.close(); }
});

test('AI draft containing forbidden fields is stored as invalid and never applied', async () => {
  const fake = fakeOneClick();
  const saved = fakeOneClick.aiDraft;
  fakeOneClick.aiDraft = { ...saved, payoutRecipient: 'attacker.near' };
  const t = await start({ aiKey: 'k', fake });
  try {
    await merchantWithProduct(t);
    const r = await t.req('/api/merchant/ai/drafts', { method: 'POST', body: { brief: 'We sell notebooks worldwide.' } });
    assert.equal(r.data.draft.status, 'invalid'); assert.match(r.data.draft.validation.errors.join(), /forbidden/);
    assert.equal((await t.req(`/api/merchant/ai/drafts/${r.data.draft.id}/approve`, { method: 'POST', body: { fields: ['tagline'] } })).status, 409);
  } finally { fakeOneClick.aiDraft = saved; t.close(); }
});
