# Ferry: exact-amount checkout across chains

<img src="public/logo.svg" width="64" alt="Ferry logo">

Ferry gives merchants a checkout link, an embeddable button, and an evidence inbox. The merchant sets **one destination amount** and **the address it goes to**. The buyer pays with any asset in the live NEAR Intents list, from that asset's chain. **NEAR Intents 1Click** `EXACT_OUTPUT` quotes request that destination amount only if an eligible swap completes. `amountIn` is a buffered suggestion. `minAmountIn` is the minimum. **The inbox** shows what is paid, processing, or needs a person, including unknowns, freshness, and resolution notes. **NEAR AI Cloud** can draft storefront copy, and can describe one order's stored evidence. It cannot change a price, a payout, or a payment.

Ferry is built for the NEAR Hackathon (Nov 2026). It follows NEAR co-founder Illia Polosukhin's "universal checkout widget" idea.

## Status (be precise)
| Area | State |
|---|---|
| Live asset discovery (`GET /v0/tokens`) | Working against the public API (216 assets on 2026-11-08) |
| Exact-output request shape | Checked live with `dry: true` quotes (`npm run` → `node scripts/live-dry-quote.js`) |
| Real deposit address → settlement → paid | Implemented and covered by fixture tests. **No mainnet payment has been verified** (NEAR Intents has no testnet). Inbox counts are stored orders, never simulated cases |
| Reconciliation inbox | Rules diagnosis, timeline, freshness, unknowns, resolution notes, and a formula-safe CSV. Missing provider amounts stay UNKNOWN. A failed refresh is not described as fresh |
| NEAR AI | Copy drafts were checked live on 2026-11-08 (`docs/evidence/near-ai-live-draft-2026-11-08.json`). Order explanations use the same key and the same health states. A set key stays **unverified** until a real success, and HTTP 401/403 stays **auth_failed**. This build does not claim the hosted key works |
| Storage | SQLite locally; Postgres (Neon) in production. The test suite runs against both, with Postgres via PGlite over the wire protocol |
| QR codes, quote replacement, extra-payment detection | Implemented and tested |
| Merchant webhooks | Not implemented (see Docs → Limits) |

## Run locally
```bash
node --version                 # 22.13+ (built-in node:sqlite)
npm run merchant:create -- "My Store"
npm start                      # http://127.0.0.1:4317
FERRY_DEV=1 npm start          # dev mode: creates a clearly labelled SAMPLE merchant on an empty DB
npm test                       # unit + HTTP suites on SQLite and Postgres (fixtures shaped from a real 1Click response)
node scripts/live-ai-draft.js  # one live NEAR AI draft (uses NEAR_AI_API_KEY; never prints it)
node scripts/live-dry-quote.js base USDC 2   # live dry quote; no funds, no deposit address
```
Server-side environment (never sent to the browser): `NEAR_AI_API_KEY`, `NEAR_AI_MODEL` (default `Qwen/Qwen3.8-27B`), `NEAR_AI_MAX_TOKENS` (default 1500), `DATABASE_URL` (Postgres; required in production), `CRON_SECRET`, `ONECLICK_JWT` (optional partner key; unauthenticated quotes pay an extra platform fee), `PUBLIC_BASE_URL`, `FERRY_DB`, `PORT`, `QUOTE_TTL_MINUTES`, `SLIPPAGE_BPS`.

## How it works
1. **Order**: the server fixes the item, the amount as integer base units, the payout asset and the recipient. Buyers get a secret `/c/chk_…` URL.
2. **Quote**: `POST /v0/quote` with `swapType: EXACT_OUTPUT`, `amount` set to the order amount, `ORIGIN_CHAIN` deposit and refund, and `DESTINATION_CHAIN` recipient. Ferry rejects any response that doesn't repeat what was asked, then stores the quote together with 1Click's signature.
3. **Deposit**: the buyer sees the amount, the minimum, the one-time address, any memo, a countdown and refund details.
4. **Paid**: only when `GET /v0/status` returns `SUCCESS` and the deposit address, memo, signature, swap type, recipient, destination asset and amount all match. A SUCCESS that doesn't match goes to `needs_review`. No client callback or transaction hash can mark an order paid. `KNOWN_DEPOSIT_TX` is a seen deposit, not settlement. The provider has no `EXPIRED` status. Local invoice expiry does not hide an in-flight deposit.
5. **Inbox**: deterministic rules label partial, late, contradictory, stale, and overpaid cases. A shortfall is `minAmountIn` minus a reported deposit, never `amountIn` minus a guess. Resolution notes and the optional AI narrative do not change payment state. The quote deadline is when funds may be lost. Ferry does not promise a late refund.

No database migration is required for the inbox. Notes and narratives are appended `order_events`. Existing merchant rows are not edited.

The AI can only produce copy, an accent colour from a fixed palette, and suggested asset IDs from the live list. A deterministic validator rejects any field resembling a price, payout, address, payment status or transfer. Each field needs the merchant's approval, and products need a price the merchant enters themselves.

Hosting on Vercel with Neon: see Docs → Hosting. See `/docs` in the app (`public/docs.html`) and `docs/ARCHITECTURE.md`.

## Hackathon disclosure
This repository is an independent project. The same author has also submitted **Tripwire** (Memecoins With Mechanics track), a separate codebase, to the NEAR Hackathon. The two projects share no code.

## Credits
NEAR Intents 1Click API (https://docs.near-intents.org), NEAR AI Cloud (https://docs.near.ai). Runtime dependencies: `pg` (MIT) and `qrcode` (MIT). Dev/test only: `@electric-sql/pglite` and `@electric-sql/pglite-socket` (Apache-2.0). Everything else uses Node.js built-ins.

## License
MIT. See `LICENSE`.
