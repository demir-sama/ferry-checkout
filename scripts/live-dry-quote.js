// Live check against the public 1Click API using dry:true (no deposit address is created, no funds move).
// Sends the same EXACT_OUTPUT request shape Ferry uses at checkout. Example addresses are placeholders.
import { createOneClick } from '../src/oneclick.js';
import { formatUnits, parseUnits } from '../src/amounts.js';
const oc = createOneClick({ baseUrl: process.env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com', jwt: process.env.ONECLICK_JWT || '' });
const tokens = await oc.tokens();
const find = (chain, sym) => tokens.find((t) => t.blockchain === chain && t.symbol === sym);
const dest = find('near', 'USDC'), origin = find(process.argv[2] || 'base', process.argv[3] || 'USDC');
if (!dest || !origin) { console.error('asset not in live list'); process.exit(1); }
const amount = parseUnits(process.argv[4] || '2', dest.decimals).toString();
const r = await oc.quote({ dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN', destinationAsset: dest.assetId,
  amount, refundTo: process.env.REFUND_TO || '0x0000000000000000000000000000000000000001', refundType: 'ORIGIN_CHAIN', recipient: process.env.RECIPIENT || 'example.near',
  recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 30 * 60e3).toISOString(), depositMode: 'SIMPLE', referral: 'ferry-checkout' });
console.log(JSON.stringify({ live: true, dry: true, tokensListed: tokens.length, pay: `${r.quote.amountInFormatted} ${origin.symbol} on ${origin.blockchain}`, minIn: formatUnits(r.quote.minAmountIn, origin.decimals),
  merchantReceives: `${formatUnits(r.quote.amountOut, dest.decimals)} ${dest.symbol} on near`, exact: r.quote.amountOut === amount, timeEstimateSec: r.quote.timeEstimate, correlationId: r.correlationId, depositAddressReturned: Boolean(r.quote.depositAddress) }, null, 2));
