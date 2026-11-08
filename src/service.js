// Domain logic: merchants, products, orders, quotes and status reconciliation.
import { randomId, sha256 } from './ids.js';
import { now, tx } from './db.js';
import { parseUnits, formatUnits, isBaseUnitString } from './amounts.js';
import { validateAddress, canBePayoutChain } from './addresses.js';
import { verifySuccess, deriveOrderStatus, BLOCKS_NEW_QUOTE } from './reconcile.js';
import { REMOTE_STATUSES } from './oneclick.js';

export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const MAX_QUOTES_PER_ORDER = 6;
const POLL_MIN_MS = 4000;
const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function createService({ db, cfg, oneClick, tokens, log = () => {} }) {
  const event = (orderId, kind, detail = {}) =>
    db.prepare('INSERT INTO order_events(order_id, kind, detail, at) VALUES (?,?,?,?)').run(orderId, kind, JSON.stringify(detail), now());

  // ---------- merchants ----------
  function createMerchant({ name, isSample = false }) {
    const id = randomId('mer', 9);
    const accessKey = randomId('fk', 24);
    const t = now();
    db.prepare('INSERT INTO merchants(id,name,access_key_hash,is_sample,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, clean(name, 80) || 'Untitled store', sha256(accessKey), isSample ? 1 : 0, t, t);
    return { id, accessKey };
  }
  const getMerchant = (id) => db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
  function merchantView(m) {
    return { id: m.id, name: m.name, isSample: !!m.is_sample, payout: m.payout_asset_id ? { assetId: m.payout_asset_id, chain: m.payout_chain, symbol: m.payout_symbol, decimals: m.payout_decimals, recipient: m.payout_recipient } : null,
      acceptedAssets: j(m.accepted_assets, []), profile: j(m.profile, {}), createdAt: m.created_at };
  }

  async function updateSettings(merchantId, body) {
    const m = getMerchant(merchantId);
    if (!m) throw new HttpError(404, 'Merchant not found');
    const name = body.name != null ? clean(body.name, 80) : m.name;
    if (!name) throw new HttpError(400, 'Store name is required');
    let payout = { asset: m.payout_asset_id, chain: m.payout_chain, symbol: m.payout_symbol, decimals: m.payout_decimals, recipient: m.payout_recipient };
    if (body.payoutAssetId != null || body.payoutRecipient != null) {
      const tok = await tokens.get(String(body.payoutAssetId || ''));
      if (!tok) throw new HttpError(400, 'Payout asset is not in the live NEAR Intents asset list');
      if (!canBePayoutChain(tok.blockchain)) throw new HttpError(400, `Payouts on ${tok.blockchain} are not supported in this version (address format cannot be validated)`);
      const v = validateAddress(tok.blockchain, body.payoutRecipient);
      if (!v.ok) throw new HttpError(400, `Payout address: ${v.reason}`);
      payout = { asset: tok.assetId, chain: tok.blockchain, symbol: tok.symbol, decimals: tok.decimals, recipient: v.address };
    }
    let accepted = j(m.accepted_assets, []);
    if (Array.isArray(body.acceptedAssets)) {
      const live = (await tokens.list()).list;
      const ids = new Set(live.map((t) => t.assetId));
      accepted = [...new Set(body.acceptedAssets.map(String))].filter((a) => ids.has(a)).slice(0, 60);
    }
    db.prepare('UPDATE merchants SET name=?, payout_asset_id=?, payout_chain=?, payout_symbol=?, payout_decimals=?, payout_recipient=?, accepted_assets=?, updated_at=? WHERE id=?')
      .run(name, payout.asset, payout.chain, payout.symbol, payout.decimals, payout.recipient, JSON.stringify(accepted), now(), merchantId);
    return merchantView(getMerchant(merchantId));
  }

  // ---------- products ----------
  function createProduct(merchantId, { name, description, price }) {
    const m = getMerchant(merchantId);
    if (!m?.payout_asset_id) throw new HttpError(409, 'Set a payout asset and address before adding products');
    const n = clean(name, 80); if (!n) throw new HttpError(400, 'Product name is required');
    let base; try { base = parseUnits(price, m.payout_decimals); } catch (e) { throw new HttpError(400, `Price: ${e.message}`); }
    if (base <= 0n) throw new HttpError(400, 'Price must be greater than zero');
    const id = randomId('prd', 9);
    db.prepare('INSERT INTO products(id,merchant_id,name,description,price_base,asset_id,decimals,symbol,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, merchantId, n, clean(description, 600), base.toString(), m.payout_asset_id, m.payout_decimals, m.payout_symbol, now());
    return productView(db.prepare('SELECT * FROM products WHERE id=?').get(id));
  }
  const productView = (p) => ({ id: p.id, name: p.name, description: p.description, priceBase: p.price_base, price: formatUnits(p.price_base, p.decimals), symbol: p.symbol, assetId: p.asset_id, active: !!p.active, createdAt: p.created_at });
  const listProducts = (merchantId) => db.prepare('SELECT * FROM products WHERE merchant_id=? ORDER BY created_at DESC').all(merchantId).map(productView);
  function setProductActive(merchantId, productId, active) {
    const r = db.prepare('UPDATE products SET active=? WHERE id=? AND merchant_id=?').run(active ? 1 : 0, productId, merchantId);
    if (!r.changes) throw new HttpError(404, 'Product not found');
  }
  function publicProduct(productId) {
    const p = db.prepare('SELECT p.*, m.name AS merchant_name, m.profile FROM products p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=? AND p.active=1').get(productId);
    if (!p) throw new HttpError(404, 'Product not found');
    return { ...productView(p), merchant: { name: p.merchant_name, profile: j(p.profile, {}) } };
  }

  // ---------- orders ----------
  function insertOrder(m, { productId = null, itemName, itemDescription = '', amountBase }) {
    if (!m.payout_asset_id || !m.payout_recipient) throw new HttpError(409, 'This store has not configured a payout destination yet');
    // Payout must still be a supported asset of the same decimals the price was set in.
    const id = randomId('ord', 9);
    const secret = randomId('chk', 24);
    const t = new Date();
    const accepted = j(m.accepted_assets, []);
    db.prepare(`INSERT INTO orders(id,checkout_secret_hash,merchant_id,product_id,item_name,item_description,amount_out_base,dest_asset_id,dest_chain,dest_symbol,dest_decimals,recipient,accepted_assets,status,created_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sha256(secret), m.id, productId, itemName, itemDescription, amountBase, m.payout_asset_id, m.payout_chain, m.payout_symbol, m.payout_decimals,
      m.payout_recipient, JSON.stringify(accepted), 'open', t.toISOString(), new Date(t.getTime() + cfg.orderTtlHours * 3600e3).toISOString(), t.toISOString());
    event(id, 'created', { amountBase, asset: m.payout_asset_id, recipient: m.payout_recipient });
    return { orderId: id, checkoutSecret: secret, checkoutUrl: `${cfg.publicBaseUrl}/c/${secret}` };
  }
  function createOrderForProduct(productId) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId);
    if (!p) throw new HttpError(404, 'Product not found');
    const m = getMerchant(p.merchant_id);
    if (m.payout_asset_id !== p.asset_id) throw new HttpError(409, 'This product is priced in an asset the store no longer accepts as payout; the merchant must re-price it');
    return insertOrder(m, { productId: p.id, itemName: p.name, itemDescription: p.description, amountBase: p.price_base });
  }
  function createInvoice(merchantId, { title, description, amount }) {
    const m = getMerchant(merchantId);
    if (!m?.payout_asset_id) throw new HttpError(409, 'Set a payout asset and address first');
    const n = clean(title, 80); if (!n) throw new HttpError(400, 'Invoice title is required');
    let base; try { base = parseUnits(amount, m.payout_decimals); } catch (e) { throw new HttpError(400, `Amount: ${e.message}`); }
    if (base <= 0n) throw new HttpError(400, 'Amount must be greater than zero');
    return insertOrder(m, { itemName: n, itemDescription: clean(description, 600), amountBase: base.toString() });
  }
  const orderBySecret = (secret) => (typeof secret === 'string' && secret.startsWith('chk_') && secret.length < 80) ? db.prepare('SELECT * FROM orders WHERE checkout_secret_hash=?').get(sha256(secret)) : null;
  const quotesFor = (orderId) => db.prepare('SELECT * FROM quotes WHERE order_id=? ORDER BY created_at ASC').all(orderId);

  function quoteView(q) {
    return { id: q.id, originAssetId: q.origin_asset_id, originSymbol: q.origin_symbol, originChain: q.origin_chain, depositAddress: q.deposit_address, depositMemo: q.deposit_memo,
      amountIn: q.amount_in, amountInFormatted: formatUnits(q.amount_in, q.origin_decimals), minAmountIn: q.min_amount_in, minAmountInFormatted: formatUnits(q.min_amount_in, q.origin_decimals),
      refundTo: q.refund_to, refundFeeFormatted: q.refund_fee && isBaseUnitString(q.refund_fee) ? formatUnits(q.refund_fee, q.origin_decimals) : null,
      deadline: q.deadline, timeEstimateSec: q.time_estimate, remoteStatus: q.remote_status, verified: q.verified == null ? null : !!q.verified,
      detail: j(q.remote_detail, null), createdAt: q.created_at, lastPolledAt: q.last_polled_at };
  }
  function orderView(o, { forMerchant = false } = {}) {
    const m = getMerchant(o.merchant_id);
    const v = { id: o.id, status: o.status, statusNote: o.status_note, item: { name: o.item_name, description: o.item_description },
      amount: { base: o.amount_out_base, formatted: formatUnits(o.amount_out_base, o.dest_decimals), symbol: o.dest_symbol, chain: o.dest_chain, assetId: o.dest_asset_id },
      recipient: o.recipient, merchant: { name: m.name, profile: j(m.profile, {}), isSample: !!m.is_sample }, acceptedAssets: j(o.accepted_assets, []),
      createdAt: o.created_at, expiresAt: o.expires_at, updatedAt: o.updated_at, paidQuoteId: o.paid_quote_id, quotes: quotesFor(o.id).map(quoteView) };
    if (forMerchant) v.events = db.prepare('SELECT kind, detail, at FROM order_events WHERE order_id=? ORDER BY id').all(o.id).map((e) => ({ kind: e.kind, detail: j(e.detail, {}), at: e.at }));
    return v;
  }

  async function createQuote(secret, { originAssetId, refundTo }) {
    const o = orderBySecret(secret);
    if (!o) throw new HttpError(404, 'Checkout not found');
    await refreshOrder(o.id, { force: true });
    const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
    if (BLOCKS_NEW_QUOTE.has(cur.status)) throw new HttpError(409, `A new quote cannot be created while the order is ${cur.status.replace('_', ' ')}`);
    if (quotesFor(o.id).length >= MAX_QUOTES_PER_ORDER) throw new HttpError(429, 'Too many quotes for this order; ask the merchant for a new checkout link');
    const accepted = j(cur.accepted_assets, []);
    if (accepted.length && !accepted.includes(originAssetId)) throw new HttpError(400, 'The merchant does not accept that asset');
    const origin = await tokens.get(String(originAssetId || ''));
    if (!origin) throw new HttpError(400, 'That asset is not in the live NEAR Intents asset list');
    const ref = validateAddress(origin.blockchain, refundTo);
    if (!ref.ok) throw new HttpError(400, `Refund address: ${ref.reason}`);
    const deadline = new Date(Date.now() + cfg.quoteTtlMinutes * 60e3).toISOString();
    const request = { dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: cfg.slippageBps, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: cur.dest_asset_id, amount: cur.amount_out_base, refundTo: ref.address, refundType: 'ORIGIN_CHAIN', recipient: cur.recipient,
      recipientType: 'DESTINATION_CHAIN', deadline, depositMode: 'SIMPLE', referral: 'ferry-checkout' };
    let resp;
    try { resp = await oneClick.quote(request); }
    catch (e) { log('quote error', e.status, e.message); throw new HttpError(e.status === 400 ? 400 : 502, `NEAR Intents could not quote this payment: ${clean(e.message, 240)}`); }
    const q = resp?.quote || {}; const rq = resp?.quoteRequest || {};
    // Defensive: the quote must be for exactly what we asked.
    const mismatch = [];
    if (rq.amount !== request.amount) mismatch.push('amount');
    if (rq.recipient !== request.recipient) mismatch.push('recipient');
    if (rq.destinationAsset !== request.destinationAsset) mismatch.push('destination');
    if (rq.swapType !== 'EXACT_OUTPUT') mismatch.push('swapType');
    if (!q.depositAddress || !resp.signature) mismatch.push('deposit address/signature');
    if (!isBaseUnitString(q.amountIn) || !isBaseUnitString(q.minAmountIn)) mismatch.push('amountIn');
    if (q.amountOut != null && q.amountOut !== request.amount) mismatch.push('amountOut');
    if (mismatch.length) { log('quote rejected', mismatch); throw new HttpError(502, `Quote rejected: response did not match the order (${mismatch.join(', ')})`); }
    const id = randomId('qt', 9);
    tx(db, () => {
      db.prepare(`INSERT INTO quotes(id,order_id,origin_asset_id,origin_symbol,origin_chain,origin_decimals,refund_to,deposit_address,deposit_memo,amount_in,min_amount_in,amount_out,deadline,time_estimate,refund_fee,signature,correlation_id,raw,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.id, origin.assetId, origin.symbol, origin.blockchain, origin.decimals, ref.address, q.depositAddress, q.depositMemo || null,
        q.amountIn, q.minAmountIn, request.amount, q.deadline || deadline, Number.isFinite(q.timeEstimate) ? Math.round(q.timeEstimate) : null,
        q.refundFee || null, resp.signature, resp.correlationId || null, JSON.stringify(resp), now());
      db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run('awaiting_deposit', now(), o.id);
      event(o.id, 'quoted', { quoteId: id, originAsset: origin.assetId, amountIn: q.amountIn, depositAddress: q.depositAddress, correlationId: resp.correlationId });
    });
    return orderView(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
  }

  // Poll 1Click for each non-final quote and recompute order status. Server-authoritative.
  async function refreshOrder(orderId, { force = false } = {}) {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) return null;
    if (o.status !== 'paid') {
      for (const q of quotesFor(orderId)) {
        if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(q.remote_status)) continue;
        if (!force && q.last_polled_at && Date.now() - Date.parse(q.last_polled_at) < POLL_MIN_MS) continue;
        // Stop polling untouched quotes well after their deadline.
        if (q.remote_status === 'PENDING_DEPOSIT' && Date.now() > Date.parse(q.deadline) + 6 * 3600e3) continue;
        let s;
        try { s = await oneClick.status(q.deposit_address, q.deposit_memo); }
        catch (e) {
          db.prepare('UPDATE quotes SET last_polled_at=? WHERE id=?').run(now(), q.id);
          if (e.status !== 404) log('status error', q.id, e.message);
          continue;
        }
        const remote = REMOTE_STATUSES.includes(s?.status) ? s.status : null;
        if (!remote) { log('unknown status', s?.status); continue; }
        let verified = null, problems = null;
        if (remote === 'SUCCESS') { const v = verifySuccess(o, q, s); verified = v.ok ? 1 : 0; problems = v.problems; }
        const sd = s.swapDetails || {};
        const detail = { updatedAt: s.updatedAt, depositedAmountFormatted: sd.depositedAmountFormatted ?? null, amountOutFormatted: sd.amountOutFormatted ?? null,
          refundedAmountFormatted: sd.refundedAmountFormatted ?? null, refundReason: sd.refundReason ?? null,
          originChainTxs: (sd.originChainTxHashes || []).slice(0, 5), destinationChainTxs: (sd.destinationChainTxHashes || []).slice(0, 5), nearTxHashes: (sd.nearTxHashes || []).slice(0, 5) };
        if (remote !== q.remote_status) event(orderId, 'remote_status', { quoteId: q.id, from: q.remote_status, to: remote, verified, problems });
        db.prepare('UPDATE quotes SET remote_status=?, remote_detail=?, verified=?, verify_problems=?, last_polled_at=? WHERE id=?')
          .run(remote, JSON.stringify(detail), verified, problems ? JSON.stringify(problems) : null, now(), q.id);
      }
    }
    const qs = quotesFor(orderId).map((q) => ({ ...q, verified: q.verified == null ? null : !!q.verified }));
    const d = deriveOrderStatus(o, qs);
    if (d.status !== o.status || (d.paidQuoteId && d.paidQuoteId !== o.paid_quote_id)) {
      db.prepare('UPDATE orders SET status=?, paid_quote_id=COALESCE(paid_quote_id, ?), status_note=?, updated_at=? WHERE id=?').run(d.status, d.paidQuoteId || null, d.note || null, now(), orderId);
      event(orderId, 'status', { from: o.status, to: d.status });
    }
    return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  }

  async function checkoutStatus(secret) {
    const o = orderBySecret(secret);
    if (!o) throw new HttpError(404, 'Checkout not found');
    return orderView(await refreshOrder(o.id));
  }
  function checkoutView(secret) {
    const o = orderBySecret(secret);
    if (!o) throw new HttpError(404, 'Checkout not found');
    return orderView(o);
  }
  const listOrders = (merchantId) => db.prepare('SELECT * FROM orders WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200').all(merchantId)
    .map((o) => ({ id: o.id, status: o.status, item: o.item_name, amount: formatUnits(o.amount_out_base, o.dest_decimals), symbol: o.dest_symbol, chain: o.dest_chain, createdAt: o.created_at, updatedAt: o.updated_at }));
  async function merchantOrder(merchantId, orderId, { refresh = false } = {}) {
    let o = db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(orderId, merchantId);
    if (!o) throw new HttpError(404, 'Order not found');
    if (refresh) o = await refreshOrder(o.id, { force: true });
    return orderView(o, { forMerchant: true });
  }
  async function pollActive() {
    const ids = db.prepare(`SELECT DISTINCT o.id FROM orders o JOIN quotes q ON q.order_id=o.id WHERE o.status NOT IN ('paid') AND q.remote_status NOT IN ('SUCCESS','REFUNDED','FAILED')`).all();
    for (const { id } of ids) { try { await refreshOrder(id); } catch (e) { log('poll error', id, e.message); } }
    return ids.length;
  }

  return { createMerchant, getMerchant, merchantView, updateSettings, createProduct, listProducts, setProductActive, publicProduct,
    createOrderForProduct, createInvoice, createQuote, refreshOrder, checkoutStatus, checkoutView, listOrders, merchantOrder, pollActive, orderBySecret };
}
