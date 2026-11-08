// NEAR AI may only select ids from this list. Ferry writes every sentence that can be shown.
// Free text is never validated, including text that merely cites an evidence id.

const STEP_NOTE = {
  id: 'step:save-note',
  text: 'You can save a resolution note. The note does not change the price, the payout, or the payment.',
};

function claim(id, text, evidenceIds) {
  return { id, text, evidenceIds: evidenceIds.filter(Boolean) };
}

export function buildAllowlist(facts = {}) {
  const dest = facts.destination || {};
  const quotes = Array.isArray(facts.quotes) ? facts.quotes : [];
  const orderId = facts.orderId ? `order:${facts.orderId}` : null;
  const claims = [];
  const mandatory = [];
  const requireClaim = (c) => { claims.push(c); mandatory.push(c.id); };
  if (dest.displayAmount != null && dest.symbol) {
    const base = dest.baseUnits != null && dest.decimals != null
      ? ` The same amount is ${dest.baseUnits} base units at ${dest.decimals} decimals.`
      : '';
    requireClaim(claim('claim:display-amount', `The order amount is ${dest.displayAmount} ${dest.symbol}${dest.chain ? ` on ${dest.chain}` : ''}.${base}`, [orderId]));
  }
  if (quotes.length === 0) {
    requireClaim(claim('claim:no-quote', 'No quote is stored. There is no deposit and no quote deadline.', [orderId]));
    requireClaim(claim('claim:provider-not-called', 'The provider was not called, because there is no quote to check. This is not a failed status read.', [orderId]));
  }
  if (facts.refresh?.failed === true) {
    requireClaim(claim('claim:refresh-failed', 'The last status read failed, so the stored status was not refreshed.', quotes.map((q) => q.evidenceId)));
  }
  if (facts.extraPayment === true) {
    requireClaim(claim('claim:extra-payment', 'More than one swap settled for this order. That is not a provider refund.', quotes.map((q) => q.evidenceId)));
  }
  if (quotes.some((q) => q.remoteStatus === 'SUCCESS' && q.verified === false)) {
    requireClaim(claim('claim:not-paid', 'A provider SUCCESS did not match the stored order. That quote is not paid.', quotes.filter((q) => q.remoteStatus === 'SUCCESS' && q.verified === false).map((q) => q.evidenceId)));
  }
  const passed = quotes.filter((q) => q.deadline && q.deadlinePassed === true);
  if (passed.length) {
    requireClaim(claim('claim:deadline-passed', `A stored quote deadline has passed (${passed.map((q) => q.deadline).join(', ')}). Funds sent after a quote deadline may be lost. Ferry does not promise a refund.`, passed.map((q) => q.evidenceId)));
  }
  if (facts.storedStatus) claims.push(claim('claim:stored-status', `The stored order status is ${facts.storedStatus}.`, [orderId]));
  for (const q of quotes) {
    const who = `${q.originSymbol || 'asset'} on ${q.originChain || 'its chain'}`;
    if (q.remoteStatus) claims.push(claim(`claim:status:${q.evidenceId}`, `Quote ${q.evidenceId} is ${q.remoteStatus} for ${who}.`, [q.evidenceId]));
    if (q.amountInDisplay && q.minAmountInDisplay) claims.push(claim(`claim:amounts:${q.evidenceId}`, `Suggested input is ${q.amountInDisplay} ${q.originSymbol || ''}. The minimum is ${q.minAmountInDisplay} ${q.originSymbol || ''}.`.replace(/ +/g, ' ').trim(), [q.evidenceId]));
    if (q.depositComparison?.relation === 'below_minimum') claims.push(claim(`claim:below-minimum:${q.evidenceId}`, `The reported deposit is below the minimum of ${q.minAmountInDisplay} ${q.originSymbol || ''}.`.replace(/ +/g, ' ').trim(), [q.evidenceId]));
    if (q.depositComparison?.relation === 'within_buffer') claims.push(claim(`claim:within-buffer:${q.evidenceId}`, 'The reported deposit is at least the minimum and below the suggested input. That is not a shortfall.', [q.evidenceId]));
    if (q.depositComparison?.relation === 'UNKNOWN' && ['INCOMPLETE_DEPOSIT', 'SUCCESS', 'REFUNDED', 'PROCESSING', 'KNOWN_DEPOSIT_TX'].includes(q.remoteStatus)) {
      claims.push(claim(`claim:amount-unknown:${q.evidenceId}`, 'The provider did not report the deposited amount. It is unknown, not zero.', [q.evidenceId]));
    }
    if (q.deadline && q.deadlinePassed !== true) claims.push(claim(`claim:deadline-open:${q.evidenceId}`, `The quote deadline is ${q.deadline}. It has not passed.`, [q.evidenceId]));
  }
  const steps = [STEP_NOTE];
  if (quotes.length === 0) steps.unshift({ id: 'step:nothing-in-flight', text: 'No payment is in flight. This screen does not ask you to create a quote, send funds, or issue a refund.' });
  if (facts.refresh?.failed === true) steps.unshift({ id: 'step:read-again-later', text: 'Read the provider status again later. The last read failed, so the stored status was not refreshed.' });
  if (passed.length) steps.unshift({ id: 'step:do-not-send', text: 'Do not send more funds toward that quote. Ferry will not move the money.' });
  else if (quotes.length && facts.refresh?.failed !== true) steps.unshift({ id: 'step:wait', text: 'Wait for the deposit or the quote deadline. Do not mark the order paid from this screen.' });
  if (facts.extraPayment === true) steps.unshift({ id: 'step:review-extra', text: 'Any refund of the extra settlement is a payment you send yourself. Ferry will not send it.' });
  return { claims, steps, mandatoryClaimIds: mandatory };
}

