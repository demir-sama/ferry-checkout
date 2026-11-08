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
  db.js         SQLite schema (merchants, sessions, products, orders, quotes, order_events, ai_drafts, kv)
background poller: every 15 s refreshes orders with non-final quotes
```

## Invariants
- Order amount, asset and recipient are written once and never updated.
- Secrets (merchant access keys, sessions, checkout secrets) are stored only as SHA-256 hashes.
- `paid` can only be set by `refreshOrder()` after `verifySuccess()` passes.
- New quotes are refused while the order is processing, has an incomplete deposit, needs review, has expired or is paid. Each order is capped at 6 quotes.
- The AI never receives the payout recipient, and its output never flows into payout, price, quote or status fields.

## Hosting later (not done)
- Single process with SQLite on a persistent disk works for a demo. For serverless hosting, port `db.js` to Postgres (for example, Neon's free tier) and run the poller as a cron job or queue.
- Set `PUBLIC_BASE_URL` to the https origin so session cookies get `Secure`.
- Webhooks: signed with HMAC-SHA256, sent only to https destinations the merchant has allowlisted and that resolve to public IPs (SSRF guard), with an idempotency key per event and exponential-backoff retries.
