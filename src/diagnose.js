// Deterministic reconciliation rules. This module never calls a provider and never changes an order.
// Amounts are integer base units. A missing optional provider field is UNKNOWN, never zero.
import { formatUnits, isBaseUnitString } from './amounts.js';

export const STALE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const SEEN = new Set(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'INCOMPLETE_DEPOSIT', 'SUCCESS', 'REFUNDED', 'FAILED']);

const parseDetail = (q) => {
  const d = q.remote_detail ?? q.remoteDetail;
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch { return {}; }
};
const flag = (v) => (v == null || v === '' ? null : v === true || v === 1 || v === '1');
const baseOrNull = (v) => (isBaseUnitString(v) ? String(v) : null);
const fmt = (base, decimals, symbol) => `${formatUnits(base, decimals)} ${symbol}`;

// Compare a reported deposit with the quote. Never treats buffered amountIn as the shortfall baseline.
export function compareDeposit({ deposited, minAmountIn, amountIn }) {
  if (!isBaseUnitString(minAmountIn) || !isBaseUnitString(amountIn)) {
    return { relation: 'UNKNOWN', shortfallBase: null, note: 'The stored quote is missing amountIn or minAmountIn, so no deposit comparison was made.' };
  }
  if (!isBaseUnitString(deposited)) {
    return { relation: 'UNKNOWN', shortfallBase: null, note: 'depositedAmount was not reported. The shortfall is UNKNOWN. amountIn is a buffered suggestion and was not used as a baseline.' };
  }
  const d = BigInt(deposited), min = BigInt(minAmountIn), suggested = BigInt(amountIn);
  if (d < min) {
    return { relation: 'below_minimum', shortfallBase: (min - d).toString(), note: 'The shortfall is minAmountIn minus the reported deposit. amountIn was not used.' };
  }
  if (d < suggested) return { relation: 'within_buffer', shortfallBase: null, note: 'The deposit is at least minAmountIn and below the buffered amountIn. That is not a shortfall.' };
  if (d === suggested) return { relation: 'equals_suggested', shortfallBase: null, note: 'The deposit matches the buffered suggestion amountIn.' };
  return { relation: 'above_suggested', shortfallBase: null, note: 'The deposit is above the buffered amountIn. 1Click documents a provider refund of unused input after a completed swap. That is not a merchant refund, and Ferry does not send it.' };
}

export function quoteFreshness(q, nowMs = Date.now(), staleMs = STALE_MS) {
  const detail = parseDetail(q);
  const pollError = typeof detail.lastPollError === 'string' && detail.lastPollError ? detail.lastPollError : null;
  const providerUpdatedAt = typeof detail.updatedAt === 'string' && detail.updatedAt ? detail.updatedAt : null;
  const terminal = TERMINAL.has(q.remote_status);
  if (pollError && !terminal) return { state: 'refresh_failed', at: q.last_polled_at || detail.lastPollFailedAt || null, providerUpdatedAt, error: pollError };
  if (!q.last_polled_at) {
    const created = Date.parse(q.created_at || '') || nowMs;
    const old = !terminal && nowMs - created > staleMs;
    return { state: 'never_checked', at: null, providerUpdatedAt, error: null, attention: old };
  }
  const ageMs = nowMs - Date.parse(q.last_polled_at);
  if (!terminal && ageMs > staleMs) return { state: 'stale', at: q.last_polled_at, ageMs, providerUpdatedAt, error: null };
  return { state: terminal ? 'terminal' : 'fresh', at: q.last_polled_at, ageMs, providerUpdatedAt, error: null };
}

function pushUnknown(list, field, quoteId, why) {
  list.push({ field, quoteId, value: 'UNKNOWN', why });
}

