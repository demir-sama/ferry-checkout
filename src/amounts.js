// Exact decimal <-> base-unit conversion using BigInt. Never uses floats for money.
const DEC_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export function parseUnits(input, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid decimals');
  const s = String(input ?? '').trim();
  if (!DEC_RE.test(s)) throw new Error('amount must be a plain decimal like 12.50');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`amount has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function formatUnits(base, decimals) {
  const v = BigInt(base);
  if (v < 0n) throw new Error('negative amount');
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  let frac = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function isBaseUnitString(s) {
  return typeof s === 'string' && /^(0|[1-9]\d*)$/.test(s);
}
