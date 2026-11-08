// Shared helpers for all pages. No external scripts.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; e.code = data?.code; throw e; }
  return data;
}
export const STATUS_LABEL = { open: 'Awaiting payment method', awaiting_deposit: 'Awaiting deposit', processing: 'Deposit received — settling', incomplete_deposit: 'Deposit below required amount', paid: 'Paid', refunded: 'Refunded', failed: 'Failed', expired: 'Expired', quote_expired: 'Quote expired', needs_review: 'Needs review' };
export const statusTone = (s) => (s === 'paid' ? 'ok' : ['failed', 'expired', 'needs_review', 'refunded', 'incomplete_deposit'].includes(s) ? 'bad' : 'warn');
export function copyButton(text) {
  const b = el('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Copy to clipboard' }, 'Copy');
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { b.textContent = 'Select & copy'; } });
  return b;
}
export function initNav() {
  const btn = $('.menu-btn'); const nav = $('nav.links');
  btn?.addEventListener('click', () => { const open = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', String(open)); });
  for (const a of $$('nav.links a')) if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page');
}
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
initNav();
// Replace a node's children, skipping null/undefined/false so optional fields never render as literal "null".
export function fill(n, ...kids) { n.replaceChildren(...kids.flat().filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : String(k)))); return n; }