const SELECTION_KEYS = new Set(['claimIds', 'stepId']);

export function validateSelection(raw, allowlist) {
  const errors = [];
  if (!allowlist || !Array.isArray(allowlist.claims) || !Array.isArray(allowlist.steps)) return { ok: false, errors: ['no allowlist'], value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['selection is not an object'], value: null };
  for (const k of Object.keys(raw)) if (!SELECTION_KEYS.has(k)) errors.push(`unexpected field "${k}"`);
  const known = new Set(allowlist.claims.map((c) => c.id));
  if (!Array.isArray(raw.claimIds) || raw.claimIds.length < 1 || raw.claimIds.length > 12 || raw.claimIds.some((id) => typeof id !== 'string')) errors.push('claimIds must list 1 to 12 allowlist ids');
  else {
    raw.claimIds.forEach((id, i) => { if (!known.has(id)) errors.push(`claimIds[${i}] is not on the allowlist`); });
    for (const id of allowlist.mandatoryClaimIds || []) if (!raw.claimIds.includes(id)) errors.push(`required claim ${id} was not selected`);
  }
  const step = allowlist.steps.find((s) => s.id === raw.stepId);
  if (!step) errors.push('stepId is not on the allowlist');
  if (errors.length) return { ok: false, errors, value: null };
  const chosen = allowlist.claims.filter((c) => raw.claimIds.includes(c.id));
  const summary = chosen.map((c) => c.text).join(' ');
  return {
    ok: true, errors: [], value: {
      narrativeVersion: 2, composedBy: 'ferry', selectedBy: 'near-ai',
      claimIds: chosen.map((c) => c.id), stepId: step.id,
      statements: chosen.map((c) => ({ id: c.id, text: c.text, fromAllowlist: true, evidenceIds: c.evidenceIds })),
      summary, suggestedReviewStep: step.text, stepFromAllowlist: true,
      evidenceCited: [...new Set(chosen.flatMap((c) => c.evidenceIds))],
    },
  };
}

export function isServerNarrative(narrative) {
  if (!narrative || narrative.narrativeVersion !== 2 || narrative.composedBy !== 'ferry' || narrative.selectedBy !== 'near-ai') return false;
  if (narrative.stepFromAllowlist !== true || typeof narrative.suggestedReviewStep !== 'string' || !narrative.suggestedReviewStep) return false;
  if (!Array.isArray(narrative.statements) || narrative.statements.length === 0) return false;
  if (!narrative.statements.every((s) => s && s.fromAllowlist === true && typeof s.id === 'string' && typeof s.text === 'string' && s.text.length > 0)) return false;
  return narrative.summary === narrative.statements.map((s) => s.text).join(' ');
}

// Shown only when Ferry rendered the sentences from an allowlist. A claimsChecked flag is not enough.
export function presentStoredNarrative(detail = {}) {
  const narrative = detail.narrative && typeof detail.narrative === 'object' ? detail.narrative : null;
  if (detail.status === 'stored' && isServerNarrative(narrative)) return { status: 'stored', narrative, errors: [] };
  if (detail.status === 'stored' && narrative) {
    const marked = narrative.claimsChecked === true && narrative.narrativeVersion !== 2;
    return {
      status: 'withheld',
      narrative: null,
      errors: [marked
        ? 'This explanation is kept on record and is not shown. A previous check mark does not validate free text.'
        : 'This explanation is kept on record and is not shown. Only Ferry sentences selected from the evidence list are shown.'],
    };
  }
  return { status: detail.status || 'invalid', narrative: null, errors: Array.isArray(detail.errors) ? detail.errors : [] };
}
