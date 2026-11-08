// Domain logic: merchants, products, orders, quotes and status reconciliation (async, storage-agnostic).
import { randomId, sha256 } from './ids.js';
import { now } from './db.js';
import { parseUnits, formatUnits, isBaseUnitString } from './amounts.js';
import { validateAddress, canBePayoutChain } from './addresses.js';
import { verifySuccess, deriveOrderStatus, BLOCKS_NEW_QUOTE } from './reconcile.js';
import { REMOTE_STATUSES } from './oneclick.js';
import { diagnoseOrder, caseFacts } from './diagnose.js';
import { presentStoredNarrative } from './narrative-claims.js';
import { toCsv, RECONCILE_HEADERS } from './csv.js';

export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
export const MAX_QUOTES_PER_ORDER = 6;
const POLL_MIN_MS = 4000;
const QUOTE_LOCK_MS = 25000;
const MEMO_CHAINS = new Set(['stellar']); // 1Click: some chains (e.g. stellar) support only MEMO deposits
const FINAL_REMOTE = ['SUCCESS', 'REFUNDED', 'FAILED'];
const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function createService({ db, cfg, oneClick, tokens, log = () => {} }) {
  const event = (x, orderId, kind, detail = {}) => x.run('INSERT INTO order_events(order_id, kind, detail, at) VALUES (?,?,?,?)', [orderId, kind, JSON.stringify(detail), now()]);
  const getOrder = (id, x = db) => x.get('SELECT * FROM orders WHERE id=?', [id]);
  const quotesFor = (orderId, x = db) => x.all('SELECT * FROM quotes WHERE order_id=? ORDER BY created_at ASC, id ASC', [orderId]);

  // ---------- merchants ----------
  async function createMerchant({ name, isSample = false }) {
    const id = randomId('mer', 9); const accessKey = randomId('fk', 24); const t = now();
    await db.run('INSERT INTO merchants(id,name,access_key_hash,is_sample,created_at,updated_at) VALUES (?,?,?,?,?,?)', [id, clean(name, 80) || 'Untitled store', sha256(accessKey), isSample ? 1 : 0, t, t]);
    return { id, accessKey };
  }
  const getMerchant = (id) => db.get('SELECT * FROM merchants WHERE id = ?', [id]);
  function merchantView(m) {
    return { id: m.id, name: m.name, isSample: !!Number(m.is_sample), payout: m.payout_asset_id ? { assetId: m.payout_asset_id, chain: m.payout_chain, symbol: m.payout_symbol, decimals: Number(m.payout_decimals), recipient: m.payout_recipient } : null,
      acceptedAssets: j(m.accepted_assets, []), profile: j(m.profile, {}), createdAt: m.created_at };
  }
  async function updateSettings(merchantId, body) {
    const m = await getMerchant(merchantId);
    if (!m) throw new HttpError(404, 'Merchant not found');
    const name = body.name != null ? clean(body.name, 80) : m.name;
    if (!name) throw new HttpError(400, 'Store name is required');
    let payout = { asset: m.payout_asset_id, chain: m.payout_chain, symbol: m.payout_symbol, decimals: m.payout_decimals, recipient: m.payout_recipient };
    if (body.payoutAssetId != null || body.payoutRecipient != null) {
      const tok = await tokens.get(String(body.payoutAssetId || '').slice(0, 200));
      if (!tok) throw new HttpError(400, 'Payout asset is not in the live NEAR Intents asset list');
      if (!canBePayoutChain(tok.blockchain)) throw new HttpError(400, `Payouts on ${tok.blockchain} are not supported in this version (address format cannot be validated)`);
      const v = validateAddress(tok.blockchain, body.payoutRecipient);
      if (!v.ok) throw new HttpError(400, `Payout address: ${v.reason}`);
      payout = { asset: tok.assetId, chain: tok.blockchain, symbol: tok.symbol, decimals: tok.decimals, recipient: v.address };
    }
    let accepted = j(m.accepted_assets, []);
    if (Array.isArray(body.acceptedAssets)) {
      if (body.acceptedAssets.length > 300) throw new HttpError(400, 'Too many accepted assets');
      const ids = new Set((await tokens.list()).list.map((t) => t.assetId));
      accepted = [...new Set(body.acceptedAssets.map(String))].filter((a) => ids.has(a)).slice(0, 60);
    }
    await db.run('UPDATE merchants SET name=?, payout_asset_id=?, payout_chain=?, payout_symbol=?, payout_decimals=?, payout_recipient=?, accepted_assets=?, updated_at=? WHERE id=?',
      [name, payout.asset, payout.chain, payout.symbol, payout.decimals, payout.recipient, JSON.stringify(accepted), now(), merchantId]);
    return merchantView(await getMerchant(merchantId));
  }
  async function setProfile(merchantId, profile, x = db) { await x.run('UPDATE merchants SET profile=?, updated_at=? WHERE id=?', [JSON.stringify(profile), now(), merchantId]); }

  // ---------- products ----------
  const productView = (p) => ({ id: p.id, name: p.name, description: p.description, priceBase: p.price_base, price: formatUnits(p.price_base, Number(p.decimals)), symbol: p.symbol, assetId: p.asset_id, active: !!Number(p.active), createdAt: p.created_at });
  function priceToBase(price, decimals, label = 'Price') {
    let base; try { base = parseUnits(price, decimals); } catch (e) { throw new HttpError(400, `${label}: ${e.message}`); }
    if (base <= 0n) throw new HttpError(400, `${label} must be greater than zero`);
    if (base.toString().length > 60) throw new HttpError(400, `${label} is too large`);
    return base.toString();
  }
  async function createProduct(merchantId, { name, description, price }, x = db) {
    const m = await x.get('SELECT * FROM merchants WHERE id=?', [merchantId]);
    if (!m?.payout_asset_id) throw new HttpError(409, 'Set a payout asset and address before adding products');
    const n = clean(name, 80); if (!n) throw new HttpError(400, 'Product name is required');
    const base = priceToBase(price, Number(m.payout_decimals));
    const id = randomId('prd', 9);
    await x.run('INSERT INTO products(id,merchant_id,name,description,price_base,asset_id,decimals,symbol,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, merchantId, n, clean(description, 600), base, m.payout_asset_id, m.payout_decimals, m.payout_symbol, now()]);
    return productView(await x.get('SELECT * FROM products WHERE id=?', [id]));
  }
  const listProducts = async (merchantId) => (await db.all('SELECT * FROM products WHERE merchant_id=? ORDER BY created_at DESC', [merchantId])).map(productView);
  async function setProductActive(merchantId, productId, active) {
    const r = await db.run('UPDATE products SET active=? WHERE id=? AND merchant_id=?', [active ? 1 : 0, productId, merchantId]);
    if (!r.changes) throw new HttpError(404, 'Product not found');
  }
  async function publicProduct(productId) {
    const p = await db.get('SELECT p.*, m.name AS merchant_name, m.profile AS merchant_profile, m.is_sample AS merchant_sample FROM products p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=? AND p.active=1', [productId]);
    if (!p) throw new HttpError(404, 'Product not found');
    return { ...productView(p), merchant: { name: p.merchant_name, profile: j(p.merchant_profile, {}), isSample: !!Number(p.merchant_sample) } };
  }

  // ---------- orders ----------
  async function insertOrder(m, { productId = null, itemName, itemDescription = '', amountBase }) {
    if (!m.payout_asset_id || !m.payout_recipient) throw new HttpError(409, 'This store has not configured a payout destination yet');
    const id = randomId('ord', 9); const secret = randomId('chk', 24); const t = new Date();
    await db.tx(async (x) => {
      await x.run(`INSERT INTO orders(id,checkout_secret_hash,merchant_id,product_id,item_name,item_description,amount_out_base,dest_asset_id,dest_chain,dest_symbol,dest_decimals,recipient,accepted_assets,status,created_at,expires_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, sha256(secret), m.id, productId, itemName, itemDescription, amountBase, m.payout_asset_id, m.payout_chain, m.payout_symbol, m.payout_decimals,
        m.payout_recipient, m.accepted_assets, 'open', t.toISOString(), new Date(t.getTime() + cfg.orderTtlHours * 3600e3).toISOString(), t.toISOString()]);
      await event(x, id, 'created', { amountBase, asset: m.payout_asset_id, recipient: m.payout_recipient });
    });
    return { orderId: id, checkoutSecret: secret, checkoutUrl: `${cfg.publicBaseUrl}/c/${secret}` };
  }
  async function createOrderForProduct(productId) {
    const p = await db.get('SELECT * FROM products WHERE id=? AND active=1', [productId]);
    if (!p) throw new HttpError(404, 'Product not found');
    const m = await getMerchant(p.merchant_id);
    if (m.payout_asset_id !== p.asset_id || Number(m.payout_decimals) !== Number(p.decimals)) throw new HttpError(409, 'This product is priced in an asset the store no longer receives; the merchant must re-price it');
    return insertOrder(m, { productId: p.id, itemName: p.name, itemDescription: p.description, amountBase: p.price_base });
  }
  async function createInvoice(merchantId, { title, description, amount }) {
    const m = await getMerchant(merchantId);
    if (!m?.payout_asset_id) throw new HttpError(409, 'Set a payout asset and address first');
    const n = clean(title, 80); if (!n) throw new HttpError(400, 'Invoice title is required');
    return insertOrder(m, { itemName: n, itemDescription: clean(description, 600), amountBase: priceToBase(amount, Number(m.payout_decimals), 'Amount') });
  }
  const orderBySecret = async (secret) => (typeof secret === 'string' && /^chk_[A-Za-z0-9_-]{20,60}$/.test(secret)) ? db.get('SELECT * FROM orders WHERE checkout_secret_hash=?', [sha256(secret)]) : undefined;

  function quoteView(q) {
    const dec = Number(q.origin_decimals);
    const detail = j(q.remote_detail, null);
    const knownAmount = (v) => (isBaseUnitString(v) ? { known: true, base: v, formatted: formatUnits(v, dec) } : { known: false, base: null, formatted: null });
    return { id: q.id, originAssetId: q.origin_asset_id, originSymbol: q.origin_symbol, originChain: q.origin_chain, depositAddress: q.deposit_address, depositMemo: q.deposit_memo,
      amountIn: q.amount_in, amountInFormatted: formatUnits(q.amount_in, dec), minAmountIn: q.min_amount_in, minAmountInFormatted: formatUnits(q.min_amount_in, dec),
      refundTo: q.refund_to, refundFeeFormatted: q.refund_fee && isBaseUnitString(q.refund_fee) ? formatUnits(q.refund_fee, dec) : null,
      deadline: q.deadline, live: q.remote_status === 'PENDING_DEPOSIT' && Date.parse(q.deadline) > Date.now(), timeEstimateSec: q.time_estimate == null ? null : Number(q.time_estimate),
      remoteStatus: q.remote_status, verified: q.verified == null ? null : !!Number(q.verified), correlationId: q.correlation_id || null, detail, createdAt: q.created_at, lastPolledAt: q.last_polled_at,
      evidence: { correlationId: q.correlation_id || null, statusCorrelationId: typeof detail?.statusCorrelationId === 'string' ? detail.statusCorrelationId : null,
        providerUpdatedAt: typeof detail?.updatedAt === 'string' ? detail.updatedAt : null,
        pollError: typeof detail?.lastPollError === 'string' ? detail.lastPollError : null, pollFailedAt: detail?.lastPollFailedAt || null,
        deposited: knownAmount(detail?.depositedAmount), settledOut: knownAmount(detail?.amountOut), refunded: knownAmount(detail?.refundedAmount),
        refundReason: typeof detail?.refundReason === 'string' ? detail.refundReason : null } };
  }
  function eventView(e) { return { id: e.id, kind: e.kind, detail: j(e.detail, {}), at: e.at }; }
  async function orderView(o, { forMerchant = false } = {}) {
    const m = await getMerchant(o.merchant_id);
    const dec = Number(o.dest_decimals);
    const quoteRows = await quotesFor(o.id);
    const v = { id: o.id, status: o.status, statusNote: o.status_note, extraPayment: !!Number(o.extra_payment), item: { name: o.item_name, description: o.item_description },
      amount: { base: o.amount_out_base, formatted: formatUnits(o.amount_out_base, dec), symbol: o.dest_symbol, chain: o.dest_chain, assetId: o.dest_asset_id, decimals: dec },
      recipient: o.recipient, merchant: { name: m.name, profile: j(m.profile, {}), isSample: !!Number(m.is_sample) }, acceptedAssets: j(o.accepted_assets, []),
      createdAt: o.created_at, expiresAt: o.expires_at, updatedAt: o.updated_at, paidQuoteId: o.paid_quote_id, quotes: quoteRows.map(quoteView) };
    if (forMerchant) {
      const events = (await db.all('SELECT id, kind, detail, at FROM order_events WHERE order_id=? ORDER BY id', [o.id])).map(eventView);
      v.diagnosis = diagnoseOrder(o, quoteRows);
      v.notes = events.filter((e) => e.kind === 'resolution_note').map((e) => ({ id: e.detail.noteId || `event:${e.id}`, body: typeof e.detail.body === 'string' ? e.detail.body : '', at: e.at }));
      v.narratives = events.filter((e) => e.kind === 'ai_narrative').map((e) => {
        const shown = presentStoredNarrative(e.detail);
        return { id: e.detail.narrativeId || `event:${e.id}`, status: shown.status, model: e.detail.model || null, at: e.at, factsDigest: e.detail.factsDigest || null, narrative: shown.narrative, errors: shown.errors, refreshFailed: !!e.detail.refreshFailed };
      });
      v.events = events.map((e) => {
        if (e.kind !== 'ai_narrative' || e.detail?.narrative?.claimsChecked === true) return e;
        if (!e.detail?.narrative) return e;
        return { ...e, detail: { ...e.detail, narrative: { withheld: true } } };
      });
    }
    return v;
  }

  // Quote lifecycle. A short DB lease (quote_lock_until) makes quote creation single-flight per order across
  // instances, the counter caps quotes, and a live earlier quote must be explicitly replaced by the buyer.
  async function createQuote(secret, { originAssetId, refundTo, replace = false }) {
    const o = await orderBySecret(secret);
    if (!o) throw new HttpError(404, 'Checkout not found');
    await refreshOrder(o.id, { force: true });
    const cur = await getOrder(o.id);
    if (BLOCKS_NEW_QUOTE.has(cur.status)) throw new HttpError(409, `A new quote cannot be created while the order is ${cur.status.replaceAll('_', ' ')}`, 'ORDER_LOCKED');
    const existing = await quotesFor(o.id);
    if (existing.some((q) => q.remote_status === 'PENDING_DEPOSIT' && Date.parse(q.deadline) > Date.now()) && replace !== true)
      throw new HttpError(409, 'Deposit instructions are already active for this order. Confirm that you have not sent funds to them before requesting new ones.', 'LIVE_QUOTE_EXISTS');
    const accepted = j(cur.accepted_assets, []);
    const assetId = String(originAssetId || '').slice(0, 200);
    if (accepted.length && !accepted.includes(assetId)) throw new HttpError(400, 'The merchant does not accept that asset');
    const origin = await tokens.get(assetId);
    if (!origin) throw new HttpError(400, 'That asset is not in the live NEAR Intents asset list');
    const dest = await tokens.get(cur.dest_asset_id);
    if (!dest) throw new HttpError(409, 'The merchant\'s payout asset is no longer listed by NEAR Intents, so this order cannot be quoted');
    if (dest.decimals !== Number(cur.dest_decimals)) throw new HttpError(409, 'The payout asset\'s decimals changed since this order was created; the order cannot be quoted safely', 'DECIMALS_CHANGED');
    const ref = validateAddress(origin.blockchain, refundTo);
    if (!ref.ok) throw new HttpError(400, `Refund address: ${ref.reason}`);

    const leaseUntil = new Date(Date.now() + QUOTE_LOCK_MS).toISOString();
    const lease = await db.run(`UPDATE orders SET quote_lock_until=?, quote_count=quote_count+1 WHERE id=? AND quote_count < ? AND (quote_lock_until IS NULL OR quote_lock_until < ?)
      AND status NOT IN ('paid','processing','incomplete_deposit','needs_review','expired')`, [leaseUntil, o.id, MAX_QUOTES_PER_ORDER, now()]);
    if (!lease.changes) {
      const again = await getOrder(o.id);
      if (Number(again.quote_count) >= MAX_QUOTES_PER_ORDER) throw new HttpError(429, 'Too many quotes for this order; ask the merchant for a new checkout link', 'QUOTE_LIMIT');
      throw new HttpError(409, 'Another quote request for this order is in progress; try again in a moment', 'QUOTE_IN_PROGRESS');
    }
    try {
      const deadline = new Date(Date.now() + cfg.quoteTtlMinutes * 60e3).toISOString();
      const memoMode = MEMO_CHAINS.has(origin.blockchain);
      const request = { dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: cfg.slippageBps, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
        destinationAsset: cur.dest_asset_id, amount: cur.amount_out_base, refundTo: ref.address, refundType: 'ORIGIN_CHAIN', recipient: cur.recipient,
        recipientType: 'DESTINATION_CHAIN', deadline, depositMode: memoMode ? 'MEMO' : 'SIMPLE', referral: 'ferry-checkout' };
      let resp;
      try { resp = await oneClick.quote(request); }
      catch (e) { log('quote error', e.status, e.message); throw new HttpError(e.status === 400 ? 400 : 502, `NEAR Intents could not quote this payment: ${clean(e.message, 240)}`, 'QUOTE_FAILED'); }
      const problems = checkQuoteResponse(request, resp, { memoMode });
      if (problems.length) { log('quote rejected', problems); throw new HttpError(502, `Quote rejected: response did not match the order (${problems.join(', ')})`, 'QUOTE_MISMATCH'); }
      const q = resp.quote; const id = randomId('qt', 9);
      await db.tx(async (x) => {
        await x.run(`INSERT INTO quotes(id,order_id,origin_asset_id,origin_symbol,origin_chain,origin_decimals,refund_to,deposit_address,deposit_memo,amount_in,min_amount_in,amount_out,deadline,time_estimate,refund_fee,signature,correlation_id,raw,created_at,last_polled_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, o.id, origin.assetId, origin.symbol, origin.blockchain, origin.decimals, ref.address, q.depositAddress, q.depositMemo || null,
          q.amountIn, q.minAmountIn, request.amount, q.deadline || deadline, Number.isFinite(q.timeEstimate) ? Math.round(q.timeEstimate) : null,
          isBaseUnitString(q.refundFee) ? q.refundFee : null, resp.signature, resp.correlationId || null, JSON.stringify(resp), now(), null]);
        await x.run(`UPDATE orders SET status=CASE WHEN status IN ('open','quote_expired','refunded','failed','awaiting_deposit') THEN 'awaiting_deposit' ELSE status END, updated_at=? WHERE id=?`, [now(), o.id]);
        await event(x, o.id, 'quoted', { quoteId: id, originAsset: origin.assetId, amountIn: q.amountIn, minAmountIn: q.minAmountIn, depositAddress: q.depositAddress, replaced: existing.length > 0, correlationId: resp.correlationId });
      });
      return orderView(await getOrder(o.id));
    } finally {
      await db.run('UPDATE orders SET quote_lock_until=NULL WHERE id=? AND quote_lock_until=?', [o.id, leaseUntil]);
    }
  }

  // Poll 1Click for every non-final quote (including after the order is paid, to catch a second payment).
  async function refreshOrder(orderId, { force = false } = {}) {
    const o = await getOrder(orderId);
    if (!o) return null;
    for (const q of await quotesFor(orderId)) {
      if (FINAL_REMOTE.includes(q.remote_status)) continue;
      if (!force && q.last_polled_at && Date.now() - Date.parse(q.last_polled_at) < POLL_MIN_MS) continue;
      if (q.remote_status === 'PENDING_DEPOSIT' && Date.now() > Date.parse(q.deadline) + 6 * 3600e3) continue;
      let s;
      try { s = await oneClick.status(q.deposit_address, q.deposit_memo); }
      catch (e) {
        const prev = j(q.remote_detail, {}) || {};
        const message = clean(e.message || 'status request failed', 240);
        await db.run('UPDATE quotes SET last_polled_at=?, remote_detail=? WHERE id=?', [now(), JSON.stringify({ ...prev, lastPollError: message, lastPollFailedAt: now() }), q.id]);
        if (e.status !== 404) log('status error', q.id, e.message);
        continue;
      }
      const remote = REMOTE_STATUSES.includes(s?.status) ? s.status : null;
      if (!remote) {
        const prev = j(q.remote_detail, {}) || {};
        await db.run('UPDATE quotes SET last_polled_at=?, remote_detail=? WHERE id=?', [now(), JSON.stringify({ ...prev, lastPollError: `unrecognised provider status: ${clean(s?.status, 40)}`, lastPollFailedAt: now() }), q.id]);
        log('unknown status', s?.status);
        continue;
      }
      let verified = null, problems = null;
      if (remote === 'SUCCESS') { const v = verifySuccess(o, q, s); verified = v.ok ? 1 : 0; problems = v.problems; }
      const sd = s.swapDetails || {};
      const txs = (a) => (Array.isArray(a) ? a : []).slice(0, 5).filter((t) => t && typeof t.hash === 'string').map((t) => ({ hash: t.hash.slice(0, 140), explorerUrl: typeof t.explorerUrl === 'string' && /^https:\/\//.test(t.explorerUrl) ? t.explorerUrl.slice(0, 300) : null }));
      const detail = { updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null, statusCorrelationId: typeof s.correlationId === 'string' ? s.correlationId.slice(0, 80) : null,
        depositedAmount: isBaseUnitString(sd.depositedAmount) ? sd.depositedAmount : null, amountOut: isBaseUnitString(sd.amountOut) ? sd.amountOut : null,
        refundedAmount: isBaseUnitString(sd.refundedAmount) ? sd.refundedAmount : null, refundReason: typeof sd.refundReason === 'string' ? sd.refundReason.slice(0, 200) : null,
        originChainTxs: txs(sd.originChainTxHashes), destinationChainTxs: txs(sd.destinationChainTxHashes), nearTxHashes: (sd.nearTxHashes || []).slice(0, 5).map(String) };
      await db.tx(async (x) => {
        const r = await x.run(`UPDATE quotes SET remote_status=?, remote_detail=?, verified=?, verify_problems=?, last_polled_at=? WHERE id=? AND remote_status NOT IN ('SUCCESS','REFUNDED','FAILED')`,
          [remote, JSON.stringify(detail), verified, problems ? JSON.stringify(problems) : null, now(), q.id]);
        if (r.changes && remote !== q.remote_status) await event(x, orderId, 'remote_status', { quoteId: q.id, from: q.remote_status, to: remote, verified, problems });
      });
    }
    return db.tx(async (x) => {
      const fresh = await getOrder(orderId, x);
      const qs = (await quotesFor(orderId, x)).map((q) => ({ ...q, verified: q.verified == null ? null : !!Number(q.verified) }));
      const d = deriveOrderStatus(fresh, qs);
      const verifiedPaid = qs.filter((q) => q.remote_status === 'SUCCESS' && q.verified === true);
      const extra = verifiedPaid.length > 1 ? 1 : 0;
      if (d.status !== fresh.status || (d.paidQuoteId && !fresh.paid_quote_id) || extra !== Number(fresh.extra_payment)) {
        const note = extra ? 'More than one deposit settled for this order. The merchant received the amount more than once and should refund the buyer.' : (d.note || null);
        await x.run('UPDATE orders SET status=?, paid_quote_id=COALESCE(paid_quote_id, ?), status_note=?, extra_payment=?, updated_at=? WHERE id=?', [d.status, d.paidQuoteId || null, note, extra, now(), orderId]);
        if (d.status !== fresh.status) await event(x, orderId, 'status', { from: fresh.status, to: d.status });
        if (extra && !Number(fresh.extra_payment)) await event(x, orderId, 'extra_payment', { quotes: verifiedPaid.map((q) => q.id) });
      }
      return getOrder(orderId, x);
    });
  }

  async function checkoutStatus(secret) { const o = await orderBySecret(secret); if (!o) throw new HttpError(404, 'Checkout not found'); return orderView(await refreshOrder(o.id)); }
  async function checkoutView(secret) { const o = await orderBySecret(secret); if (!o) throw new HttpError(404, 'Checkout not found'); return orderView(o); }
  async function checkoutQuote(secret, quoteId) {
    const o = await orderBySecret(secret); if (!o) throw new HttpError(404, 'Checkout not found');
    const q = await db.get('SELECT * FROM quotes WHERE id=? AND order_id=?', [quoteId, o.id]); if (!q) throw new HttpError(404, 'Quote not found');
    return q;
  }
  async function listOrders(merchantId) {
    const rows = await db.all('SELECT * FROM orders WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200', [merchantId]);
    const out = [];
    for (const o of rows) {
      const qs = await quotesFor(o.id);
      const d = diagnoseOrder(o, qs);
      out.push({ id: o.id, status: o.status, lane: d.lane, freshness: d.freshness.state, extraPayment: !!Number(o.extra_payment), item: o.item_name,
        amount: formatUnits(o.amount_out_base, Number(o.dest_decimals)), symbol: o.dest_symbol, chain: o.dest_chain, createdAt: o.created_at, updatedAt: o.updated_at,
        attention: d.findings.filter((f) => f.severity === 'attention').map((f) => f.title) });
    }
    return out;
  }
  async function addResolutionNote(merchantId, orderId, body) {
    if (typeof body !== 'string') throw new HttpError(400, 'Note must be text');
    const text = clean(body, 2000);
    if (!text) throw new HttpError(400, 'Write a resolution note');
    const o = await db.get('SELECT id, status, amount_out_base, recipient FROM orders WHERE id=? AND merchant_id=?', [orderId, merchantId]);
    if (!o) throw new HttpError(404, 'Order not found');
    const noteId = randomId('nte', 9);
    await db.tx(async (x) => { await event(x, orderId, 'resolution_note', { noteId, body: text }); });
    const after = await getOrder(orderId);
    return { id: noteId, body: text, createdAt: now(), status: after.status, amountBase: after.amount_out_base, recipient: after.recipient };
  }
  async function caseEvidence(merchantId, orderId, { refresh = false } = {}) {
    let o = await db.get('SELECT * FROM orders WHERE id=? AND merchant_id=?', [orderId, merchantId]);
    if (!o) throw new HttpError(404, 'Order not found');
    if (refresh) o = await refreshOrder(o.id, { force: true });
    const quotes = await quotesFor(o.id);
    const events = await db.all('SELECT id, kind, detail, at FROM order_events WHERE order_id=? ORDER BY id', [o.id]);
    const diagnosis = diagnoseOrder(o, quotes);
    return { order: o, quotes, events, diagnosis, ...caseFacts({ order: o, quotes, events, diagnosis, refreshAttempted: refresh }) };
  }
  async function recordNarrative(orderId, detail) {
    await event(db, orderId, 'ai_narrative', detail);
  }
  async function reconciliationCsv(merchantId) {
    const rows = await db.all('SELECT * FROM orders WHERE merchant_id=? ORDER BY created_at ASC LIMIT 200', [merchantId]);
    const out = [];
    const amountCell = (v) => (isBaseUnitString(v) ? v : 'UNKNOWN');
    for (const o of rows) {
      const qs = await quotesFor(o.id);
      const d = diagnoseOrder(o, qs);
      const base = { order_id: o.id, created_at: o.created_at, item: o.item_name, stored_status: o.status, lane: d.lane, amount_base: o.amount_out_base,
        symbol: o.dest_symbol, chain: o.dest_chain, extra_payment: d.extraPayment ? 'yes' : 'no',
        finding_ids: d.findings.filter((f) => f.severity === 'attention').map((f) => f.id).join(' '), unknown_fields: [...new Set(d.unknowns.map((u) => u.field))].join(' ') };
      if (!qs.length) { out.push(base); continue; }
      for (const q of qs) {
        const detail = j(q.remote_detail, {}) || {};
        out.push({ ...base, quote_id: q.id, remote_status: q.remote_status, verified: q.verified == null ? 'UNKNOWN' : (Number(q.verified) ? 'yes' : 'no'),
          amount_in_base: q.amount_in, min_amount_in_base: q.min_amount_in, deposited_amount: amountCell(detail.depositedAmount), amount_out: amountCell(detail.amountOut),
          refunded_amount: amountCell(detail.refundedAmount), refund_reason: typeof detail.refundReason === 'string' ? detail.refundReason : 'UNKNOWN',
          provider_updated_at: typeof detail.updatedAt === 'string' ? detail.updatedAt : 'UNKNOWN', last_polled_at: q.last_polled_at || 'UNKNOWN',
          poll_error: typeof detail.lastPollError === 'string' ? detail.lastPollError : '', correlation_id: q.correlation_id || 'UNKNOWN',
          deposit_address: q.deposit_address, deposit_memo: q.deposit_memo || '' });
      }
    }
    return toCsv(RECONCILE_HEADERS, out);
  }
  async function merchantOrder(merchantId, orderId, { refresh = false } = {}) {
    let o = await db.get('SELECT * FROM orders WHERE id=? AND merchant_id=?', [orderId, merchantId]);
    if (!o) throw new HttpError(404, 'Order not found');
    if (refresh) o = await refreshOrder(o.id, { force: true });
    return orderView(o, { forMerchant: true });
  }
  async function pollActive({ limit = 100 } = {}) {
    const ids = await db.all(`SELECT DISTINCT order_id AS id FROM quotes WHERE remote_status NOT IN ('SUCCESS','REFUNDED','FAILED') AND deadline > ? LIMIT ${Number(limit)}`, [new Date(Date.now() - 6 * 3600e3).toISOString()]);
    for (const { id } of ids) { try { await refreshOrder(id); } catch (e) { log('poll error', id, e.message); } }
    return ids.length;
  }

  return { createMerchant, getMerchant, merchantView, updateSettings, setProfile, createProduct, listProducts, setProductActive, publicProduct, priceToBase,
    createOrderForProduct, createInvoice, createQuote, refreshOrder, checkoutStatus, checkoutView, checkoutQuote, listOrders, merchantOrder, pollActive, orderBySecret,
    addResolutionNote, caseEvidence, recordNarrative, reconciliationCsv };
}

// Validates a /v0/quote response against the request we sent (OpenAPI QuoteResponse/Quote shapes).
export function checkQuoteResponse(request, resp, { memoMode = false } = {}) {
  const p = [];
  const q = resp?.quote || {}; const rq = resp?.quoteRequest || {};
  for (const k of ['amount', 'recipient', 'destinationAsset', 'originAsset', 'refundTo', 'swapType', 'recipientType', 'refundType', 'depositType']) if (rq[k] !== request[k]) p.push(k);
  if (rq.dry !== false) p.push('dry');
  if (typeof q.depositAddress !== 'string' || !q.depositAddress || q.depositAddress.length > 200) p.push('depositAddress');
  if (typeof resp?.signature !== 'string' || !resp.signature) p.push('signature');
  if (!isBaseUnitString(q.amountIn) || !isBaseUnitString(q.minAmountIn)) p.push('amountIn');
  else if (BigInt(q.minAmountIn) > BigInt(q.amountIn) || BigInt(q.amountIn) === 0n) p.push('amountIn<minAmountIn');
  if (q.amountOut !== request.amount) p.push('amountOut');
  if (q.minAmountOut != null && q.minAmountOut !== request.amount) p.push('minAmountOut');
  if (memoMode && !q.depositMemo) p.push('depositMemo missing');
  if (q.depositMemo != null && (typeof q.depositMemo !== 'string' || q.depositMemo.length > 200)) p.push('depositMemo');
  if (q.deadline && Number.isNaN(Date.parse(q.deadline))) p.push('deadline');
  return p;
}
