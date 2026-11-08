import { $, $$, el, api, STATUS_LABEL, statusTone, LANE_LABEL, copyButton, fmtTime, fill } from './common.js';
import { freshnessCopy, renderSimCard } from './case-view.js';
let me = null, assets = [], nearAi = null;
const PAYOUT_CHAINS = new Set(['near', 'sol', 'eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'scroll', 'monad', 'xlayer', 'plasma', 'adi', 'aurora', 'abs', 'hlevm', 'hood']);
const msg = (id, text, tone) => { const n = $(id); n.textContent = text || ''; n.style.color = tone === 'err' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : ''; };

async function boot() {
  try { const d = await api('/api/merchant'); me = d.merchant; nearAi = d.nearAi; }
  catch (e) { if (e.status === 401) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; } throw e; }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  assets = (await api('/api/assets')).assets;
  renderHeader(); renderSettings(); renderAccepted(); renderUnits(); loadProducts(); loadOrders(); renderAiStatus(); loadDrafts(); renderEmbed();
}
function renderHeader() {
  $('#store-name').textContent = me.name;
  fill($('#sample-flag'), me.isSample ? el('span', { class: 'pill warn' }, 'Sample merchant (demo)') : '');
}
function renderUnits() { const u = me.payout ? `(${me.payout.symbol} on ${me.payout.chain})` : '(set a payout first)'; $('#p-unit').textContent = u; $('#i-unit').textContent = u; }

function renderSettings() {
  $('#s-name').value = me.name;
  const sel = $('#s-asset');
  const payable = assets.filter((a) => PAYOUT_CHAINS.has(a.blockchain)).sort((a, b) => a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol));
  fill(sel, el('option', { value: '' }, 'Choose the asset you receive…'), ...payable.map((a) => el('option', { value: a.assetId, selected: me.payout?.assetId === a.assetId }, `${a.symbol} · ${a.blockchain}`)));
  $('#s-recipient').value = me.payout?.recipient || '';
  const hint = () => { const a = assets.find((x) => x.assetId === sel.value); $('#recipient-hint').textContent = !a ? 'Paste an address you control.' : a.blockchain === 'near' ? 'A NEAR account such as shop.near or a 64-character implicit account. It must be registered for this token\'s storage, or delivery can fail.' : a.blockchain === 'sol' ? 'A Solana wallet address (base58).' : `A 0x… address on ${a.blockchain}.`; };
  sel.onchange = hint; hint();
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('#s-name').value };
  if ($('#s-asset').value !== (me.payout?.assetId || '') || $('#s-recipient').value.trim() !== (me.payout?.recipient || '')) {
    if (!confirm(`Payouts for new orders will go to:\n${$('#s-recipient').value.trim()}\n\nCrypto payments can't be reversed. Continue?`)) return;
    body.payoutAssetId = $('#s-asset').value; body.payoutRecipient = $('#s-recipient').value.trim();
  }
  try { me = (await api('/api/merchant', { method: 'PUT', body })).merchant; renderHeader(); renderUnits(); msg('#settings-msg', 'Saved.', 'ok'); }
  catch (err) { msg('#settings-msg', err.message, 'err'); }
});

function renderAccepted() {
  const box = $('#asset-list'); const chosen = new Set(me.acceptedAssets);
  const f = $('#asset-filter').value.toLowerCase();
  fill(box, ...assets.filter((a) => !f || `${a.symbol} ${a.blockchain}`.toLowerCase().includes(f)).sort((a, b) => a.symbol.localeCompare(b.symbol)).map((a) =>
    el('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:500;margin:6px 0' }, el('input', { type: 'checkbox', value: a.assetId, checked: chosen.has(a.assetId), style: 'width:auto;min-height:0' }), `${a.symbol} · ${a.blockchain}`)));
  $('#accepted-count').textContent = chosen.size ? `${chosen.size} selected` : 'All live assets accepted';
}
$('#asset-filter').addEventListener('input', renderAccepted);
$('#asset-list').addEventListener('change', (e) => { const s = new Set(me.acceptedAssets); e.target.checked ? s.add(e.target.value) : s.delete(e.target.value); me.acceptedAssets = [...s]; $('#accepted-count').textContent = s.size ? `${s.size} selected (unsaved)` : 'All live assets (unsaved)'; });
$('#save-accepted').addEventListener('click', async () => { try { me = (await api('/api/merchant', { method: 'PUT', body: { acceptedAssets: me.acceptedAssets } })).merchant; renderAccepted(); } catch (e) { alert(e.message); } });

