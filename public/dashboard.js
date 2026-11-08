import { $, $$, el, api, STATUS_LABEL, statusTone, copyButton, fmtTime, fill } from './common.js';
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
    el('td', {}, el('b', {}, p.name), el('div', { class: 'small muted mono' }, p.id)), el('td', { class: 'mono' }, `${p.price} ${p.symbol}`),
    el('td', {}, p.active ? el('div', { class: 'row' }, el('a', { href: `/p/${p.id}`, target: '_blank', rel: 'noopener' }, 'Open'), copyButton(`${location.origin}/p/${p.id}`)) : el('span', { class: 'muted' }, 'inactive')),
    el('td', {}, el('button', { class: 'btn secondary small', type: 'button', onclick: async () => { await api(`/api/merchant/products/${p.id}/${p.active ? 'deactivate' : 'activate'}`, { method: 'POST', body: {} }); loadProducts(); } }, p.active ? 'Deactivate' : 'Activate')))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No products yet.'))]));
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

async function loadOrders() {
  const { orders } = await api('/api/merchant/orders');
  fill($('#order-rows'), ...(orders.length ? orders.map((o) => el('tr', {},
    el('td', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); showOrder(o.id); } }, o.id)), el('td', {}, o.item), el('td', { class: 'mono' }, `${o.amount} ${o.symbol}`),
    el('td', {}, el('span', { class: `pill ${statusTone(o.status)}` }, STATUS_LABEL[o.status] || o.status), o.extraPayment ? el('span', { class: 'pill bad', style: 'margin-left:6px' }, 'Extra payment') : null), el('td', { class: 'small' }, fmtTime(o.createdAt)))) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No orders yet.'))]));
}
$('#reload-orders').addEventListener('click', loadOrders);
async function showOrder(id, refresh = false) {
  const o = await api(`/api/merchant/orders/${id}${refresh ? '?refresh=1' : ''}`);
  const box = $('#order-detail'); box.classList.remove('hidden');
  fill(box, el('div', { class: 'row', style: 'justify-content:space-between' }, el('h3', {}, `${o.item.name} · ${o.amount.formatted} ${o.amount.symbol}`), el('button', { class: 'btn secondary small', type: 'button', onclick: () => showOrder(id, true) }, 'Check status now')),
    el('p', {}, el('span', { class: `pill ${statusTone(o.status)}` }, STATUS_LABEL[o.status] || o.status), ' ', o.statusNote || ''),
    o.extraPayment ? el('p', { class: 'notice err' }, 'More than one deposit settled for this order. Refund the extra amount to the buyer from your payout wallet.') : null,
    el('p', { class: 'small muted' }, `Payout: ${o.amount.symbol} on ${o.amount.chain} → `, el('span', { class: 'mono' }, o.recipient)),
    el('h3', { style: 'margin-top:16px' }, 'Quotes'),
    o.quotes.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Pay with', 'Amount in', 'Deposit address', 'Remote status', 'Verified'].map((h) => el('th', {}, h)))),
      el('tbody', {}, o.quotes.map((q) => el('tr', {}, el('td', {}, `${q.originSymbol} · ${q.originChain}`), el('td', { class: 'mono' }, q.amountInFormatted), el('td', { class: 'mono small' }, q.depositAddress), el('td', {}, q.remoteStatus), el('td', {}, q.verified == null ? '—' : q.verified ? 'match' : 'MISMATCH')))))) : el('p', { class: 'muted small' }, 'No quotes requested yet.'),
    el('h3', { style: 'margin-top:16px' }, 'Timeline'),
    el('ul', { class: 'small' }, o.events.map((ev) => el('li', {}, `${fmtTime(ev.at)} · ${ev.kind}${ev.detail.to ? ` → ${ev.detail.to}` : ''}`))));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAiStatus() {
  fill($('#ai-status'), nearAi.configured ? el('p', { class: 'notice ok' }, `NEAR AI Cloud is configured (model ${nearAi.model}).`)
    : el('p', { class: 'notice warn' }, 'NEAR AI Cloud isn\'t configured on this server (NEAR_AI_API_KEY is unset). Drafting is unavailable. Ferry won\'t invent a draft or switch to another AI provider. Everything else works without it.'));
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

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
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
