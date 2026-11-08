import { $, el, api, fill } from './common.js';
const id = location.pathname.split('/').pop();
const box = $('#pr');
try {
  const p = await api(`/api/public/products/${id}`);
  const prof = p.merchant.profile || {};
  fill(box, 
    el('div', { class: 'muted small' }, p.merchant.name),
    el('h2', { style: 'margin-top:4px' }, p.name),
    p.description ? el('p', { class: 'muted' }, p.description) : null,
    el('div', { class: 'amount' }, `${p.price} ${p.symbol}`),
    el('p', { class: 'hint' }, 'This destination amount is what an exact-output quote asks NEAR Intents to deliver if an eligible swap completes. It is not a fiat guarantee.'),
    prof.tagline ? el('p', { class: 'small muted' }, prof.tagline) : null,
    el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'btn accent', id: 'buy', type: 'button' }, prof.buttonLabel || 'Pay with crypto')),
    el('p', { class: 'hint', id: 'buy-msg', role: 'alert' }),
  );
  $('#buy').addEventListener('click', async (e) => {
    e.target.disabled = true; $('#buy-msg').textContent = 'Creating your order…';
    try { const o = await api(`/api/public/products/${id}/orders`, { method: 'POST' }); location.assign(o.checkoutPath); }
    catch (err) { $('#buy-msg').textContent = err.message; e.target.disabled = false; }
  });
} catch (e) { fill(box, el('h2', {}, 'Product unavailable'), el('p', { class: 'muted' }, e.message)); }