export function diagnoseOrder(order, quotes = [], { nowMs = Date.now(), staleMs = STALE_MS } = {}) {
  const findings = [];
  const unknowns = [];
  const extra = flag(order.extra_payment) === true;
  const seen = { verified: false, unverified: false, active: false, incomplete: false, pendingLive: false, pendingLate: false, refunded: false, failed: false, depositInFlight: false };
  const perQuote = [];

  for (const q of quotes) {
    const detail = parseDetail(q);
    const dec = Number(q.origin_decimals ?? 0);
    const symbol = q.origin_symbol || 'units';
    const deposited = baseOrNull(detail.depositedAmount);
    const settledOut = baseOrNull(detail.amountOut);
    const refunded = baseOrNull(detail.refundedAmount);
    const refundReason = typeof detail.refundReason === 'string' && detail.refundReason ? detail.refundReason : null;
    const comparison = compareDeposit({ deposited, minAmountIn: q.min_amount_in, amountIn: q.amount_in });
    const fresh = quoteFreshness(q, nowMs, staleMs);
    const verified = flag(q.verified);
    const id = `quote:${q.id}`;
    const status = q.remote_status;
    const deadlineMs = Date.parse(q.deadline);
    const deadlinePassed = Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
    perQuote.push({ id: q.id, remoteStatus: status, verified, comparison, freshness: fresh, deadlinePassed });

    if (status === 'SUCCESS' && verified === true) seen.verified = true;
    if (status === 'SUCCESS' && verified === false) seen.unverified = true;
    if (status === 'KNOWN_DEPOSIT_TX' || status === 'PROCESSING') { seen.active = true; seen.depositInFlight = true; }
    if (status === 'INCOMPLETE_DEPOSIT') { seen.incomplete = true; seen.depositInFlight = true; }
    if (status === 'PENDING_DEPOSIT' && !deadlinePassed) { seen.pendingLive = true; seen.depositInFlight = true; }
    if (status === 'PENDING_DEPOSIT' && deadlinePassed) seen.pendingLate = true;
    if (status === 'REFUNDED') seen.refunded = true;
    if (status === 'FAILED') seen.failed = true;
    if (SEEN.has(status) && status !== 'PENDING_DEPOSIT') seen.depositInFlight = true;

    if (status === 'KNOWN_DEPOSIT_TX') findings.push({ id: 'broadcast_not_settled', severity: 'info', title: 'Deposit transaction seen, not settled', detail: 'KNOWN_DEPOSIT_TX means the provider knows a deposit transaction. Broadcast or seen is not settlement, and the order is not paid.', evidenceIds: [id] });
    if (status === 'PROCESSING') findings.push({ id: 'processing_not_settled', severity: 'info', title: 'Swap processing, not paid', detail: 'PROCESSING means the provider is still executing the swap. Ferry has not marked the order paid from this quote.', evidenceIds: [id] });

    if (deposited == null && ['INCOMPLETE_DEPOSIT', 'SUCCESS', 'REFUNDED', 'PROCESSING', 'KNOWN_DEPOSIT_TX'].includes(status)) {
      pushUnknown(unknowns, 'depositedAmount', q.id, 'The provider did not report depositedAmount. It is UNKNOWN, not zero.');
    }
    if (settledOut == null && status === 'SUCCESS') pushUnknown(unknowns, 'amountOut', q.id, 'The provider did not report swapDetails.amountOut. It is UNKNOWN, not zero.');
    if (refunded == null && (status === 'REFUNDED' || status === 'SUCCESS')) pushUnknown(unknowns, 'refundedAmount', q.id, 'The provider did not report refundedAmount. It is UNKNOWN, not zero.');
    if (!refundReason && status === 'REFUNDED') pushUnknown(unknowns, 'refundReason', q.id, 'The provider did not report refundReason.');
    if (!fresh.providerUpdatedAt && q.last_polled_at) pushUnknown(unknowns, 'updatedAt', q.id, 'The status response did not include updatedAt.');

    if (status === 'INCOMPLETE_DEPOSIT') {
      if (comparison.relation === 'UNKNOWN') findings.push({ id: 'incomplete_amount_unknown', severity: 'attention', title: 'Partial deposit, size unknown', detail: 'The provider status is INCOMPLETE_DEPOSIT, but depositedAmount is missing. The shortfall is UNKNOWN. Ferry did not subtract anything from amountIn.', evidenceIds: [id] });
      else if (comparison.relation === 'below_minimum') findings.push({ id: 'below_minimum', severity: 'attention', title: 'Deposit below the minimum', detail: `Reported deposit ${fmt(deposited, dec, symbol)} is ${fmt(comparison.shortfallBase, dec, symbol)} below minAmountIn ${fmt(q.min_amount_in, dec, symbol)}. The buffered suggestion amountIn is ${fmt(q.amount_in, dec, symbol)} and was not used as the shortfall.`, evidenceIds: [id] });
      else findings.push({ id: 'incomplete_contradicts_amount', severity: 'attention', title: 'Incomplete status contradicts the reported deposit', detail: `Status is INCOMPLETE_DEPOSIT but the reported deposit is ${comparison.relation.replaceAll('_', ' ')} relative to minAmountIn. These two facts disagree. Nothing was auto-corrected.`, evidenceIds: [id] });
    } else if (comparison.relation === 'below_minimum' && (status === 'SUCCESS' || status === 'PROCESSING' || status === 'KNOWN_DEPOSIT_TX')) {
      findings.push({ id: 'contradictory_deposit', severity: 'attention', title: 'Reported deposit is below the minimum', detail: `Status is ${status} but depositedAmount ${fmt(deposited, dec, symbol)} is below minAmountIn ${fmt(q.min_amount_in, dec, symbol)}. Ferry did not change the stored order status from this rule.`, evidenceIds: [id] });
    } else if (comparison.relation === 'within_buffer') {
      findings.push({ id: 'within_buffer', severity: 'info', title: 'Deposit is inside the slippage buffer', detail: comparison.note, evidenceIds: [id] });
    } else if (comparison.relation === 'above_suggested') {
      findings.push({ id: 'above_suggested', severity: 'info', title: 'Deposit above the buffered suggestion', detail: comparison.note, evidenceIds: [id] });
    }

    if (status === 'SUCCESS' && verified === false) findings.push({ id: 'success_not_verified', severity: 'attention', title: 'SUCCESS did not match this order', detail: 'The provider reported SUCCESS, but the quote echo did not match the stored order. The order is not treated as paid on this quote.', evidenceIds: [id] });
    if (status === 'SUCCESS' && settledOut != null && BigInt(settledOut) < BigInt(order.amount_out_base)) findings.push({ id: 'settled_below_order', severity: 'attention', title: 'Settled output below the order amount', detail: `swapDetails.amountOut ${settledOut} is below the order amount ${order.amount_out_base} (${order.dest_symbol || 'destination'}).`, evidenceIds: [id] });
    if (status === 'REFUNDED') findings.push({ id: 'provider_refund', severity: 'attention', title: 'Provider swap refund', detail: `REFUNDED is a 1Click swap refund${refundReason ? ` (${refundReason})` : ''}${refunded ? ` of ${fmt(refunded, dec, symbol)}` : ', and the refunded amount was not reported'}. It is not a merchant refund sent after settlement. Ferry cannot execute either one.`, evidenceIds: [id] });
    if (status === 'FAILED') findings.push({ id: 'provider_failed', severity: 'attention', title: 'Provider reported FAILED', detail: 'FAILED is a provider terminal status. It is not an order Ferry marked paid, and it is not a promise about where funds are.', evidenceIds: [id] });
    if (fresh.state === 'refresh_failed') findings.push({ id: 'refresh_failed', severity: 'attention', title: 'Status refresh failed', detail: `The last status read failed (${fresh.error}). The status shown is the last one stored, and it may be stale. Ferry did not invent a newer status.`, evidenceIds: [id] });
    else if (fresh.state === 'stale' || (fresh.state === 'never_checked' && fresh.attention)) findings.push({ id: 'stale_status', severity: 'attention', title: 'Provider status is stale', detail: fresh.state === 'never_checked' ? 'This quote has no successful status read, and it is older than the freshness window.' : `The last successful status read was ${q.last_polled_at}. That is older than the freshness window.`, evidenceIds: [id] });
    if (status === 'PENDING_DEPOSIT' && deadlinePassed) findings.push({ id: 'late_deposit_risk', severity: 'attention', title: 'Quote deadline passed', detail: 'The quote deadline is when 1Click says the deposit address becomes inactive and funds may be lost. A late deposit is not a safe refund. Ferry does not promise one. This is separate from the local invoice expiry.', evidenceIds: [id] });
    if (!detail.statusCorrelationId && q.last_polled_at && !fresh.error) pushUnknown(unknowns, 'correlationId', q.id, 'The stored status read has no status correlation id.');
  }

  if (extra) findings.push({ id: 'merchant_refund_review', severity: 'attention', title: 'More than one swap settled', detail: 'More than one deposit for this order verified as SUCCESS. That is a merchant refund-after-settlement problem. It is not the provider REFUNDED status. Ferry can only show the evidence and copy details. It does not send the refund.', evidenceIds: quotes.filter((q) => q.remote_status === 'SUCCESS' && flag(q.verified) === true).map((q) => `quote:${q.id}`) });

  const invoiceExpired = Number.isFinite(Date.parse(order.expires_at)) && Date.parse(order.expires_at) <= nowMs;
  if (invoiceExpired && seen.depositInFlight) findings.push({ id: 'local_expiry_separate', severity: 'info', title: 'Local invoice expiry does not hide this deposit', detail: 'The Ferry invoice time has passed, and a provider deposit is still on record. Provider status has no EXPIRED value. The deposit stays visible.', evidenceIds: quotes.map((q) => `quote:${q.id}`) });
  if (!quotes.length && invoiceExpired) findings.push({ id: 'invoice_expired_no_deposit', severity: 'info', title: 'Invoice expired before any quote', detail: 'The local invoice expired and no deposit address was issued. There is no provider status to hide.', evidenceIds: [`order:${order.id}`] });

  findings.push({ id: 'exact_output_conditional', severity: 'info', title: 'Exact output is conditional', detail: 'EXACT_OUTPUT fixes the destination amount only if an eligible swap actually completes. It is not fiat and not an unconditional promise. amountIn is the suggested input with slippage buffer. minAmountIn is the minimum.', evidenceIds: [`order:${order.id}`] });

  const attention = findings.some((f) => f.severity === 'attention');
  let lane = 'open';
  if (seen.verified && !extra && !attention) lane = 'paid';
  else if (attention) lane = 'attention';
  else if (seen.active || seen.pendingLive || seen.incomplete) lane = 'processing';
  else if (order.status === 'paid' && !extra) lane = 'paid';
  else if (seen.pendingLate || seen.refunded || seen.failed || seen.unverified || order.status === 'needs_review') lane = 'attention';
  else lane = 'open';

  // A verified payment with a second deposit still moving is not a clean paid lane.
  if (lane === 'paid' && (seen.active || seen.incomplete || seen.pendingLive)) lane = 'attention';

  const freshnessStates = perQuote.map((q) => q.freshness.state);
  let freshness = 'no_quote';
  if (quotes.length) {
    if (freshnessStates.includes('refresh_failed')) freshness = 'refresh_failed';
    else if (freshnessStates.includes('stale') || freshnessStates.some((s, i) => s === 'never_checked' && perQuote[i].freshness.attention)) freshness = 'stale';
    else if (freshnessStates.every((s) => s === 'terminal')) freshness = 'terminal';
    else if (freshnessStates.includes('never_checked')) freshness = 'never_checked';
    else freshness = 'fresh';
  }

  return {
    source: 'rules',
    label: 'Deterministic rules — not an AI judgment',
    lane,
    orderStatus: order.status,
    extraPayment: extra,
    findings,
    unknowns,
    quotes: perQuote,
    freshness: { state: freshness, quotes: perQuote.map((q) => ({ quoteId: q.id, ...q.freshness })) },
    changesPaymentState: false,
  };
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

// Facts the narrative model is allowed to see. No payout recipient, no refund address, no signature.
export function caseFacts({ order, quotes = [], events = [], diagnosis, refreshAttempted = false }) {
  const evidenceIds = new Set([`order:${order.id}`]);
  for (const ev of events) if (ev.id != null) evidenceIds.add(`event:${ev.id}`);
  const quoteFacts = quotes.map((q) => {
    const detail = parseDetail(q);
    const deposited = baseOrNull(detail.depositedAmount);
    const comparison = compareDeposit({ deposited, minAmountIn: q.min_amount_in, amountIn: q.amount_in });
    const qid = `quote:${q.id}`;
    evidenceIds.add(qid);
    if (q.correlation_id) evidenceIds.add(`correlation:${q.correlation_id}`);
    if (typeof detail.statusCorrelationId === 'string' && detail.statusCorrelationId) evidenceIds.add(`status-correlation:${detail.statusCorrelationId}`);
    const txs = [];
    for (const list of [detail.originChainTxs, detail.destinationChainTxs]) {
      for (const tx of Array.isArray(list) ? list : []) if (tx?.hash) { evidenceIds.add(`tx:${tx.hash}`); txs.push({ hash: tx.hash, explorerUrl: tx.explorerUrl || null }); }
    }
    for (const h of Array.isArray(detail.nearTxHashes) ? detail.nearTxHashes : []) if (h) { evidenceIds.add(`tx:${h}`); txs.push({ hash: String(h), explorerUrl: null }); }
    return {
      evidenceId: qid,
      correlationId: q.correlation_id || null,
      statusCorrelationId: detail.statusCorrelationId || null,
      remoteStatus: q.remote_status,
      verified: flag(q.verified),
      originSymbol: q.origin_symbol,
      originChain: q.origin_chain,
      amountInBase: q.amount_in,
      minAmountInBase: q.min_amount_in,
      amountInMeaning: 'buffered suggested input',
      minAmountInMeaning: 'minimum input required for an eligible swap',
      depositComparison: comparison,
      deadline: q.deadline,
      providerUpdatedAt: typeof detail.updatedAt === 'string' ? detail.updatedAt : null,
      lastPolledAt: q.last_polled_at || null,
      lastPollError: typeof detail.lastPollError === 'string' ? detail.lastPollError : null,
      depositedAmountBase: deposited,
      amountOutBase: baseOrNull(detail.amountOut),
      refundedAmountBase: baseOrNull(detail.refundedAmount),
      refundReason: typeof detail.refundReason === 'string' ? detail.refundReason : null,
      depositAddress: q.deposit_address,
      depositMemo: q.deposit_memo || null,
      transactions: txs,
    };
  });
  const failed = quoteFacts.filter((q) => q.lastPollError).map((q) => ({ evidenceId: q.evidenceId, error: q.lastPollError }));
  const facts = {
    kind: 'ferry_order_evidence',
    orderId: order.id,
    itemName: order.item_name,
    storedStatus: order.status,
    lane: diagnosis.lane,
    extraPayment: diagnosis.extraPayment,
    destination: { amountBase: order.amount_out_base, symbol: order.dest_symbol, chain: order.dest_chain, assetId: order.dest_asset_id },
    exactOutput: 'Destination base units are conditional on a successful eligible execution. Not fiat. Not unconditional.',
    invoiceExpiresAt: order.expires_at,
    rulesLabel: diagnosis.label,
    findings: diagnosis.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, evidenceIds: f.evidenceIds })),
    unknowns: diagnosis.unknowns,
    freshness: diagnosis.freshness.state,
    refresh: { attempted: refreshAttempted, failedQuotes: failed },
    quotes: quoteFacts,
    evidenceIds: [...evidenceIds].sort(),
  };
  return { facts: stable(facts), evidenceIds: [...evidenceIds].sort(), refreshFailed: failed.length > 0 };
}
