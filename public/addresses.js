// Address validation for payout recipients and buyer refund addresses.
// Payouts are restricted to chain families we can validate deterministically.
const EVM = new Set(['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'scroll', 'monad', 'xlayer', 'plasma', 'adi', 'aurora', 'abs', 'hlevm', 'hood']);
const NEAR_NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;
const NEAR_ETH_IMPLICIT = /^0x[0-9a-f]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const PAYOUT_CHAINS = ['near', 'sol', ...EVM];

export function chainFamily(chain) {
  if (chain === 'near') return 'near';
  if (chain === 'sol') return 'sol';
  if (EVM.has(chain)) return 'evm';
  return 'other';
}

export function validateAddress(chain, raw) {
  const a = String(raw ?? '').trim();
  if (!a || a.length > 128 || /\s/.test(a)) return { ok: false, reason: 'Address is empty or malformed.' };
  switch (chainFamily(chain)) {
    case 'near':
      if (NEAR_IMPLICIT.test(a) || NEAR_ETH_IMPLICIT.test(a)) return { ok: true, address: a };
      if (NEAR_NAMED.test(a)) return { ok: true, address: a };
      return { ok: false, reason: 'Expected a NEAR account like shop.near or a 64-character implicit account.' };
    case 'evm':
      return /^0x[0-9a-fA-F]{40}$/.test(a) ? { ok: true, address: a } : { ok: false, reason: 'Expected a 0x-prefixed 40-hex-character address.' };
    case 'sol':
      return B58.test(a) && a.length >= 32 && a.length <= 44 ? { ok: true, address: a } : { ok: false, reason: 'Expected a base58 Solana address.' };
    default:
      // Refund addresses on other chains: structural check only; 1Click validates the format when quoting.
      return /^[A-Za-z0-9:._\-]+$/.test(a) ? { ok: true, address: a, structuralOnly: true } : { ok: false, reason: 'Address contains unexpected characters.' };
  }
}

export function canBePayoutChain(chain) {
  return chainFamily(chain) !== 'other';
}