async function loadProducts() {
  const { products } = await api('/api/merchant/products');
  fill($('#product-rows'), ...(products.length ? products.map((p) => el('tr', {},
    el('td', { 'data-label': 'Name' }, el('b', {}, p.name), el('div', { class: 'small muted mono' }, p.id)), el('td', { class: 'mono', 'data-label': 'Price' }, `${p.price} ${p.symbol}`),
    el('td', { 'data-label': 'Link' }, p.active ? el('div', { class: 'row' }, el('a', { href: `/p/${p.id}`, target: '_blank', rel: 'noopener' }, 'Open'), copyButton(`${location.origin}/p/${p.id}`)) : el('span', { class: 'muted' }, 'inactive')),
    el('td', { 'data-label': 'State' }, el('button', { class: 'btn secondary small', type: 'button', onclick: async () => { await api(`/api/merchant/products/${p.id}/${p.active ? 'deactivate' : 'activate'}`, { method: 'POST', body: {} }); loadProducts(); } }, p.active ? 'Deactivate' : 'Activate')))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No products yet.'))]));
  renderEmbed(products.filter((p) => p.active));
}
$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/merchant/products', { method: 'POST', body: { name: $('#p-name').value, description: $('#p-desc').value, price: $('#p-price').value.trim() } }); e.target.reset(); msg('#product-msg', 'Product added.', 'ok'); loadProducts(); }
  catch (err) { msg('#product-msg', err.message, 'err'); }
});
$('#invoice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const o = await api('/api/merchant/orders', { method: 'POST', body: { title: $('#i-title').value, description: $('#i-desc').value, amount: $('#i-amount').value.trim() } });
    e.target.reset(); fill($('#invoice-msg'), 'Checkout link (send it to your buyer): ', el('a', { href: o.checkoutUrl, target: '_blank', rel: 'noopener' }, 'open'), ' ', copyButton(o.checkoutUrl));
    loadOrders();
  } catch (err) { msg('#invoice-msg', err.message, 'err'); }
});

