import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseOrder, compareDeposit } from '../src/diagnose.js';
import { csvCell, toCsv } from '../src/csv.js';
import { simulatedCases } from '../src/simulated.js';
import { validateNarrative } from '../src/ai.js';

const now = Date.parse('2026-11-08T12:00:00.000Z');
const future = '2026-11-08T18:00:00.000Z';
const past = '2026-11-08T10:00:00.000Z';
function order(over = {}) {
  return { id: 'ord_x', status: 'awaiting_deposit', extra_payment: 0, item_name: 'Notebook', amount_out_base: '2000000', dest_symbol: 'USDC', dest_chain: 'near', dest_decimals: 6, expires_at: future, ...over };
}
function quote(over = {}) {
  return { id: 'qt_1', remote_status: 'PENDING_DEPOSIT', verified: null, deadline: future, amount_in: '2025107', min_amount_in: '2004902', amount_out: '2000000', origin_symbol: 'USDC', origin_decimals: 6, origin_chain: 'base', deposit_address: '0xFERRYSAMPLE', deposit_memo: null, correlation_id: 'corr', created_at: past, last_polled_at: new Date(now - 60_000).toISOString(), remote_detail: { updatedAt: past, statusCorrelationId: 'st' }, ...over };
}

test('missing depositedAmount is unknown and is not a shortfall against amountIn', () => {
  const cmp = compareDeposit({ deposited: null, minAmountIn: '2004902', amountIn: '2025107' });
  assert.equal(cmp.relation, 'UNKNOWN');
  assert.equal(cmp.shortfallBase, null);
  const d = diagnoseOrder(order({ status: 'incomplete_deposit' }), [quote({ remote_status: 'INCOMPLETE_DEPOSIT', remote_detail: { updatedAt: past } })], { nowMs: now });
  assert.equal(d.lane, 'attention');
  assert.ok(d.unknowns.some((u) => u.field === 'depositedAmount' && u.value === 'UNKNOWN'));
  assert.equal(d.quotes[0].comparison.shortfallBase, null);
  assert.ok(d.findings.every((f) => !/shortfall is 2025107|amountIn minus/.test(f.detail)));
});

