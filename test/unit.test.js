import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits, formatUnits } from '../src/amounts.js';
import { validateAddress } from '../src/addresses.js';
import { verifySuccess, deriveOrderStatus } from '../src/reconcile.js';
import { validateDraft } from '../src/ai.js';
import { fakeOneClick, TOKENS } from "./fixtures.js";

test('parseUnits/formatUnits are exact for large decimals', () => {
  assert.equal(parseUnits('25.5', 6), 25500000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.equal(parseUnits('1.000000000000000000000001', 24), 1000000000000000000000001n);
  assert.equal(formatUnits('1000000000000000000000001', 24), '1.000000000000000000000001');
  assert.equal(formatUnits(2000000n, 6), '2');
  for (const bad of ['1.0000001', '-1', '1e5', '0x10', '', ' . ', '01']) assert.throws(() => parseUnits(bad, 6), bad);
});

test('address validation by chain family', () => {
  assert.ok(validateAddress('near', 'shop.near').ok);
  assert.ok(validateAddress('near', 'a'.repeat(64)).ok);
  assert.ok(!validateAddress('near', 'Shop.NEAR').ok);
  assert.ok(validateAddress('base', '0x2527D02599Ba641c19FEa793cD0F167589a0f10D').ok);
  assert.ok(!validateAddress('base', '0x123').ok);
  assert.ok(validateAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').ok);
  assert.ok(!validateAddress('sol', '0OIl' + 'x'.repeat(40)).ok);
  assert.ok(validateAddress('btc', 'bc1qexample0000').structuralOnly);
  assert.ok(!validateAddress('btc', 'bad addr').ok);
});

const order = { recipient: 'shop.near', dest_asset_id: TOKENS[0].assetId, amount_out_base: '2000000', status: 'awaiting_deposit', expires_at: new Date(Date.now() + 3600e3).toISOString() };
const quote = { deposit_address: '0xDEP', deposit_memo: null, signature: 'ed25519:S', origin_asset_id: TOKENS[1].assetId, refund_to: '0xREF', amount_in: '2025107', min_amount_in: '2004902' };
const okStatus = () => ({ status: 'SUCCESS', quoteResponse: { signature: 'ed25519:S', quote: { depositAddress: '0xDEP', amountIn: '2025107', minAmountIn: '2004902' }, quoteRequest: { swapType: 'EXACT_OUTPUT', recipient: 'shop.near', destinationAsset: TOKENS[0].assetId, amount: '2000000', originAsset: TOKENS[1].assetId, refundTo: '0xREF' } }, swapDetails: { amountOut: '2000000' } });

test('verifySuccess requires an exact match on every field', () => {
  assert.equal(verifySuccess(order, quote, okStatus()).ok, true);
  const cases = [
    (s) => (s.quoteResponse.quote.depositAddress = '0xOTHER'), (s) => (s.quoteResponse.signature = 'x'), (s) => (s.quoteResponse.quoteRequest.recipient = 'attacker.near'),
    (s) => (s.quoteResponse.quoteRequest.amount = '1'), (s) => (s.quoteResponse.quoteRequest.swapType = 'EXACT_INPUT'), (s) => (s.quoteResponse.quoteRequest.destinationAsset = 'nep141:wrap.near'),
    (s) => (s.swapDetails.amountOut = '1999999'), (s) => delete s.quoteResponse, (s) => (s.quoteResponse.quoteRequest.refundTo = '0xX'), (s) => (s.quoteResponse.quote.amountIn = '1'), (s) => (s.quoteResponse.quote.minAmountIn = '1'), (s) => (s.quoteResponse.quote.depositMemo = 'M'), (s) => (s.quoteResponse.quoteRequest.originAsset = 'x'),
  ];
  for (const mut of cases) { const s = okStatus(); mut(s); assert.equal(verifySuccess(order, quote, s).ok, false); }
});

test('deriveOrderStatus never reports paid without a verified SUCCESS', () => {
  const future = new Date(Date.now() + 60e3).toISOString(), past = new Date(Date.now() - 60e3).toISOString();
  assert.equal(deriveOrderStatus(order, []).status, 'open');
  assert.equal(deriveOrderStatus(order, [{ remote_status: 'PENDING_DEPOSIT', deadline: future }]).status, 'awaiting_deposit');
  assert.equal(deriveOrderStatus(order, [{ remote_status: 'PENDING_DEPOSIT', deadline: past }]).status, 'quote_expired');
  assert.equal(deriveOrderStatus(order, [{ remote_status: 'PROCESSING', deadline: future }]).status, 'processing');
  assert.equal(deriveOrderStatus(order, [{ remote_status: 'SUCCESS', verified: false, deadline: future }]).status, 'needs_review');
  assert.deepEqual(deriveOrderStatus(order, [{ id: 'q1', remote_status: 'SUCCESS', verified: true, deadline: future }]), { status: 'paid', paidQuoteId: 'q1' });
  assert.equal(deriveOrderStatus(order, [{ remote_status: 'REFUNDED', deadline: past }]).status, 'refunded');
  assert.equal(deriveOrderStatus({ ...order, expires_at: past }, []).status, 'expired');
  assert.equal(deriveOrderStatus({ ...order, expires_at: past }, [{ remote_status: 'PROCESSING', deadline: past }]).status, 'processing');
  assert.equal(deriveOrderStatus({ ...order, expires_at: past }, [{ remote_status: 'KNOWN_DEPOSIT_TX', deadline: past }]).status, 'processing');
  assert.equal(deriveOrderStatus({ ...order, expires_at: past }, [{ remote_status: 'INCOMPLETE_DEPOSIT', deadline: past }]).status, 'incomplete_deposit');
  assert.equal(deriveOrderStatus({ ...order, expires_at: past }, [{ remote_status: 'PENDING_DEPOSIT', deadline: future }]).status, 'awaiting_deposit');
});

test('AI draft validator is strict and deterministic', () => {
  const live = new Set(TOKENS.map((t) => t.assetId));
  const good = structuredClone(fakeOneClick.aiDraft);
  assert.equal(validateDraft(good, { liveAssetIds: live }).ok, true);
  const bad = [
    { ...good, payoutRecipient: 'attacker.near' }, { ...good, price: '0.01' }, { ...good, extra: 1 },
    { ...good, accent: 'neon' }, { ...good, tagline: '<script>x</script>' }, { ...good, suggestedAssetIds: ['nep141:fake.near'] },
    { ...good, productCopy: [{ name: 'X', description: 'Y', price: '1' }] }, { ...good, about: 'x'.repeat(601) }, null, [], 'text',
  ];
  for (const b of bad) assert.equal(validateDraft(b, { liveAssetIds: live }).ok, false, JSON.stringify(b)?.slice(0, 80));
  const { tagline, ...missing } = good; assert.equal(validateDraft(missing, { liveAssetIds: live }).ok, false);
});

import { checkQuoteResponse } from '../src/service.js';
import { LIVE_DRY_QUOTE } from './fixtures.js';
test('checkQuoteResponse accepts the real 1Click quote shape and rejects drift', () => {
  // Real dry response (captured live) with the fields only a non-dry quote has added.
  const resp = structuredClone(LIVE_DRY_QUOTE);
  const request = { ...resp.quoteRequest, dry: false };
  resp.quoteRequest.dry = false; resp.quote.depositAddress = '0xFERRYSAMPLE'; resp.signature ||= 'ed25519:x';
  assert.deepEqual(checkQuoteResponse(request, resp), []);
  assert.ok(checkQuoteResponse(request, resp, { memoMode: true }).includes('depositMemo missing'));
  const r2 = structuredClone(resp); r2.quote.amountOut = '2000001'; assert.ok(checkQuoteResponse(request, r2).includes('amountOut'));
  const r3 = structuredClone(resp); r3.quote.amountIn = '2.5'; assert.ok(checkQuoteResponse(request, r3).includes('amountIn'));
});
test('output token decimals: base units survive formatting at 6, 18 and 24 decimals', () => {
  for (const [dec, s] of [[6, '2.025107'], [18, '0.000000000000000001'], [24, '123456789.123456789123456789123456']]) assert.equal(formatUnits(parseUnits(s, dec), dec), s);
  assert.equal(formatUnits(LIVE_DRY_QUOTE.quote.amountOut, 6), LIVE_DRY_QUOTE.quote.amountOutFormatted.replace(/\.0$/, ''));
  assert.equal(formatUnits(LIVE_DRY_QUOTE.quote.amountIn, 6), LIVE_DRY_QUOTE.quote.amountInFormatted);
});
