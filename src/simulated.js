// Fixed demonstration cases. They are computed by the same rules as live orders and are never inserted
// into the orders table, so they cannot change paid / processing / attention counts.
import { diagnoseOrder } from './diagnose.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const PAST = '2026-11-08T10:00:00.000Z';
const RECENT = '2026-11-08T11:56:00.000Z';
const FUTURE = '2026-11-08T18:00:00.000Z';
const OLD = '2026-11-07T12:00:00.000Z';

function order(status, extra = {}) {
  return {
    id: extra.id || 'ord_simulated', status, extra_payment: extra.extra ? 1 : 0, item_name: extra.item || 'Simulated item',
    amount_out_base: '2000000', dest_symbol: 'USDC', dest_chain: 'near', dest_decimals: 6, dest_asset_id: 'nep141:usdc.sim',
    expires_at: extra.expires || FUTURE, created_at: OLD, updated_at: PAST,
  };
}
function quote(partial) {
  return {
    id: partial.id, remote_status: partial.status, verified: partial.verified ?? null, deadline: partial.deadline || FUTURE,
    amount_in: '2025107', min_amount_in: '2004902', amount_out: '2000000', origin_symbol: 'USDC', origin_decimals: 6, origin_chain: 'base',
    deposit_address: '0xFERRYSAMPLEDEPOSIT', deposit_memo: null, correlation_id: `sim-${partial.id}`,
    created_at: partial.created || RECENT, last_polled_at: partial.polled === undefined ? RECENT : partial.polled,
    remote_detail: partial.detail ?? {},
  };
}

const CASES = [
  {
    id: 'sim-buffer', title: 'Deposit inside the slippage buffer',
    teaches: 'A deposit below amountIn and at least minAmountIn is not a shortfall. amountIn is only the buffered suggestion.',
    order: order('processing'),
    quotes: [quote({ id: 'qt_buffer', status: 'PROCESSING', detail: { depositedAmount: '2010000', updatedAt: PAST, statusCorrelationId: 'sim-status-buffer' } })],
  },
  {
    id: 'sim-unknown-partial', title: 'Partial deposit with no reported size',
    teaches: 'INCOMPLETE_DEPOSIT without depositedAmount stays UNKNOWN. The shortfall is not inferred from amountIn.',
    order: order('incomplete_deposit'),
    quotes: [quote({ id: 'qt_unknown', status: 'INCOMPLETE_DEPOSIT', detail: { updatedAt: PAST, statusCorrelationId: 'sim-status-unknown' } })],
  },
  {
    id: 'sim-below-min', title: 'Deposit below the minimum',
    teaches: 'When both numbers are present, the shortfall is minAmountIn minus the deposit, in base units.',
    order: order('incomplete_deposit'),
    quotes: [quote({ id: 'qt_short', status: 'INCOMPLETE_DEPOSIT', detail: { depositedAmount: '1000000', updatedAt: PAST, statusCorrelationId: 'sim-status-short' } })],
  },
  {
    id: 'sim-seen', title: 'Deposit transaction seen',
    teaches: 'KNOWN_DEPOSIT_TX means a transaction was seen. It is not settlement.',
    order: order('processing'),
    quotes: [quote({ id: 'qt_seen', status: 'KNOWN_DEPOSIT_TX', detail: { depositedAmount: '2025107', updatedAt: PAST, originChainTxHashes: [{ hash: '0xSIMTX', explorerUrl: 'https://example.invalid/tx/0xSIMTX' }] } })],
  },
  {
    id: 'sim-late', title: 'Deadline passed, no deposit reported',
    teaches: 'After the quote deadline the deposit address may be inactive and funds may be lost. There is no promise of a late refund. The provider has no EXPIRED status.',
    order: order('quote_expired'),
    quotes: [quote({ id: 'qt_late', status: 'PENDING_DEPOSIT', deadline: PAST, detail: { updatedAt: PAST } })],
  },
  {
    id: 'sim-local-expiry', title: 'Local invoice expired while a deposit is processing',
    teaches: 'Ferry invoice expiry is local. An in-flight provider deposit stays visible.',
    order: order('processing', { expires: PAST }),
    quotes: [quote({ id: 'qt_local', status: 'PROCESSING', deadline: PAST, detail: { depositedAmount: '2025107', updatedAt: PAST } })],
  },
  {
    id: 'sim-contradiction', title: 'SUCCESS that does not match the order',
    teaches: 'A provider SUCCESS that fails Ferry\'s quote match is not paid.',
    order: order('needs_review'),
    quotes: [quote({ id: 'qt_bad', status: 'SUCCESS', verified: 0, detail: { amountOut: '2000000', depositedAmount: '1000', updatedAt: PAST } })],
  },
  {
    id: 'sim-provider-refund', title: 'Provider refund, amount unreported',
    teaches: 'REFUNDED is a provider swap refund. A missing refundedAmount is UNKNOWN, not zero. It is not a merchant refund.',
    order: order('refunded'),
    quotes: [quote({ id: 'qt_ref', status: 'REFUNDED', detail: { updatedAt: PAST, refundReason: null } })],
  },
  {
    id: 'sim-merchant-refund', title: 'Two settlements, merchant refund still unsent',
    teaches: 'extra payment means the merchant was paid more than once. Review and copy only. Ferry does not send the refund.',
    order: order('paid', { extra: true }),
    quotes: [
      quote({ id: 'qt_one', status: 'SUCCESS', verified: 1, detail: { amountOut: '2000000', depositedAmount: '2025107', updatedAt: PAST } }),
      quote({ id: 'qt_two', status: 'SUCCESS', verified: 1, detail: { amountOut: '2000000', depositedAmount: '2025107', updatedAt: PAST } }),
    ],
  },
  {
    id: 'sim-stale', title: 'Status refresh failed',
    teaches: 'A failed refresh stays a failure. The last stored status is not described as freshly confirmed.',
    order: order('awaiting_deposit'),
    quotes: [quote({ id: 'qt_stale', status: 'PENDING_DEPOSIT', detail: { lastPollError: '1Click HTTP 503', lastPollFailedAt: PAST } })],
  },
];

export function simulatedCases(nowMs = NOW) {
  return {
    simulated: true,
    liveSettlement: false,
    label: 'SIMULATED',
    notice: 'SIMULATED demonstration cases. They are not stored orders, not live settlement, and they are excluded from merchant counts.',
    generatedAt: new Date(nowMs).toISOString(),
    cases: CASES.map((c) => ({
      id: c.id, title: c.title, teaches: c.teaches, simulated: true, liveSettlement: false, label: 'SIMULATED',
      diagnosis: diagnoseOrder(c.order, c.quotes, { nowMs }),
    })),
  };
}
