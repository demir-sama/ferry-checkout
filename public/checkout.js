import { $, el, api, STATUS_LABEL, statusTone, copyButton, fmtTime } from './common.js';
const secret = location.pathname.split('/').pop();
let order = null, assets = [], timer = null, countdown = null;
const FINAL = new Set(['paid', 'expired']);

function render(o) {
  order = o;
  $('#co-loading').classList.add('hidden'); $('#co').classList.remove('hidden');
  $('#co-sample').replaceChildren(o.merchant.isSample ? el('p', { class: 'badge-sample' }, 'This checkout belongs to a sample store used for local development. Anything you send is still a real mainnet payment.') : '');
  $('#co-merchant').textContent = o.merchant.name;
  $('#co-item').textContent = o.item.name;
  $('#co-desc').textContent = o.item.description || '';
  $('#co-amount').textContent = `${o.amount.formatted} ${o.amount.symbol}`;
  $('#co-dest').replaceChildren('on ', el('b', {}, o.amount.chain), ' to ', el('span', { class: 'mono' }, o.recipient));
  $('#co-status').textContent = STATUS_LABEL[o.status] || o.status;
  $('#co-dot').className = `dot ${statusTone(o.status)}`;
  $('#co-note').textContent = o.statusNote || (o.status === 'paid' ? `Settled ${fmtTime(o.updatedAt)}.` : `Order expires ${fmtTime(o.expiresAt)}.`);
  const blocked = ['paid', 'processing', 'incomplete_deposit', 'needs_review', 'expired'].includes(o.status);
  $('#co-form').classList.toggle('hidden', blocked);
  const latest = o.quotes[o.quotes.length - 1];
  renderPay(o, latest);
  renderHistory(o);
  document.title = `${o.status === 'paid' ? 'Paid' : 'Checkout'} · ${o.item.name} — Ferry`;
}

