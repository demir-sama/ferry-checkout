// Pure, deterministic rules that decide whether a 1Click status proves an order was paid.
// The only path to "paid" is a server-side 1Click /v0/status response that matches the stored quote exactly.

export function verifySuccess(order, quote, statusResp) {
  const problems = [];
  const qr = statusResp?.quoteResponse;
  if (!qr) problems.push('status response has no quoteResponse');
  const req = qr?.quoteRequest || {};
  const q = qr?.quote || {};
  if (q.depositAddress !== quote.deposit_address) problems.push('deposit address mismatch');
  if ((q.depositMemo || null) !== (quote.deposit_memo || null)) problems.push('deposit memo mismatch');
  if (qr?.signature !== quote.signature) problems.push('quote signature mismatch');
  if (req.swapType !== 'EXACT_OUTPUT') problems.push('swap type is not EXACT_OUTPUT');
  if (req.recipient !== order.recipient) problems.push('recipient mismatch');
  if (req.destinationAsset !== order.dest_asset_id) problems.push('destination asset mismatch');
  if (req.amount !== order.amount_out_base) problems.push('amount mismatch');
  const settled = statusResp?.swapDetails?.amountOut;
  if (settled != null && /^\d+$/.test(String(settled)) && BigInt(settled) < BigInt(order.amount_out_base)) problems.push('settled amount below order amount');
  return { ok: problems.length === 0, problems };
}

const ACTIVE = new Set(['KNOWN_DEPOSIT_TX', 'PROCESSING']);

// Derive the order status from all of its quotes. `nowMs` injected for testability.
export function deriveOrderStatus(order, quotes, nowMs = Date.now()) {
  if (order.status === 'paid') return { status: 'paid' };
  const verified = quotes.find((q) => q.remote_status === 'SUCCESS' && q.verified === true);
  if (verified) return { status: 'paid', paidQuoteId: verified.id };
  if (quotes.some((q) => q.remote_status === 'SUCCESS' && q.verified === false)) return { status: 'needs_review', note: 'A swap reported SUCCESS but did not match this order. Not marked paid.' };
  if (quotes.some((q) => ACTIVE.has(q.remote_status))) return { status: 'processing' };
  if (quotes.some((q) => q.remote_status === 'INCOMPLETE_DEPOSIT')) return { status: 'incomplete_deposit' };
  const live = quotes.filter((q) => q.remote_status === 'PENDING_DEPOSIT' && Date.parse(q.deadline) > nowMs);
  if (live.length) return { status: 'awaiting_deposit' };
  if (quotes.length && quotes.some((q) => q.remote_status === 'REFUNDED')) return { status: 'refunded' };
  if (quotes.some((q) => q.remote_status === 'FAILED')) return { status: 'failed' };
  if (Date.parse(order.expires_at) <= nowMs) return { status: 'expired' };
  return { status: quotes.length ? 'quote_expired' : 'open' };
}

export const TERMINAL_ORDER = new Set(['paid', 'expired']);
export const BLOCKS_NEW_QUOTE = new Set(['paid', 'processing', 'incomplete_deposit', 'needs_review', 'expired']);
