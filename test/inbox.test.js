import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseOrder, compareDeposit } from '../src/diagnose.js';
import { csvCell, toCsv } from '../src/csv.js';
import { simulatedCases } from '../src/simulated.js';
import { validateNarrative } from '../src/ai.js';
import { presentStoredNarrative } from '../src/narrative-claims.js';

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

test('a no-quote 1 USDC explanation cannot invent base-unit amounts, a failed refresh, or a deadline', () => {
  const facts = {
    destination: { displayAmount: '1', symbol: 'USDC', chain: 'near', baseUnits: '1000000', decimals: 6 },
    quotes: [],
    refresh: { failed: false, providerCalled: false, detail: 'No quote is stored, so the provider was not called. This is not a failed refresh.' },
  };
  const ids = ['order:ord_x', 'event:1', 'event:4', 'event:5'];
  const observed = {
    summary: 'The order is for 1,000,000 USDC on NEAR. A refresh was attempted but failed to produce quotes; the status was not rechecked.',
    evidenceCited: ids,
    unknowns: ['refresh attempted but failed to produce quotes'],
    suggestedReviewStep: 'Generate a quote. Funds may be lost after the quote deadline.',
  };
  const rejected = validateNarrative(observed, { evidenceIds: ids, refreshFailed: false, facts });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(' '), /base units/);
  assert.match(rejected.errors.join(' '), /failed refresh/);
  assert.match(rejected.errors.join(' '), /quote deadline/);
  const bare = validateNarrative({ ...observed, summary: '1000000 USDC on NEAR.', unknowns: ['none'], suggestedReviewStep: 'Wait for the buyer.' }, { evidenceIds: ids, refreshFailed: false, facts });
  assert.equal(bare.ok, false);
  const truthful = validateNarrative({
    summary: 'The display amount is 1 USDC. No quote is stored. The provider was not called, so this is not a failed refresh.',
    evidenceCited: ['order:ord_x'],
    unknowns: ['No provider field is missing because no quote was stored.'],
    suggestedReviewStep: 'Leave the order open. A quote has not been requested.',
  }, { evidenceIds: ids, refreshFailed: false, facts });
  assert.equal(truthful.ok, true, truthful.errors.join(' '));
  assert.equal(truthful.value.claimsChecked, true);
  assert.equal(validateNarrative({
    summary: 'The order is 1 USDC, which is 1000000 base units.',
    evidenceCited: ['order:ord_x'], unknowns: ['none'], suggestedReviewStep: 'No quote has been requested.',
  }, { evidenceIds: ids, refreshFailed: false, facts }).ok, true);
});

test('refresh success and a future deadline do not license failure or lost-funds claims', () => {
  const facts = {
    destination: { displayAmount: '2', symbol: 'USDC', baseUnits: '2000000', decimals: 6 },
    quotes: [{ deadline: '2099-01-01T00:00:00.000Z', deadlinePassed: false, amountInBase: '2025107', amountInDisplay: '2.025107', originDecimals: 6 }],
    refresh: { failed: false, providerCalled: true },
  };
  const ids = ['quote:qt_1'];
  const body = { evidenceCited: ids, unknowns: ['none'] };
  assert.equal(validateNarrative({ ...body, summary: 'The refresh failed.', suggestedReviewStep: 'Look again later.' }, { evidenceIds: ids, facts }).ok, false);
  assert.equal(validateNarrative({ ...body, summary: 'A quote is waiting. Funds may be lost.', suggestedReviewStep: 'Wait.' }, { evidenceIds: ids, facts }).ok, false);
  assert.equal(validateNarrative({ ...body, summary: 'The provider was called. The display amount is 2 USDC.', suggestedReviewStep: 'Wait for the deposit.' }, { evidenceIds: ids, facts }).ok, true);
});

test('legacy stored narratives are withheld without dropping the record', () => {
  const detail = { status: 'stored', narrativeId: 'nar_T03XaJUtujSB', narrative: { summary: '1,000,000 USDC on NEAR. Funds may be lost after the quote deadline.', evidenceCited: ['order:ord_x'], unknowns: ['none'], suggestedReviewStep: 'Generate a quote.' } };
  const shown = presentStoredNarrative(detail);
  assert.equal(shown.status, 'withheld');
  assert.equal(shown.narrative, null);
  assert.match(shown.errors.join(' '), /kept on record/);
  assert.equal(detail.narrative.summary.includes('1,000,000'), true);
  const checked = presentStoredNarrative({ status: 'stored', narrative: { claimsChecked: true, summary: 'The display amount is 1 USDC.', evidenceCited: ['order:ord_x'], unknowns: [], suggestedReviewStep: 'Wait.' } });
  assert.equal(checked.status, 'stored');
  assert.match(checked.narrative.summary, /1 USDC/);
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
