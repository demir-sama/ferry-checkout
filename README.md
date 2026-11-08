# Ferry: exact-amount checkout across chains

<img src="public/logo.svg" width="64" alt="Ferry logo">

Ferry gives merchants a checkout link and an embeddable button. The merchant sets **one price in the asset they want to receive** and **the address it goes to**. The buyer pays with any asset in the live NEAR Intents list, from that asset's chain. **NEAR Intents 1Click** delivers the exact amount using `EXACT_OUTPUT` quotes. **NEAR AI Cloud** drafts storefront copy into a strict schema, and the merchant reviews it before anything is applied.

Ferry is built for the NEAR Hackathon (Nov 2026). It follows NEAR co-founder Illia Polosukhin's "universal checkout widget" idea.

## Status (be precise)
| Area | State |
|---|---|
| Live asset discovery (`GET /v0/tokens`) | Working against the public API (216 assets on 2026-11-08) |
| Exact-output request shape | Checked live with `dry: true` quotes (`npm run` → `node scripts/live-dry-quote.js`) |
| Real deposit address → settlement → paid | Implemented and covered by fixture tests. **No mainnet payment has been made yet** (NEAR Intents has no testnet) |
| NEAR AI setup assistant | Implemented and covered by fixture tests. **No real NEAR AI call has been made yet**: no API key/credits have been acquired. When the key is missing, the server reports "not configured" |
| Merchant webhooks | Not implemented (see Docs → Limits) |

## Run locally
```bash
node --version                 # 22.13+ (built-in node:sqlite)
npm run merchant:create -- "My Store"
npm start                      # http://127.0.0.1:4317
FERRY_DEV=1 npm start          # dev mode: creates a clearly labelled SAMPLE merchant on an empty DB
npm test                       # unit + HTTP tests (synthetic 1Click/NEAR AI fixtures)
node scripts/live-dry-quote.js base USDC 2   # live dry quote; no funds, no deposit address
```
Server-side environment (never sent to the browser): `NEAR_AI_API_KEY`, `NEAR_AI_MODEL` (default `Qwen/Qwen3.6-35B-A3B-FP8`), `ONECLICK_JWT` (optional partner key; unauthenticated quotes pay an extra platform fee), `PUBLIC_BASE_URL`, `FERRY_DB`, `PORT`, `QUOTE_TTL_MINUTES`, `SLIPPAGE_BPS`.

## How it works
1. **Order**: the server fixes the item, the amount as integer base units, the payout asset and the recipient. Buyers get a secret `/c/chk_…` URL.
2. **Quote**: `POST /v0/quote` with `swapType: EXACT_OUTPUT`, `amount` set to the order amount, `ORIGIN_CHAIN` deposit and refund, and `DESTINATION_CHAIN` recipient. Ferry rejects any response that doesn't repeat what was asked, then stores the quote together with 1Click's signature.
3. **Deposit**: the buyer sees the amount, the minimum, the one-time address, any memo, a countdown and refund details.
4. **Paid**: only when `GET /v0/status` returns `SUCCESS` and the deposit address, memo, signature, swap type, recipient, destination asset and amount all match. A SUCCESS that doesn't match goes to `needs_review`. No client callback or transaction hash can mark an order paid.

The AI can only produce copy, an accent colour from a fixed palette, and suggested asset IDs from the live list. A deterministic validator rejects any field resembling a price, payout, address, payment status or transfer. Each field needs the merchant's approval, and products need a price the merchant enters themselves.

See `/docs` in the app (`public/docs.html`) and `docs/ARCHITECTURE.md`.

## Hackathon disclosure
This repository is an independent project. The same author has also submitted **Tripwire** (Memecoins With Mechanics track), a separate codebase, to the NEAR Hackathon. The two projects share no code.

## Credits
NEAR Intents 1Click API (https://docs.near-intents.org), NEAR AI Cloud (https://docs.near.ai). There are no third-party runtime dependencies: only Node.js built-ins (`node:http`, `node:sqlite`, `node:crypto`, `node:test`).

## License
MIT. See `LICENSE`.
