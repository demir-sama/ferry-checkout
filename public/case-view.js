// Shared rendering for simulated cases. Live order investigation stays in dashboard.js.
import { el } from './common.js';

export function freshnessCopy(state) {
  const map = {
    fresh: 'Status was read from the provider inside the freshness window.',
    terminal: 'Terminal provider status is stored. This is not a new confirmation.',
    stale: 'The stored provider status is older than the freshness window.',
    refresh_failed: 'The last status refresh failed. What you see is the last stored status, not a fresh confirmation.',
    never_checked: 'This quote has not had a successful status read yet.',
    no_quote: 'No quote has been requested, so there is no provider status.',
  };
  return map[state] || 'Freshness is unknown.';
}

export function renderSimCard(c) {
  const findings = Array.isArray(c?.diagnosis?.findings) ? c.diagnosis.findings : [];
  return el('article', { class: 'card sim-card' },
    el('p', { class: 'badge-sample' }, 'SIMULATED'),
    el('h3', {}, c?.title || 'Simulated case'),
    c?.teaches ? el('p', { class: 'small' }, c.teaches) : null,
    el('p', {}, el('span', { class: `pill ${c?.diagnosis?.lane === 'paid' ? 'ok' : c?.diagnosis?.lane === 'attention' ? 'bad' : 'warn'}` }, c?.diagnosis?.lane || 'unknown')),
    ...findings.filter((f) => f && f.severity === 'attention').slice(0, 3).map((f) => el('p', { class: 'small' }, `Rule: ${f.title}. ${f.detail || ''}`)),
    el('p', { class: 'hint' }, 'Not a live settlement. Not included in merchant totals.'));
}