let laneFilter = 'all';
const LANE_TONE = { paid: 'ok', processing: 'warn', attention: 'bad', open: 'warn' };
const EVENT_LABEL = { created: 'Order created', quoted: 'Quote stored', remote_status: 'Provider status changed', status: 'Stored order status changed', extra_payment: 'Second settlement recorded', resolution_note: 'Resolution note saved', ai_narrative: 'NEAR AI narrative stored for review' };
function eventLine(ev) {
  const d = ev.detail || {};
  if (ev.kind === 'ai_narrative' && d.narrative?.withheld) return `${fmtTime(ev.at)} · NEAR AI reply kept on record, not shown`;
  const change = d.from && d.to ? ` ${d.from} → ${d.to}` : d.to ? ` → ${d.to}` : d.quoteId ? ` ${d.quoteId}` : '';
  return `${fmtTime(ev.at)} · ${EVENT_LABEL[ev.kind] || ev.kind}${change}`;
}
function knownAmount(label, reported, symbol) {
  return el('p', { class: 'small' }, el('b', {}, `${label}: `), reported?.known ? `${reported.formatted} ${symbol} · base ${reported.base}` : 'UNKNOWN');
}
async function loadOrders() {
  $('#orders-msg').textContent = 'Loading orders…';
  try {
    const { orders } = await api('/api/merchant/orders');
    const counts = { all: orders.length, paid: 0, processing: 0, attention: 0, open: 0 };
    for (const o of orders) if (counts[o.lane] != null) counts[o.lane] += 1;
    const filters = [['all', `All ${counts.all}`], ['paid', `Paid ${counts.paid}`], ['processing', `Processing ${counts.processing}`], ['attention', `Needs attention ${counts.attention}`], ['open', `Open ${counts.open}`]];
    fill($('#lane-filters'), ...filters.map(([id, label]) => el('button', { type: 'button', 'aria-pressed': String(laneFilter === id), onclick: () => { laneFilter = id; loadOrders(); } }, label)));
    const shown = orders.filter((o) => laneFilter === 'all' || o.lane === laneFilter);
    fill($('#order-rows'), ...(shown.length ? shown.map((o) => el('tr', { 'data-lane': o.lane },
      el('td', { 'data-label': 'Order' }, el('a', { href: `#order-${o.id}`, onclick: (e) => { e.preventDefault(); showOrder(o.id); } }, o.id)),
      el('td', { 'data-label': 'Item' }, o.item),
      el('td', { class: 'mono', 'data-label': 'Amount' }, `${o.amount} ${o.symbol}`),
      el('td', { 'data-label': 'Lane' }, el('span', { class: `pill ${LANE_TONE[o.lane] || 'warn'}` }, LANE_LABEL[o.lane] || o.lane)),
      el('td', { 'data-label': 'Status' }, el('span', { class: `pill ${statusTone(o.status)}` }, STATUS_LABEL[o.status] || o.status), o.extraPayment ? el('div', {}, el('span', { class: 'pill bad' }, 'Extra payment')) : null),
      el('td', { class: 'small', 'data-label': 'Created' }, fmtTime(o.createdAt)))) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, orders.length ? 'Nothing in this lane.' : 'No orders yet. Create a product or a one-off invoice. Simulated cases below are not live orders.'))]));
    $('#orders-msg').textContent = orders.length ? `${counts.paid} paid · ${counts.processing} processing · ${counts.attention} need attention. These counts are stored orders only.` : '';
  } catch (e) { $('#orders-msg').textContent = e.message; fill($('#order-rows'), el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Orders could not be loaded.'))); }
}
$('#reload-orders').addEventListener('click', loadOrders);
$('#export-csv').addEventListener('click', async () => {
  $('#orders-msg').textContent = 'Preparing CSV…';
  try {
    const res = await fetch('/api/merchant/reconciliation.csv', { credentials: 'same-origin' });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || `Export failed (${res.status})`); }
    const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'ferry-reconciliation.csv'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    $('#orders-msg').textContent = 'CSV downloaded. Amounts the provider did not report are UNKNOWN, not zero.';
  } catch (e) { $('#orders-msg').textContent = e.message; }
});
async function loadSimulated() {
  try {
    const data = await api('/api/simulated-cases');
    $('#sim-notice').textContent = data.notice || 'SIMULATED';
    fill($('#sim-cases'), ...(data.cases || []).map(renderSimCard));
  } catch (e) { $('#sim-notice').textContent = e.message; }
}
loadSimulated();
async function showOrder(id, refresh = false) {
  const box = $('#order-detail'); box.classList.remove('hidden');
  fill(box, el('p', {}, refresh ? 'Checking the provider status…' : 'Loading the stored order…'));
  let o;
  try { o = await api(`/api/merchant/orders/${id}${refresh ? '?refresh=1' : ''}`); }
  catch (e) { fill(box, el('p', { class: 'notice err', role: 'alert' }, e.message)); return; }
  const d = o.diagnosis || { findings: [], unknowns: [], freshness: { state: 'no_quote' }, label: 'Deterministic rules — not an AI judgment', lane: 'open' };
  const [tone, freshText] = [d.freshness?.state === 'refresh_failed' ? 'err' : d.freshness?.state === 'fresh' || d.freshness?.state === 'terminal' ? 'ok' : 'warn', freshnessCopy(d.freshness?.state)];
  const quoteCards = o.quotes.map((q) => {
    const ev = q.evidence || {};
    const txs = [...(q.detail?.originChainTxs || []), ...(q.detail?.destinationChainTxs || [])];
    return el('article', { class: 'quote-card' },
      el('h4', {}, `${q.originSymbol} on ${q.originChain} · ${q.remoteStatus}`),
      el('p', { class: 'small' }, 'Suggested amountIn ', el('span', { class: 'mono' }, `${q.amountInFormatted} ${q.originSymbol}`), ' (base ', el('span', { class: 'mono' }, q.amountIn), '). Minimum minAmountIn ', el('span', { class: 'mono' }, `${q.minAmountInFormatted} ${q.originSymbol}`), ' (base ', el('span', { class: 'mono' }, q.minAmountIn), ').'),
      el('p', { class: 'hint' }, 'amountIn is the buffered suggestion. minAmountIn is the minimum. A shortfall is not inferred from amountIn.'),
      knownAmount('Deposited', ev.deposited, q.originSymbol),
      knownAmount('Settled output', ev.settledOut, o.amount.symbol),
      knownAmount('Provider refunded', ev.refunded, q.originSymbol),
      el('p', { class: 'small' }, el('b', {}, 'Refund reason: '), ev.refundReason || 'UNKNOWN'),
      el('p', { class: 'small' }, el('b', {}, 'Provider updatedAt: '), ev.providerUpdatedAt || 'UNKNOWN'),
      el('p', { class: 'small' }, el('b', {}, 'Quote correlation: '), ev.correlationId || 'UNKNOWN', ev.statusCorrelationId ? ` · status correlation ${ev.statusCorrelationId}` : ''),
      el('p', { class: 'small' }, el('b', {}, 'Query identity: '), el('span', { class: 'mono' }, q.depositAddress), q.depositMemo ? ` memo ${q.depositMemo}` : ''),
      el('div', { class: 'row' }, copyButton(q.depositAddress), q.depositMemo ? copyButton(q.depositMemo) : null),
      el('p', { class: 'small' }, el('b', {}, 'Verified match: '), q.verified == null ? 'not checked' : q.verified ? 'yes' : 'no'),
      ev.pollError ? el('p', { class: 'notice err' }, `Last refresh failed ${fmtTime(ev.pollFailedAt)}: ${ev.pollError}`) : null,
      txs.length ? el('p', { class: 'small' }, 'Transactions: ', ...txs.map((t, i) => [i ? ' · ' : '', t.explorerUrl ? el('a', { href: t.explorerUrl, rel: 'noopener noreferrer', target: '_blank' }, t.hash) : t.hash])) : el('p', { class: 'small muted' }, 'No transaction hashes stored.'));
  });
  const noteList = (o.notes || []).map((n) => el('li', {}, el('span', { class: 'small muted' }, fmtTime(n.at)), ' ', n.body));
  const narratives = (o.narratives || []).map((n) => el('article', { class: 'quote-card' },
    el('p', { class: 'kicker' }, n.status === 'stored' ? 'Ferry sentences. NEAR AI selected them. Not a payment decision.' : 'Not shown as a validated explanation'),
    el('p', { class: 'small muted' }, `${fmtTime(n.at)} · ${n.model || 'model unknown'} · evidence ${n.factsDigest || 'unknown'}`),
    n.status === 'stored' && n.narrative ? el('div', {}, el('p', {}, n.narrative.summary), el('p', { class: 'small' }, el('b', {}, 'Review step: '), n.narrative.suggestedReviewStep), el('div', { class: 'row' }, copyButton(n.narrative.suggestedReviewStep)), el('p', { class: 'hint' }, 'Ferry wrote these sentences from stored evidence. NEAR AI only chose which ones. It did not run the step.')) : el('p', { class: 'notice err' }, (n.errors || ['This reply is not shown.']).join(' '))));
  fill(box,
    el('div', { class: 'row', style: 'justify-content:space-between' }, el('h3', {}, `${o.item.name} · ${o.amount.formatted} ${o.amount.symbol}`), el('button', { class: 'btn secondary small', type: 'button', onclick: () => showOrder(id, true) }, 'Refresh provider status')),
    el('p', {}, el('span', { class: `pill ${LANE_TONE[d.lane] || 'warn'}` }, LANE_LABEL[d.lane] || d.lane), ' ', el('span', { class: `pill ${statusTone(o.status)}` }, STATUS_LABEL[o.status] || o.status)),
    o.statusNote ? el('p', {}, o.statusNote) : null,
    el('p', { class: `notice ${tone}` }, freshText),
    o.extraPayment ? el('p', { class: 'notice err' }, 'More than one deposit settled. That is a merchant refund after settlement, which Ferry does not send. Copy the evidence and pay it from your own wallet if you choose to.') : null,
    el('p', { class: 'small muted' }, `Payout: ${o.amount.symbol} on ${o.amount.chain} → `, el('span', { class: 'mono' }, o.recipient), ' ', copyButton(o.recipient)),
    el('h3', { style: 'margin-top:16px' }, d.label || 'Deterministic rules'),
    d.findings?.length ? el('ul', { class: 'small findings' }, d.findings.map((f) => el('li', {}, el('b', {}, f.severity === 'attention' ? 'Attention. ' : 'Rule. '), f.title, '. ', f.detail))) : el('p', { class: 'muted small' }, 'No rule findings.'),
    el('h3', {}, 'Unknowns'),
    d.unknowns?.length ? el('ul', { class: 'small' }, d.unknowns.map((u) => el('li', {}, `${u.field} on ${u.quoteId}: UNKNOWN. ${u.why}`))) : el('p', { class: 'muted small' }, 'No missing provider fields on the stored quotes.'),
    el('h3', {}, 'Quote evidence'),
    o.quotes.length ? el('div', { class: 'grid' }, quoteCards) : el('p', { class: 'muted small' }, 'No quotes stored yet.'),
    el('h3', {}, 'Timeline'),
    o.events?.length ? el('ol', { class: 'timeline' }, o.events.map((ev) => el('li', {}, eventLine(ev)))) : el('p', { class: 'muted small' }, 'No events stored.'),
    el('h3', {}, 'Resolution notes'),
    el('p', { class: 'hint' }, 'A note is a review record. Saving one does not change the price, the payout, or the payment status.'),
    noteList.length ? el('ul', {}, noteList) : el('p', { class: 'muted small' }, 'No resolution notes yet.'),
    el('form', { id: 'note-form' }, el('label', { for: 'note-body' }, 'Add a resolution note'), el('textarea', { id: 'note-body', maxlength: '2000', required: true }), el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn secondary', type: 'submit' }, 'Save note')), el('p', { id: 'note-msg', class: 'hint', role: 'status' })),
    el('h3', {}, 'Optional explanation'),
    el('p', { class: 'hint' }, 'NEAR AI can only pick claim ids and one next step from a list Ferry built for this order. Ferry writes the sentences. Free text is not shown. A rejected reply, or an older reply with a check mark, stays on record and is not shown as validated.'),
    narratives,
    el('div', { class: 'row' }, el('button', { class: 'btn secondary', type: 'button', id: 'explain-btn' }, 'Draft an evidence explanation')),
    el('p', { id: 'explain-msg', class: 'hint', role: 'status' }));
  $('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/merchant/orders/${id}/notes`, { method: 'POST', body: { body: $('#note-body').value } }); $('#note-msg').textContent = 'Note saved. Payment status was not changed.'; showOrder(id); }
    catch (err) { $('#note-msg').textContent = err.message; }
  });
  $('#explain-btn').addEventListener('click', async () => {
    $('#explain-btn').disabled = true; $('#explain-msg').textContent = 'Refreshing the provider status, then asking NEAR AI…';
    try {
      const r = await api(`/api/merchant/orders/${id}/explain`, { method: 'POST', body: {} });
      $('#explain-msg').textContent = r.explanation.status === 'stored' ? 'Explanation stored for review. It did not change the payment.' : `NEAR AI replied, and Ferry rejected it: ${r.explanation.errors.join(' ')}`;
      showOrder(id);
    } catch (err) { $('#explain-msg').textContent = err.message; $('#explain-btn').disabled = false; }
  });
  box.scrollIntoView({ block: 'start' });
}

