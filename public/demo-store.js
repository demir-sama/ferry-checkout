import { $, el, api, fill } from './common.js';
import { renderSimCard } from './case-view.js';
async function render(ids) {
  const grid = $('#demo-grid'); fill(grid);
  for (const id of ids) {
    try {
      const p = await api(`/api/public/products/${encodeURIComponent(id)}`);
      grid.append(el('div', { class: 'card' }, el('h3', {}, p.name), el('p', { class: 'muted small' }, p.description || ''),
        el('div', { class: 'amount', style: 'font-size:24px' }, `${p.price} ${p.symbol}`),
        el('a', { class: 'btn accent', href: `/p/${p.id}`, style: 'margin-top:12px' }, p.merchant.profile?.buttonLabel || 'Pay with crypto')));
    } catch (e) { grid.append(el('div', { class: 'card' }, el('p', { class: 'muted' }, `${id}: ${e.message}`))); }
  }
}
try {
  const data = await api('/api/simulated-cases');
  $('#sim-notice').textContent = data.notice;
  fill($('#sim-cases'), ...(data.cases || []).map(renderSimCard));
} catch (e) { $('#sim-notice').textContent = e.message; }
const q = new URLSearchParams(location.search).get('products');
if (q) { $('#demo-ids').value = q; render(q.split(',').map((s) => s.trim()).filter(Boolean)); }
$('#demo-form').addEventListener('submit', (e) => { e.preventDefault(); const ids = $('#demo-ids').value.split(',').map((s) => s.trim()).filter(Boolean); history.replaceState(null, '', `?products=${ids.join(',')}`); render(ids); });
