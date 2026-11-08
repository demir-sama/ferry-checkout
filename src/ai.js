// NEAR AI Cloud setup assistant. The model only drafts storefront copy and suggests accepted assets.
// It never sees or sets payout destination, prices, quotes or payment status. Every draft is validated
// deterministically and applied only after the merchant approves specific fields.
import { randomId } from './ids.js';
import { now } from './db.js';
import { HttpError } from './service.js';
import { parseUnits } from './amounts.js';

export const ACCENTS = ['ocean', 'ember', 'moss', 'violet', 'graphite', 'gold'];
const FORBIDDEN_KEY = /recipient|payout|wallet|address|price|amount|deposit|status|paid|refund|transfer|private.?key|secret/i;

// JSON Schema sent to NEAR AI as response_format (strict). Mirrors validateDraft below.
export const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['tagline', 'about', 'buttonLabel', 'accent', 'productCopy', 'faq', 'suggestedAssetIds'],
  properties: {
    tagline: { type: 'string', maxLength: 90 },
    about: { type: 'string', maxLength: 600 },
    buttonLabel: { type: 'string', maxLength: 28 },
    accent: { type: 'string', enum: ACCENTS },
    productCopy: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['name', 'description'],
      properties: { name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 400 } } } },
    faq: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['q', 'a'],
      properties: { q: { type: 'string', maxLength: 140 }, a: { type: 'string', maxLength: 400 } } } },
    suggestedAssetIds: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 140 } },
  },
};

const isStr = (v, max, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const noMarkup = (v) => !/<\s*\/?\s*[a-z!]/i.test(v);

// Deterministic validator. Returns { ok, errors, value } where value contains only allowed, checked fields.
export function validateDraft(raw, { liveAssetIds }) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['draft is not an object'], value: null };
  const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { if (FORBIDDEN_KEY.test(k)) errors.push(`forbidden field "${p}${k}"`); if (v && typeof v === 'object') walk(v, `${p}${k}.`); } };
  walk(raw, '');
  const allowed = new Set(Object.keys(DRAFT_SCHEMA.properties));
  for (const k of Object.keys(raw)) if (!allowed.has(k)) errors.push(`unexpected field "${k}"`);
  for (const k of DRAFT_SCHEMA.required) if (!(k in raw)) errors.push(`missing field "${k}"`);
  const text = (k, max) => { if (k in raw && !(isStr(raw[k], max) && noMarkup(raw[k]))) errors.push(`"${k}" must be plain text up to ${max} characters`); };
  text('tagline', 90); text('about', 600); text('buttonLabel', 28);
  if ('accent' in raw && !ACCENTS.includes(raw.accent)) errors.push(`"accent" must be one of ${ACCENTS.join(', ')}`);
  const list = (k, max, fields) => {
    if (!(k in raw)) return;
    if (!Array.isArray(raw[k]) || raw[k].length > max) { errors.push(`"${k}" must be a list of at most ${max}`); return; }
    raw[k].forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) { errors.push(`${k}[${i}] must be an object`); return; }
      for (const key of Object.keys(it)) if (!(key in fields)) errors.push(`${k}[${i}] unexpected field "${key}"`);
      for (const [f, m] of Object.entries(fields)) if (!(isStr(it[f], m) && noMarkup(it[f]))) errors.push(`${k}[${i}].${f} must be plain text up to ${m} characters`);
    });
  };
  list('productCopy', 6, { name: 80, description: 400 });
  list('faq', 5, { q: 140, a: 400 });
  let unknownAssets = [];
  if ('suggestedAssetIds' in raw) {
    if (!Array.isArray(raw.suggestedAssetIds) || raw.suggestedAssetIds.length > 12 || raw.suggestedAssetIds.some((a) => typeof a !== 'string')) errors.push('"suggestedAssetIds" must be a list of up to 12 strings');
    else { unknownAssets = raw.suggestedAssetIds.filter((a) => !liveAssetIds.has(a)); if (unknownAssets.length) errors.push(`unknown asset ids: ${unknownAssets.slice(0, 5).join(', ')}`); }
  }
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: {
    tagline: raw.tagline.trim(), about: raw.about.trim(), buttonLabel: raw.buttonLabel.trim(), accent: raw.accent,
    productCopy: raw.productCopy.map((p) => ({ name: p.name.trim(), description: p.description.trim() })),
    faq: raw.faq.map((f) => ({ q: f.q.trim(), a: f.a.trim() })),
    suggestedAssetIds: [...new Set(raw.suggestedAssetIds)],
  } };
}