function renderAiStatus() {
  const tone = { verified: 'ok', unverified: 'warn', auth_failed: 'err', unset: 'warn' }[nearAi.status] || 'warn';
  const extra = nearAi.status === 'unset' ? ' Ferry won\'t invent a draft or switch to another AI provider. Everything else works without it.' : '';
  fill($('#ai-status'), el('p', { class: `notice ${tone}` }, `NEAR AI Cloud (${nearAi.model}): ${nearAi.label}${nearAi.checkedAt ? ` Last checked ${fmtTime(nearAi.checkedAt)}.` : ''}${extra}`));
  $('#ai-go').disabled = !nearAi.configured;
}
async function loadDrafts() {
  const { drafts } = await api('/api/merchant/ai/drafts');
  fill($('#ai-drafts'), ...(drafts.length ? drafts.map((d) => el('div', { class: 'row', style: 'justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0' },
    el('div', {}, el('b', {}, d.brief.slice(0, 60)), el('div', { class: 'small muted' }, `${fmtTime(d.createdAt)} · ${d.model}`)),
    el('div', { class: 'row' }, el('span', { class: `pill ${d.status === 'approved' ? 'ok' : d.status === 'pending' ? 'warn' : 'bad'}` }, d.status), d.status === 'pending' ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => review(d) }, 'Review') : null))) : [el('p', { class: 'muted small' }, 'No drafts yet.')]));
}
$('#ai-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#ai-go').disabled = true; msg('#ai-msg', 'Asking NEAR AI Cloud…');
  try { const { draft } = await api('/api/merchant/ai/drafts', { method: 'POST', body: { brief: $('#ai-brief').value } }); const u = draft.validation.usage; msg('#ai-msg', draft.validation.ok ? `Draft ready for review${u?.completionTokens ? ` (${u.promptTokens} + ${u.completionTokens} tokens)` : ''}.` : `The draft failed validation and was not applied: ${draft.validation.errors.join('; ')}`, draft.validation.ok ? 'ok' : 'err'); loadDrafts(); if (draft.validation.ok) review(draft); }
  catch (err) { msg('#ai-msg', err.message, 'err'); }
  try { nearAi = (await api('/api/merchant')).nearAi; renderAiStatus(); } catch {}
  $('#ai-go').disabled = !nearAi.configured;
});
function review(d) {
  const box = $('#ai-review'); box.classList.remove('hidden');
  const p = me.profile || {}; const x = d.draft;
  const row = (key, label, oldV, newV) => [el('label', { style: 'display:flex;gap:8px;margin:0;align-items:center' }, el('input', { type: 'checkbox', name: 'f', value: key, checked: true, style: 'width:auto;min-height:0' }), label), el('div', { class: 'old' }, oldV || '—'), el('div', { class: 'new' }, newV)];
  const assetName = (id) => { const a = assets.find((t) => t.assetId === id); return a ? `${a.symbol} · ${a.blockchain}` : id; };
  const prods = x.productCopy.map((pc, i) => el('div', { class: 'card', style: 'padding:14px' }, el('label', { style: 'display:flex;gap:8px;margin:0' }, el('input', { type: 'checkbox', name: 'f', value: `product:${i}`, style: 'width:auto;min-height:0' }), `Create product: ${pc.name}`), el('p', { class: 'small muted' }, pc.description),
    el('label', { for: `pp-${i}` }, `Your price (${me.payout ? me.payout.symbol : 'set payout first'}). The AI doesn't set prices.`), el('input', { id: `pp-${i}`, 'data-i': i, inputmode: 'decimal', placeholder: 'required if selected' })));
  fill(box, el('h3', {}, 'Review the AI draft'), el('p', { class: 'small muted' }, 'Choose the fields to apply. Ferry has already checked this draft against a fixed schema and the live asset list. Your payout address and prices stay under your control.'),
    el('div', { class: 'diff' }, el('div', { class: 'h' }, 'Field'), el('div', { class: 'h oldh' }, 'Current'), el('div', { class: 'h' }, 'Proposed'),
      row('tagline', 'Tagline', p.tagline, x.tagline), row('about', 'About', p.about, x.about), row('buttonLabel', 'Button label', p.buttonLabel, x.buttonLabel), row('accent', 'Accent', p.accent, x.accent),
      row('faq', 'FAQ', (p.faq || []).map((f) => f.q).join(' · '), x.faq.map((f) => f.q).join(' · ')),
      row('suggestedAssetIds', 'Add accepted assets', '', x.suggestedAssetIds.map(assetName).join(', ') || '(none)')),
    el('div', { class: 'grid cols-2', style: 'margin-top:16px' }, prods),
    el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'btn', type: 'button', id: 'apply' }, 'Approve selected'), el('button', { class: 'btn secondary', type: 'button', id: 'reject' }, 'Reject draft')), el('p', { class: 'hint', id: 'review-msg', role: 'alert' }));
  $('#apply').onclick = async () => {
    const fields = $$('input[name=f]:checked', box).map((c) => c.value); const productPrices = {};
    for (const i of $$('input[data-i]', box)) if (i.value.trim()) productPrices[i.dataset.i] = i.value.trim();
    try { const r = await api(`/api/merchant/ai/drafts/${d.id}/approve`, { method: 'POST', body: { fields, productPrices } }); me = r.merchant; box.classList.add('hidden'); loadDrafts(); loadProducts(); renderAccepted(); msg('#ai-msg', `Applied. ${r.createdProducts.length} product(s) created.`, 'ok'); }
    catch (err) { msg('#review-msg', err.message, 'err'); }
  };
  $('#reject').onclick = async () => { await api(`/api/merchant/ai/drafts/${d.id}/reject`, { method: 'POST', body: {} }); box.classList.add('hidden'); loadDrafts(); };
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderEmbed(products = []) {
  const id = products[0]?.id || 'prd_YOUR_PRODUCT_ID';
  $('#embed-code').textContent = `<script src="${location.origin}/embed.js" defer></script>\n<div data-ferry-product="${id}" data-ferry-label="${(me?.profile?.buttonLabel || 'Pay with crypto').replace(/"/g, '')}"></div>`;
}

$$('.tabs[role=tablist] button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
  if (b.dataset.tab === 'orders') loadOrders();
}));
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/auth/login', { method: 'POST', body: { accessKey: (($('#key').value.match(/fk_[A-Za-z0-9_-]{20,60}/) || [])[0]) || $('#key').value.trim() } }); $('#key').value = ''; boot(); }
  catch (err) { msg('#login-msg', err.message, 'err'); }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); location.reload(); });
boot().catch((e) => { document.querySelector('main .wrap').prepend(el('p', { class: 'notice err' }, e.message)); });
