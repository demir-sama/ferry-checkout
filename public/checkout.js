import { $, el, api, STATUS_LABEL, statusTone, copyButton, fmtTime, fill } from './common.js';
import { validateAddress } from './addresses.js';
const secret = location.pathname.split('/').pop();
let order = null, assets = [], timer = null, countdown = null;
const FINAL = new Set(['paid', 'expired']);

function render(o) {
  order = o;
  $('#co-loading').classList.add('hidden'); $('#co').classList.remove('hidden');
  fill($('#co-sample'), o.merchant.isSample ? el('p', { class: 'badge-sample' }, 'This checkout belongs to a sample store used for local development. Anything you send is still a real mainnet payment.') : '');
  $('#co-merchant').textContent = o.merchant.name;
  $('#co-item').textContent = o.item.name;
  $('#co-desc').textContent = o.item.description || '';
  $('#co-amount').textContent = `${o.amount.formatted} ${o.amount.symbol}`;
  fill($('#co-dest'), 'on ', el('b', {}, o.amount.chain), ' to ', el('span', { class: 'mono' }, o.recipient));
  $('#co-status').textContent = STATUS_LABEL[o.status] || o.status;
  $('#co-dot').className = `dot ${statusTone(o.status)}`;
  $('#co-note').textContent = o.statusNote || (o.status === 'paid' ? `Settled ${fmtTime(o.updatedAt)}.` : `Order expires ${fmtTime(o.expiresAt)}.`);
  const blocked = ['paid', 'processing', 'incomplete_deposit', 'needs_review', 'expired'].includes(o.status);
  $('#co-form').classList.toggle('hidden', blocked);
  const latest = o.quotes[o.quotes.length - 1];
  const live = Boolean(latest?.live);
  $('#co-replace').classList.toggle('hidden', !live);
  if (!live) $('#co-replace-ok').checked = false;
  $('#co-form-title').textContent = live ? 'Pay with a different token' : 'Pay with';
  $('#co-quote-btn').textContent = live ? 'Replace deposit instructions' : 'Get deposit instructions';
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
    kids.push(el('h3', {}, 'Marked paid'), el('p', { class: 'muted' }, `Ferry marked this order paid because 1Click reported SUCCESS and the stored quote matched ${o.amount.formatted} ${o.amount.symbol}. That is a provider settlement report, not a fiat guarantee.`));
  } else if (q.remoteStatus === 'PENDING_DEPOSIT' && Date.parse(q.deadline) > Date.now()) {
    const cd = el('b', { id: 'cd' });
    kids.push(el('h3', {}, 'Send your payment'),
      el('ol', { class: 'steps' },
        el('li', {}, 'Suggested deposit ', el('b', { class: 'mono' }, `${q.amountInFormatted} ${q.originSymbol}`), ` on ${q.originChain}. amountIn includes a slippage buffer. The minimum that can still complete is `, el('b', { class: 'mono' }, `${q.minAmountInFormatted} ${q.originSymbol}`), ' (minAmountIn). The destination amount is delivered only if an eligible swap completes.'),
        el('li', {}, 'to this one-time deposit address:', el('div', { class: 'copy', style: 'margin-top:8px' }, el('div', { class: 'mono' }, q.depositAddress), copyButton(q.depositAddress)),
          el('img', { class: 'qr', src: `/api/checkout/${secret}/qr/${q.id}.svg`, width: 184, height: 184, alt: `QR code of the deposit address ${q.depositAddress}` }),
          el('p', { class: 'hint' }, 'The QR code contains only the address. Always check the amount and network in your wallet before sending.')),
        q.depositMemo ? el('li', {}, el('b', {}, 'Include this memo. The provider looks up the deposit by address and memo:'), el('div', { class: 'copy', style: 'margin-top:8px' }, el('div', { class: 'mono' }, q.depositMemo), copyButton(q.depositMemo))) : null,
        el('li', {}, 'before the deadline: ', cd, '. After it passes, don\'t send. The quote deadline is when this deposit address can become inactive, and funds may be lost. Ferry does not promise a late refund.')),
      el('p', { class: 'small muted' }, `If the provider sends a refund, it uses ${q.refundTo}${q.refundFeeFormatted ? ` (documented refund fee about ${q.refundFeeFormatted} ${q.originSymbol})` : ''}. A seen deposit is not yet settled. Estimated time after confirmation: ${q.timeEstimateSec ?? '?'} seconds.`));
    const tick = () => { const ms = Date.parse(q.deadline) - Date.now(); if (ms <= 0) { cd.textContent = 'expired'; clearInterval(countdown); refresh(); return; } const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); cd.textContent = `${m}:${String(s).padStart(2, '0')} remaining`; };
    countdown = setInterval(tick, 1000); setTimeout(tick, 0);
  } else {
    kids.push(el('h3', {}, `Latest quote: ${q.remoteStatus.replaceAll('_', ' ').toLowerCase()}`));
    const dep = q.evidence?.deposited;
    const ref = q.evidence?.refunded;
    kids.push(el('p', {}, dep?.known ? `Deposited: ${dep.formatted} ${q.originSymbol}` : 'Deposited amount: UNKNOWN. A missing amount is not zero, and it is not compared with the buffered amountIn.'));
    if (ref?.known) kids.push(el('p', {}, `Provider refunded: ${ref.formatted} ${q.originSymbol}${q.evidence?.refundReason ? ` (${q.evidence.refundReason})` : ''}`));
    else if (q.remoteStatus === 'REFUNDED') kids.push(el('p', {}, 'Provider refunded amount: UNKNOWN.'));
    if (q.remoteStatus === 'INCOMPLETE_DEPOSIT') kids.push(el('p', { class: 'notice warn' }, dep?.known ? `The provider marked this deposit incomplete. The minimum is ${q.minAmountInFormatted} ${q.originSymbol}. If the deadline has not passed, you can send the difference to the same address and memo. Ferry does not promise a refund.` : `The provider marked this deposit incomplete, and it did not report the size. The shortfall is UNKNOWN. The minimum on the quote is ${q.minAmountInFormatted} ${q.originSymbol}.`));
    if (q.remoteStatus === 'KNOWN_DEPOSIT_TX') kids.push(el('p', { class: 'notice warn' }, 'A deposit transaction has been seen. That is not settlement.'));
    if (q.remoteStatus === 'PENDING_DEPOSIT') kids.push(el('p', { class: 'notice warn' }, 'This quote\'s deadline has passed. Don\'t send. Funds sent late may be lost. Ferry does not promise a late refund. Ask for new instructions if you still want to pay.'));
  }
  const txs = [...(d.originChainTxs || []), ...(d.destinationChainTxs || [])];
  if (txs.length) kids.push(el('p', { class: 'small' }, 'Transactions: ', ...txs.map((t, i) => [i ? ' · ' : '', /^https:\/\//.test(t.explorerUrl) ? el('a', { href: t.explorerUrl, rel: 'noopener noreferrer', target: '_blank' }, `${t.hash.slice(0, 10)}…`) : t.hash.slice(0, 10)])));
  kids.push(el('p', { class: 'small muted' }, 'Track on the ', el('a', { href: 'https://explorer.near-intents.org', rel: 'noopener noreferrer', target: '_blank' }, 'NEAR Intents explorer'), ` using deposit address ${q.depositAddress.slice(0, 12)}…`));
  fill(box, ...kids);
}

function renderHistory(o) {
  const box = $('#co-history');
  if (o.quotes.length < 2) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  fill(box, el('h3', {}, 'Earlier quotes for this order'), el('p', { class: 'small muted' }, 'Only send to the latest instructions. An earlier address still works until its own deadline, so sending to two addresses would mean paying twice.'),
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
  fill(sel, el('option', { value: '' }, 'Choose a token…'), ...Object.keys(byChain).sort().map((c) => el('optgroup', { label: c }, byChain[c].sort((x, y) => x.symbol.localeCompare(y.symbol)).map((a) => el('option', { value: a.assetId }, `${a.symbol} · ${a.blockchain}`)))));
}
function checkRefund({ quiet = false } = {}) {
  const input = $('#co-refund'); const a = assets.find((x) => x.assetId === $('#co-asset').value);
  const v = input.value.trim();
  let problem = null;
  if (!a) problem = 'Choose the token you will pay with first.';
  else if (!v) problem = `Enter your ${a.blockchain} refund address.`;
  else { const r = validateAddress(a.blockchain, v); if (!r.ok) problem = `Refund address: ${r.reason}`; }
  if (problem && (v || !quiet)) { input.setAttribute('aria-invalid', 'true'); $('#co-refund-err').textContent = problem; }
  else { input.removeAttribute('aria-invalid'); $('#co-refund-err').textContent = ''; }
  return problem;
}
$('#co-asset').addEventListener('change', () => { const a = assets.find((x) => x.assetId === $('#co-asset').value); $('#co-refund').placeholder = a ? `Your ${a.blockchain} address` : ''; if ($('#co-refund').value.trim()) checkRefund(); });
$('#co-refund').addEventListener('blur', () => checkRefund({ quiet: true }));
$('#co-refund').addEventListener('input', () => { if ($('#co-refund').getAttribute('aria-invalid')) checkRefund({ quiet: true }); });
$('#co-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const problem = checkRefund();
  if (problem) { $('#co-msg').textContent = problem; $('#co-refund').focus(); return; }
  const btn = $('#co-quote-btn'); btn.disabled = true; $('#co-msg').textContent = 'Requesting an exact-output quote from NEAR Intents…';
  const replacing = !$('#co-replace').classList.contains('hidden');
  if (replacing && !$('#co-replace-ok').checked) { $('#co-msg').textContent = 'Confirm you have not sent funds to the current deposit address first.'; btn.disabled = false; return; }
  try { render(await api(`/api/checkout/${secret}/quote`, { method: 'POST', body: { originAssetId: $('#co-asset').value, refundTo: $('#co-refund').value.trim(), replace: replacing } })); $('#co-msg').textContent = ''; $('#co-pay').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch (err) { $('#co-msg').textContent = err.message; }
  btn.disabled = false; schedule();
});

try {
  const [o, a] = await Promise.all([api(`/api/checkout/${secret}`), api('/api/assets')]);
  assets = a.assets; render(o); fillAssets(); refresh();
} catch (e) { fill($('#co-loading'), el('h2', {}, 'Checkout not found'), el('p', { class: 'muted' }, e.message)); }
