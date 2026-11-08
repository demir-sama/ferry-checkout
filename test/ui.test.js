// Browser-side regressions, run in jsdom against the real public/ modules (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function browser(htmlFile, url, routes) {
  const dom = new JSDOM(readFileSync(new URL(`../public/${htmlFile}`, import.meta.url), 'utf8'), { url });
  const calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, location: dom.window.location, Event: dom.window.Event });
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET' });
    const r = routes(path, opts);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { dom, calls };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let n = 0; const fresh = (f) => import(`../public/${f}?v=${++n}`);

test('fill() never renders null/undefined/false as text', async () => {
  browser('product.html', 'https://ferry.test/p/prd_abcdefgh', () => ({ status: 404, body: {} }));
  const { fill, el } = await fresh('common.js');
  const box = document.createElement('div');
  fill(box, el('b', {}, 'x'), null, undefined, false, 'ok', [null, 'y']);
  assert.equal(box.textContent, 'xoky');
});

test('product page with no description or tagline shows no literal "null"', async () => {
  const { calls } = browser('product.html', 'https://ferry.test/p/prd_abcdefgh', (p) => (p === '/api/public/products/prd_abcdefgh'
    ? { status: 200, body: { id: 'prd_abcdefgh', name: 'Sample', description: '', price: '1', symbol: 'USDC', merchant: { name: 'Ferry Sample Store', profile: {}, isSample: true } } }
    : { status: 404, body: {} }));
  await fresh('product.js'); await tick();
  const text = document.querySelector('#pr').textContent;
  assert.match(text, /1 USDC/);
  assert.doesNotMatch(text, /null|undefined/);
  assert.equal(calls.length, 1);
});

test('checkout refuses a malformed refund address in the browser before any quote request', async () => {
  const secret = 'chk_' + 'a'.repeat(24);
  const order = { id: 'ord_x', status: 'open', statusNote: null, extraPayment: false, item: { name: 'Sample', description: '' }, amount: { formatted: '1', symbol: 'USDC', chain: 'near' }, recipient: 'ferry-sample.near', acceptedAssets: [], merchant: { name: 'S', isSample: true }, quotes: [], activeQuote: null, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  const assets = [{ assetId: 'nep141:base-usdc', symbol: 'USDC', blockchain: 'base', decimals: 6 }];
  const { calls } = browser('checkout.html', `https://ferry.test/c/${secret}`, (p) => (p === `/api/checkout/${secret}` ? { status: 200, body: order } : p === '/api/assets' ? { status: 200, body: { assets } } : { status: 500, body: { error: 'unexpected' } }));
  await fresh('checkout.js'); await tick(80);
  document.querySelector('#co-asset').value = 'nep141:base-usdc';
  const input = document.querySelector('#co-refund');
  input.value = 'not-an-address'; input.dispatchEvent(new Event('blur'));
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(document.querySelector('#co-refund-err').textContent, /0x-prefixed/);
  document.querySelector('#co-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  assert.equal(calls.filter((c) => c.path.endsWith('/quote')).length, 0, 'no quote request may be sent');
  input.value = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D'; input.dispatchEvent(new Event('input'));
  assert.equal(input.getAttribute('aria-invalid'), null);
});