export function createNearAi({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 60000 }) {
  return {
    configured: Boolean(apiKey), model, baseUrl,
    async draft({ brief, storeName, assetMenu }) {
      if (!apiKey) throw new HttpError(503, 'NEAR AI is not configured on this server (NEAR_AI_API_KEY is unset). No draft was generated.', 'NEAR_AI_NOT_CONFIGURED');
      const body = {
        model, temperature: 0.4, max_tokens: 2000,
        response_format: { type: 'json_schema', json_schema: { name: 'ferry_store_draft', strict: true, schema: DRAFT_SCHEMA } },
        messages: [
          { role: 'system', content: 'You draft storefront copy for a crypto checkout page. Output only JSON matching the schema. You do not set prices, wallets, addresses, payouts or payment status; never mention specific prices. suggestedAssetIds must be chosen only from the provided asset menu ids. Keep copy factual; do not promise anything about chains or fees.' },
          { role: 'user', content: `Store name: ${storeName}\nMerchant brief:\n${brief}\n\nAsset menu (id | symbol | chain):\n${assetMenu}` },
        ],
      };
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) { throw new HttpError(502, `NEAR AI request failed: ${e.message}`, 'NEAR_AI_UNREACHABLE'); }
      const text = await res.text();
      if (!res.ok) throw new HttpError(502, `NEAR AI returned HTTP ${res.status}${res.status === 402 ? ' (credits required)' : ''}`, 'NEAR_AI_ERROR');
      let parsed; try { parsed = JSON.parse(text); } catch { throw new HttpError(502, 'NEAR AI response was not JSON', 'NEAR_AI_ERROR'); }
      const content = parsed?.choices?.[0]?.message?.content;
      let draft; try { draft = JSON.parse(content); } catch { draft = null; }
      return { draft, rawContent: typeof content === 'string' ? content.slice(0, 8000) : null, responseId: parsed?.id || null, model: parsed?.model || model };
    },
  };
}

export function createAssistant({ db, ai, tokens, service }) {
  const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const view = (r) => ({ id: r.id, brief: r.brief, model: r.model, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, draft: j(r.draft, null), validation: j(r.validation, {}) });
  async function generate(merchantId, brief) {
    const b = String(brief ?? '').trim();
    if (b.length < 10 || b.length > 1500) throw new HttpError(400, 'Describe your store in 10–1500 characters');
    const m = service.getMerchant(merchantId);
    const live = (await tokens.list()).list;
    const menu = live.filter((t) => ['USDC', 'USDT', 'ETH', 'BTC', 'SOL', 'wNEAR', 'NEAR', 'ZEC', 'TON', 'XRP', 'DOGE'].includes(t.symbol)).slice(0, 60)
      .map((t) => `${t.assetId} | ${t.symbol} | ${t.blockchain}`).join('\n');
    const out = await ai.draft({ brief: b, storeName: m.name, assetMenu: menu });
    const validation = validateDraft(out.draft, { liveAssetIds: new Set(live.map((t) => t.assetId)) });
    const id = randomId('drf', 9);
    db.prepare('INSERT INTO ai_drafts(id,merchant_id,brief,model,draft,validation,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, merchantId, b, out.model, JSON.stringify(validation.ok ? validation.value : { rejectedRaw: out.rawContent }),
        JSON.stringify({ ok: validation.ok, errors: validation.errors, responseId: out.responseId }), validation.ok ? 'pending' : 'invalid', now());
    return view(db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(id));
  }
  const list = (merchantId) => db.prepare('SELECT * FROM ai_drafts WHERE merchant_id=? ORDER BY created_at DESC LIMIT 20').all(merchantId).map(view);
  // Merchant approves selected fields. Product copy becomes products only with merchant-entered prices.
  async function approve(merchantId, draftId, { fields = [], productPrices = {} } = {}) {
    const r = db.prepare('SELECT * FROM ai_drafts WHERE id=? AND merchant_id=?').get(draftId, merchantId);
    if (!r) throw new HttpError(404, 'Draft not found');
    if (r.status !== 'pending') throw new HttpError(409, `Draft is ${r.status}`);
    const d = j(r.draft, null);
    const want = new Set(fields.map(String));
    const m = service.getMerchant(merchantId);
    // Validate every merchant-entered price before writing anything.
    d.productCopy.forEach((p, i) => {
      if (!want.has(`product:${i}`)) return;
      const price = productPrices[i] ?? productPrices[String(i)];
      if (price == null || price === '') throw new HttpError(400, `Enter your own price for "${p.name}" before approving it`);
      if (!m.payout_decimals && m.payout_decimals !== 0) throw new HttpError(409, 'Set a payout asset before adding products');
      try { if (parseUnits(String(price), m.payout_decimals) <= 0n) throw new Error('must be greater than zero'); }
      catch (e) { throw new HttpError(400, `Price for "${p.name}": ${e.message}`); }
    });
    const profile = j(m.profile, {});
    for (const f of ['tagline', 'about', 'buttonLabel', 'accent', 'faq']) if (want.has(f)) profile[f] = d[f];
    db.prepare('UPDATE merchants SET profile=?, updated_at=? WHERE id=?').run(JSON.stringify(profile), now(), merchantId);
    if (want.has('suggestedAssetIds')) {
      const cur = j(m.accepted_assets, []);
      await service.updateSettings(merchantId, { acceptedAssets: [...new Set([...cur, ...d.suggestedAssetIds])] });
    }
    const created = [];
    d.productCopy.forEach((p, i) => {
      if (!want.has(`product:${i}`)) return;
      const price = productPrices[i] ?? productPrices[String(i)];
      if (price == null || price === '') throw new HttpError(400, `Enter your own price for "${p.name}" before approving it`);
      created.push(service.createProduct(merchantId, { name: p.name, description: p.description, price: String(price) }));
    });
    db.prepare('UPDATE ai_drafts SET status=?, decided_at=? WHERE id=?').run('approved', now(), draftId);
    return { draft: view(db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(draftId)), createdProducts: created, merchant: service.merchantView(service.getMerchant(merchantId)) };
  }
  function reject(merchantId, draftId) {
    const r = db.prepare('UPDATE ai_drafts SET status=?, decided_at=? WHERE id=? AND merchant_id=? AND status=?').run('rejected', now(), draftId, merchantId, 'pending');
    if (!r.changes) throw new HttpError(404, 'Pending draft not found');
  }
  return { generate, list, approve, reject };
}
