// Claims in a NEAR AI explanation are licensed only by the fact sheet Ferry built.
// A cited evidence id does not make an amount, a refresh outcome, or a deadline true.
import { formatUnits } from './amounts.js';

const NEGATION = /(?:\bnot\b|\bno\b|\bnever\b|\bwithout\b|\bisn'?t\b|\baren'?t\b|\bwasn'?t\b)/i;

function foldNumbers(text) {
  let s = String(text).replace(/(\d)[,\u00a0\u202f](?=\d)/g, '$1');
  let prev;
  do { prev = s; s = s.replace(/(\d) (?=\d{3}(?!\d))/g, '$1'); } while (s !== prev);
  return s;
}

function showUnits(base, decimals) {
  const dec = Number(decimals);
  if (base == null || !Number.isInteger(dec)) return null;
  try { return formatUnits(base, dec); } catch { return null; }
}

function amountPairs(facts) {
  const pairs = [];
  const add = (base, display) => {
    if (base == null || display == null) return;
    const b = String(base);
    const d = String(display);
    if (!/^(0|[1-9]\d*)$/.test(b) || b === d) return;
    if (!pairs.some((p) => p.base === b)) pairs.push({ base: b, display: d });
  };
  const dest = facts?.destination || {};
  add(dest.baseUnits ?? dest.amountBase, dest.displayAmount ?? showUnits(dest.baseUnits ?? dest.amountBase, dest.decimals));
  for (const q of facts?.quotes || []) {
    const dec = q.originDecimals;
    add(q.amountInBase, q.amountInDisplay ?? showUnits(q.amountInBase, dec));
    add(q.minAmountInBase, q.minAmountInDisplay ?? showUnits(q.minAmountInBase, dec));
    add(q.depositedAmountBase, q.depositedAmountDisplay ?? showUnits(q.depositedAmountBase, dec));
    const outDec = q.destinationDecimals ?? dest.decimals;
    add(q.amountOutBase, q.amountOutDisplay ?? showUnits(q.amountOutBase, outDec));
    add(q.refundedAmountBase, q.refundedAmountDisplay ?? showUnits(q.refundedAmountBase, dec));
  }
  return pairs;
}

// A mention is unsupported when the claim is not immediately negated.
function unnegated(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (!NEGATION.test(before)) hits.push(m[0]);
  }
  return hits;
}

function misstatedBaseUnits(text, pairs) {
  const folded = foldNumbers(text);
  const problems = [];
  for (const { base } of pairs) {
    let from = 0;
    while (from < folded.length) {
      const idx = folded.indexOf(base, from);
      if (idx < 0) break;
      const window = folded.slice(Math.max(0, idx - 18), idx + base.length + 18).toLowerCase();
      if (!window.includes('base unit')) problems.push('base units were written as the display amount');
      from = idx + base.length;
    }
  }
  return problems;
}

// Closed set of claim types that cited ids cannot license by themselves.
export function unsupportedClaims(texts, facts) {
  if (!facts) return [];
  const text = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string').join('\n');
  if (!text.trim()) return [];
  const problems = [];
  for (const problem of misstatedBaseUnits(text, amountPairs(facts))) problems.push(problem);
  const refreshFailed = facts.refresh?.failed === true;
  if (!refreshFailed) {
    for (const hit of unnegated(text, /refresh(?: attempt(?:ed)?)?(?: but)? failed|failed to refresh|refresh failed|not rechecked|failed to produce quotes|status (?:was|is|has) not rechecked|could not refresh|unable to refresh/i)) {
      problems.push('the facts do not include a failed refresh');
    }
  }
  const quotes = Array.isArray(facts.quotes) ? facts.quotes : [];
  const hasDeadline = quotes.some((q) => q.deadline);
  const deadlinePassed = quotes.some((q) => q.deadlinePassed === true);
  if (!hasDeadline) {
    for (const hit of unnegated(text, /funds may be lost|funds will be lost|funds (?:are|were) lost|late deposit|quote deadline/i)) {
      problems.push('the facts do not include a quote deadline');
    }
  } else if (!deadlinePassed) {
    for (const hit of unnegated(text, /funds may be lost|funds will be lost|funds (?:are|were) lost|late deposit/i)) {
      problems.push('no stored quote deadline has passed');
    }
  }
  return [...new Set(problems)];
}

// Read-time projection. Rows without claimsChecked stay in the database and are not shown as validated.
export function presentStoredNarrative(detail = {}) {
  const narrative = detail.narrative && typeof detail.narrative === 'object' ? detail.narrative : null;
  if (detail.status === 'stored' && narrative?.claimsChecked === true) return { status: 'stored', narrative, errors: [] };
  if (detail.status === 'stored' && narrative) {
    return {
      status: 'withheld',
      narrative: null,
      errors: ['This explanation is kept on record and is not shown. It was stored before its claims were checked against the evidence.'],
    };
  }
  return { status: detail.status || 'invalid', narrative: null, errors: Array.isArray(detail.errors) ? detail.errors : [] };
}