function renderPay(o, q) {
  const box = $('#co-pay');
  clearInterval(countdown);
  if (!q) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const d = q.detail || {};
  const kids = [];
  if (o.status === 'paid') {
    kids.push(el('h3', {}, 'Payment complete'), el('p', { class: 'muted' }, `The merchant received ${o.amount.formatted} ${o.amount.symbol}.`));
  } else if (q.remoteStatus === 'PENDING_DEPOSIT' && Date.parse(q.deadline) > Date.now()) {
    const cd = el('b', { id: 'cd' });
    kids.push(el('h3', {}, 'Send your payment'),
      el('ol', { class: 'steps' },
        el('li', {}, 'Send exactly ', el('b', { class: 'mono' }, `${q.amountInFormatted} ${q.originSymbol}`), ` on ${q.originChain}. This includes a small slippage buffer; the minimum accepted is ${q.minAmountInFormatted}. Any extra is refunded after the swap.`),
        el('li', {}, 'to this one-time deposit address:', el('div', { class: 'copy', style: 'margin-top:8px' }, el('div', { class: 'mono' }, q.depositAddress), copyButton(q.depositAddress))),
        q.depositMemo ? el('li', {}, el('b', {}, 'Include this memo, or the deposit will fail:'), el('div', { class: 'copy', style: 'margin-top:8px' }, el('div', { class: 'mono' }, q.depositMemo), copyButton(q.depositMemo))) : null,
        el('li', {}, 'before the deadline: ', cd, '. After it passes, don\'t send. Request new instructions instead.')),
      el('p', { class: 'small muted' }, `Refunds go to ${q.refundTo}${q.refundFeeFormatted ? ` (refund fee about ${q.refundFeeFormatted} ${q.originSymbol})` : ''}. Estimated settlement time after confirmation: ${q.timeEstimateSec ?? '?'}s. Allow up to 15 minutes for cross-chain processing.`));
    const tick = () => { const ms = Date.parse(q.deadline) - Date.now(); if (ms <= 0) { cd.textContent = 'expired'; clearInterval(countdown); refresh(); return; } const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); cd.textContent = `${m}:${String(s).padStart(2, '0')} remaining`; };
    countdown = setInterval(tick, 1000); setTimeout(tick, 0);
  } else {
    kids.push(el('h3', {}, `Latest quote: ${q.remoteStatus.replaceAll('_', ' ').toLowerCase()}`));
    if (d.depositedAmountFormatted) kids.push(el('p', {}, `Deposited: ${d.depositedAmountFormatted} ${q.originSymbol}`));
    if (d.refundedAmountFormatted) kids.push(el('p', {}, `Refunded: ${d.refundedAmountFormatted} ${q.originSymbol} to ${q.refundTo}${d.refundReason ? ` (${d.refundReason})` : ''}`));
    if (q.remoteStatus === 'INCOMPLETE_DEPOSIT') kids.push(el('p', { class: 'notice warn' }, `Less than the minimum (${q.minAmountInFormatted} ${q.originSymbol}) arrived. Send the difference to the same address before the deadline, or the deposit will be refunded.`));
    if (q.remoteStatus === 'PENDING_DEPOSIT') kids.push(el('p', { class: 'muted' }, 'This quote has expired. Choose a token above to get new deposit instructions.'));
  }
  const txs = [...(d.originChainTxs || []), ...(d.destinationChainTxs || [])];
  if (txs.length) kids.push(el('p', { class: 'small' }, 'Transactions: ', ...txs.map((t, i) => [i ? ' · ' : '', /^https:\/\//.test(t.explorerUrl) ? el('a', { href: t.explorerUrl, rel: 'noopener noreferrer', target: '_blank' }, `${t.hash.slice(0, 10)}…`) : t.hash.slice(0, 10)])));
  kids.push(el('p', { class: 'small muted' }, 'Track on the ', el('a', { href: 'https://explorer.near-intents.org', rel: 'noopener noreferrer', target: '_blank' }, 'NEAR Intents explorer'), ` using deposit address ${q.depositAddress.slice(0, 12)}…`));
  box.replaceChildren(...kids);
}

function renderHistory(o) {
  const box = $('#co-history');
  if (o.quotes.length < 2) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.replaceChildren(el('h3', {}, 'Earlier quotes for this order'), el('p', { class: 'small muted' }, 'Only send to the latest instructions. An earlier address still works until its own deadline, so sending to two addresses would mean paying twice.'),
    el('ul', { class: 'small' }, o.quotes.slice(0, -1).map((q) => el('li', {}, `${q.amountInFormatted} ${q.originSymbol} (${q.originChain}) · ${q.remoteStatus} · deadline ${fmtTime(q.deadline)}`))));
}

async function refresh() {
  try { render(await api(`/api/checkout/${secret}/status`)); } catch (e) { $('#co-msg').textContent = e.message; }
  schedule();
}
function schedule() { clearTimeout(timer); if (order && !FINAL.has(order.status)) timer = setTimeout(refresh, order.quotes.length ? 6000 : 30000); }

function fillAssets() {
  const sel = $('#co-asset');
  const allowed = order.acceptedAssets.length ? assets.filter((a) => order.acceptedAssets.includes(a.assetId)) : assets;
  const byChain = {};
  for (const a of allowed) (byChain[a.blockchain] ||= []).push(a);
  sel.replaceChildren(el('option', { value: '' }, 'Choose a token…'), ...Object.keys(byChain).sort().map((c) => el('optgroup', { label: c }, byChain[c].sort((x, y) => x.symbol.localeCompare(y.symbol)).map((a) => el('option', { value: a.assetId }, `${a.symbol} · ${a.blockchain}`)))));
}
$('#co-asset').addEventListener('change', () => { const a = assets.find((x) => x.assetId === $('#co-asset').value); $('#co-refund').placeholder = a ? `Your ${a.blockchain} address` : ''; });
$('#co-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#co-quote-btn'); btn.disabled = true; $('#co-msg').textContent = 'Requesting an exact-output quote from NEAR Intents…';
  try { render(await api(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: $('#co-asset').value, refundTo: $('#co-refund').value.trim() } })); $('#co-msg').textContent = ''; $('#co-pay').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch (err) { $('#co-msg').textContent = err.message; }
  btn.disabled = false; schedule();
});

try {
  const [o, a] = await Promise.all([api(`/api/checkout/${secret}`), api('/api/assets')]);
  assets = a.assets; render(o); fillAssets(); refresh();
} catch (e) { $('#co-loading').replaceChildren(el('h2', {}, 'Checkout not found'), el('p', { class: 'muted' }, e.message)); }