test('a deposit inside the buffer is not a shortfall, and one below the minimum is', () => {
  const inside = compareDeposit({ deposited: '2010000', minAmountIn: '2004902', amountIn: '2025107' });
  assert.equal(inside.relation, 'within_buffer');
  assert.equal(inside.shortfallBase, null);
  const below = compareDeposit({ deposited: '1000000', minAmountIn: '2004902', amountIn: '2025107' });
  assert.equal(below.relation, 'below_minimum');
  assert.equal(below.shortfallBase, '1004902');
  const d = diagnoseOrder(order(), [quote({ remote_status: 'PROCESSING', remote_detail: { depositedAmount: '2010000', updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.equal(d.lane, 'processing');
  assert.ok(d.findings.some((f) => f.id === 'within_buffer'));
  assert.equal(d.changesPaymentState, false);
});

test('seen deposit, provider refund, merchant refund, and local expiry stay distinct', () => {
  const seen = diagnoseOrder(order(), [quote({ remote_status: 'KNOWN_DEPOSIT_TX', remote_detail: { depositedAmount: '2025107', updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.equal(seen.lane, 'processing');
  assert.ok(seen.findings.some((f) => f.id === 'broadcast_not_settled'));
  const refunded = diagnoseOrder(order({ status: 'refunded' }), [quote({ remote_status: 'REFUNDED', remote_detail: { updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.ok(refunded.findings.some((f) => f.id === 'provider_refund'));
  assert.ok(refunded.unknowns.some((u) => u.field === 'refundedAmount'));
  assert.ok(!refunded.findings.some((f) => f.id === 'merchant_refund_review'));
  const extra = diagnoseOrder(order({ status: 'paid', extra_payment: 1 }), [quote({ remote_status: 'SUCCESS', verified: 1, remote_detail: { amountOut: '2000000', depositedAmount: '2025107', updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.equal(extra.lane, 'attention');
  assert.ok(extra.findings.some((f) => f.id === 'merchant_refund_review'));
  const hidden = diagnoseOrder(order({ status: 'expired', expires_at: past }), [quote({ remote_status: 'PROCESSING', deadline: past, remote_detail: { depositedAmount: '2025107', updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.equal(hidden.lane, 'processing');
  assert.ok(hidden.findings.some((f) => f.id === 'local_expiry_separate'));
});

test('stale and failed refreshes are not described as fresh', () => {
  const failed = diagnoseOrder(order(), [quote({ remote_detail: { lastPollError: '1Click HTTP 503', lastPollFailedAt: past } })], { nowMs: now });
  assert.equal(failed.freshness.state, 'refresh_failed');
  assert.equal(failed.lane, 'attention');
  const stale = diagnoseOrder(order(), [quote({ last_polled_at: '2020-01-01T00:00:00.000Z', remote_detail: { updatedAt: past, statusCorrelationId: 'st' } })], { nowMs: now });
  assert.equal(stale.freshness.state, 'stale');
  assert.ok(stale.findings.some((f) => f.id === 'stale_status'));
});

test('narrative schema rejects actions, foreign evidence, and a silent refresh failure', () => {
  const ids = ['order:ord_x', 'quote:qt_1'];
  const good = { summary: 'The status refresh failed. Deposited amount is unknown.', evidenceCited: ['quote:qt_1'], unknowns: ['depositedAmount was not reported'], suggestedReviewStep: 'Review the stored quote. Do not send a refund.' };
  assert.equal(validateNarrative(good, { evidenceIds: ids, refreshFailed: true }).ok, true);
  assert.equal(validateNarrative({ ...good, executeRefund: true }, { evidenceIds: ids, refreshFailed: true }).ok, false);
  assert.equal(validateNarrative({ ...good, evidenceCited: ['quote:forged'] }, { evidenceIds: ids, refreshFailed: true }).ok, false);
  assert.equal(validateNarrative({ ...good, summary: 'All settled just now.' }, { evidenceIds: ids, refreshFailed: true }).ok, false);
  assert.equal(validateNarrative({ ...good, summary: '<script>alert(1)</script>' }, { evidenceIds: ids, refreshFailed: true }).ok, false);
});

test('CSV prefixes formula cells and writes UNKNOWN rather than a blank zero', () => {
  for (const v of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\t=1']) assert.ok(csvCell(v).startsWith("'"), v);
  assert.equal(csvCell('hello, "world"'), '"hello, ""world"""');
  const csv = toCsv(['item', 'deposited_amount'], [{ item: '=HYPERLINK("http://evil")', deposited_amount: 'UNKNOWN' }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /UNKNOWN/);
  assert.doesNotMatch(csv, /,0(\r|\n|$)/);
});

test('simulated cases are labelled and excluded from any live settlement flag', () => {
  const sim = simulatedCases();
  assert.equal(sim.simulated, true);
  assert.equal(sim.liveSettlement, false);
  assert.ok(sim.cases.length >= 8);
  assert.ok(sim.cases.every((c) => c.simulated === true && c.liveSettlement === false && c.label === 'SIMULATED'));
  assert.equal(sim.cases.find((c) => c.id === 'sim-unknown-partial').diagnosis.quotes[0].comparison.relation, 'UNKNOWN');
  assert.equal(sim.cases.find((c) => c.id === 'sim-below-min').diagnosis.quotes[0].comparison.shortfallBase, '1004902');
  assert.equal(sim.cases.find((c) => c.id === 'sim-buffer').diagnosis.lane, 'processing');
  assert.equal(sim.cases.find((c) => c.id === 'sim-local-expiry').diagnosis.lane, 'processing');
});
