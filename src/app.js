// HTTP layer: routing, auth, CSRF/origin checks, rate limits, security headers and static files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomId, sha256 } from './ids.js';
import { now } from './db.js';
import { HttpError } from './service.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/dashboard': 'dashboard.html', '/docs': 'docs.html', '/about': 'about.html', '/demo-store': 'demo-store.html' };
const SESSION_COOKIE = 'ferry_session';
const SESSION_HOURS = 12;

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const t = Date.now(); const h = hits.get(key) || { n: 0, reset: t + windowMs };
    if (t > h.reset) { h.n = 0; h.reset = t + windowMs; }
    h.n++; hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (t > v.reset) hits.delete(k);
    return h.n <= limit;
  };
}

export function createApp({ db, cfg, service, assistant, ai, tokens, oneClick, log = () => {} }) {
  const limits = { order: rateLimiter({ limit: 20, windowMs: 60e3 }), quote: rateLimiter({ limit: 12, windowMs: 60e3 }), login: rateLimiter({ limit: 10, windowMs: 10 * 60e3 }), ai: rateLimiter({ limit: 6, windowMs: 60e3 }), status: rateLimiter({ limit: 120, windowMs: 60e3 }) };

  const send = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
  async function readJson(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new HttpError(413, 'Body too large'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true; // non-browser clients
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  function merchantFromSession(req) {
    const tok = cookies(req)[SESSION_COOKIE];
    if (!tok) return null;
    const row = db.prepare('SELECT merchant_id, expires_at FROM sessions WHERE token_hash=?').get(sha256(tok));
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    return row.merchant_id;
  }
  const ip = (req) => req.socket.remoteAddress || 'unknown';
  const secureCookie = cfg.publicBaseUrl.startsWith('https://') ? '; Secure' : '';

  async function serveStatic(res, file) {
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    try {
      const data = await fs.promises.readFile(full);
      res.statusCode = 200; res.setHeader('content-type', MIME[path.extname(full)] || 'application/octet-stream');
      res.setHeader('cache-control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=300');
      if (file === 'embed.js') res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.end(data);
    } catch { send(res, 404, { error: 'Not found' }); }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname; const m = req.method;
    // ---------- pages ----------
    if (m === 'GET' && PAGES[p]) return serveStatic(res, PAGES[p]);
    if (m === 'GET' && /^\/c\/chk_[A-Za-z0-9_-]{20,60}$/.test(p)) return serveStatic(res, 'checkout.html');
    if (m === 'GET' && /^\/p\/prd_[A-Za-z0-9_-]{8,20}$/.test(p)) return serveStatic(res, 'product.html');
    if (m === 'GET' && /^\/[a-z0-9-]+\.(css|js|svg|png|ico|webmanifest|txt)$/.test(p)) return serveStatic(res, p.slice(1));
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // ---------- public api ----------
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: now(), nearAi: { configured: ai.configured, model: ai.model }, oneClick: { authenticated: oneClick.authenticated, base: cfg.oneClickBase }, devMode: cfg.devMode });
    if (m === 'GET' && p === '/api/assets') {
      const t = await tokens.list();
      return send(res, 200, { source: t.source, fetchedAt: t.fetchedAt, count: t.list.length, assets: t.list });
    }
    let mt;
    if (m === 'GET' && (mt = p.match(/^\/api\/public\/products\/(prd_[A-Za-z0-9_-]{8,20})$/))) return send(res, 200, service.publicProduct(mt[1]));
    if (m === 'POST' && (mt = p.match(/^\/api\/public\/products\/(prd_[A-Za-z0-9_-]{8,20})\/orders$/))) {
      if (!limits.order(ip(req))) throw new HttpError(429, 'Too many orders; slow down');
      const o = service.createOrderForProduct(mt[1]);
      return send(res, 201, { checkoutUrl: o.checkoutUrl, checkoutPath: `/c/${o.checkoutSecret}` });
    }
    if ((mt = p.match(/^\/api\/checkout\/(chk_[A-Za-z0-9_-]{20,60})(\/quote|\/status)?$/))) {
      const [, secret, sub] = mt;
      if (m === 'GET' && !sub) return send(res, 200, service.checkoutView(secret));
      if (m === 'GET' && sub === '/status') { if (!limits.status(ip(req))) throw new HttpError(429, 'Too many requests'); return send(res, 200, await service.checkoutStatus(secret)); }
      if (m === 'POST' && sub === '/quote') {
        if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');
        if (!limits.quote(ip(req))) throw new HttpError(429, 'Too many quote requests; wait a minute');
        const b = await readJson(req);
        return send(res, 201, await service.createQuote(secret, { originAssetId: b.originAssetId, refundTo: b.refundTo }));
      }
    }

    // ---------- auth ----------
    if (m === 'POST' && p === '/api/auth/login') {
      if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');
      if (!limits.login(ip(req))) throw new HttpError(429, 'Too many sign-in attempts; try again later');
      const b = await readJson(req);
      const key = String(b.accessKey || '');
      const mer = key.startsWith('fk_') ? db.prepare('SELECT id FROM merchants WHERE access_key_hash=?').get(sha256(key)) : null;
      if (!mer) throw new HttpError(401, 'Access key not recognised');
      const tok = randomId('ses', 32);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('INSERT INTO sessions(token_hash, merchant_id, expires_at) VALUES (?,?,?)').run(sha256(tok), mer.id, new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString());
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secureCookie}`);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      const tok = cookies(req)[SESSION_COOKIE];
      if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(tok));
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
      return send(res, 200, { ok: true });
    }

    // ---------- merchant api (session required) ----------
    if (p.startsWith('/api/merchant')) {
      const merchantId = merchantFromSession(req);
      if (!merchantId) throw new HttpError(401, 'Sign in required');
      if (m !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');
      if (m === 'GET' && p === '/api/merchant') return send(res, 200, { merchant: service.merchantView(service.getMerchant(merchantId)), nearAi: { configured: ai.configured, model: ai.model } });
      if (m === 'PUT' && p === '/api/merchant') return send(res, 200, { merchant: await service.updateSettings(merchantId, await readJson(req)) });
      if (m === 'GET' && p === '/api/merchant/products') return send(res, 200, { products: service.listProducts(merchantId) });
      if (m === 'POST' && p === '/api/merchant/products') return send(res, 201, { product: service.createProduct(merchantId, await readJson(req)) });
      if (m === 'POST' && (mt = p.match(/^\/api\/merchant\/products\/(prd_[A-Za-z0-9_-]+)\/(activate|deactivate)$/))) { service.setProductActive(merchantId, mt[1], mt[2] === 'activate'); return send(res, 200, { ok: true }); }
      if (m === 'GET' && p === '/api/merchant/orders') return send(res, 200, { orders: service.listOrders(merchantId) });
      if (m === 'POST' && p === '/api/merchant/orders') { const o = service.createInvoice(merchantId, await readJson(req)); return send(res, 201, { orderId: o.orderId, checkoutUrl: o.checkoutUrl }); }
      if (m === 'GET' && (mt = p.match(/^\/api\/merchant\/orders\/(ord_[A-Za-z0-9_-]+)$/))) return send(res, 200, await service.merchantOrder(merchantId, mt[1], { refresh: url.searchParams.get('refresh') === '1' }));
      if (m === 'GET' && p === '/api/merchant/ai/drafts') return send(res, 200, { drafts: assistant.list(merchantId) });
      if (m === 'POST' && p === '/api/merchant/ai/drafts') {
        if (!limits.ai(merchantId)) throw new HttpError(429, 'Too many AI requests; wait a minute');
        const b = await readJson(req); return send(res, 201, { draft: await assistant.generate(merchantId, b.brief) });
      }
      if (m === 'POST' && (mt = p.match(/^\/api\/merchant\/ai\/drafts\/(drf_[A-Za-z0-9_-]+)\/(approve|reject)$/))) {
        const b = await readJson(req);
        if (mt[2] === 'reject') { assistant.reject(merchantId, mt[1]); return send(res, 200, { ok: true }); }
        return send(res, 200, await assistant.approve(merchantId, mt[1], b));
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  return async function handler(req, res) {
    securityHeaders(res);
    try { await route(req, res); }
    catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      log('unhandled', e); send(res, 500, { error: 'Internal error' });
    }
  };
}
