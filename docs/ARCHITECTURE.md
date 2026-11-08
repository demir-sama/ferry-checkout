# Architecture

```
browser (static pages, no third-party JS)
  ├─ /p/:product  → POST /api/public/products/:id/orders  (rate-limited)
  ├─ /c/:secret   → GET/POST /api/checkout/:secret{,/quote,/status}
  └─ /dashboard   → /api/auth/login (HttpOnly SameSite=Strict session) → /api/merchant/*
server (Node, src/)
  app.js        routing, CSP, same-origin checks, body limits, rate limits
  service.js    merchants, products, orders, quotes, reconciliation
  reconcile.js  pure rules: verifySuccess(), deriveOrderStatus()
  oneclick.js   1Click client (tokens, quote, status); optional partner JWT
  tokens.js     live asset cache (5 min) + persisted fallback
  ai.js         NEAR AI client, DRAFT_SCHEMA, validateDraft(), approval flow
  db.js         async store: SQLite (local/tests) or Postgres via pg (Neon); one schema; DB-backed rate limits
api/index.js    Vercel Function entry; vercel.json rewrites all routes here; daily cron → /api/cron/poll
background poller: every 15 s refreshes orders with non-final quotes
```

## Invariants
- Order amount, asset and recipient are written once and never updated.
- Secrets (merchant access keys, sessions, checkout secrets) are stored only as SHA-256 hashes.
- `paid` can only be set by `refreshOrder()` after `verifySuccess()` passes.
- Quote creation is single-flight per order through a DB lease (`quote_lock_until`). Replacing live instructions requires explicit buyer confirmation. Every quote stays polled after payment, so a second settlement sets `extra_payment`.
- New quotes are refused while the order is processing, has an incomplete deposit, needs review, has expired or is paid. Each order is capped at 6 quotes.
- The AI never receives the payout recipient, and its output never flows into payout, price, quote or status fields.

## Hosting
- Vercel (Node.js, Fluid Compute) with `DATABASE_URL` set to a dedicated Neon project's pooled URL. Run migrations with the direct URL (`npm run db:migrate`).
- Production refuses SQLite, `FERRY_DEV`, and non-https upstream/base URLs.
- Webhooks are intentionally not implemented. A future design: HMAC-SHA256 signatures, https destinations allowlisted by the merchant that resolve to public IPs, idempotency keys, and backoff retries.
