// NEAR AI Cloud setup assistant. The model only drafts storefront copy and suggests accepted assets.
// It never sees or sets payout destination, prices, quotes or payment status. Every draft is validated
// deterministically and applied only after the merchant approves specific fields.
import { randomId, sha256 } from './ids.js';
import { buildAllowlist, validateSelection } from './narrative-claims.js';
import { now } from './db.js';
import { HttpError } from './service.js';

export const ACCENTS = ['ocean', 'ember', 'moss', 'violet', 'graphite', 'gold'];
const FORBIDDEN_KEY = /recipient|payout|wallet|address|price|amount|deposit|status|paid|refund|transfer|private.?key|secret|sign|execute|message/i;

// The model returns ids only. Ferry renders every sentence from the allowlist.
export const NARRATIVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['claimIds', 'stepId'],
  properties: {
    claimIds: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 80 } },
    stepId: { type: 'string', maxLength: 80 },
  },
};

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

// Accepts an allowlist selection. Free text is not a narrative, even if it cites real ids.
export function validateNarrative(raw, { allowlist } = {}) {
  return validateSelection(raw, allowlist);
}

export function createNearAi({ baseUrl, apiKey, model, maxTokens = 1500, fetchImpl = fetch, timeoutMs = 60000 }) {
  async function complete(body, noun) {
    if (!apiKey) throw new HttpError(503, `NEAR AI is not configured on this server (NEAR_AI_API_KEY is unset). No ${noun} was generated.`, 'NEAR_AI_NOT_CONFIGURED');
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw new HttpError(502, `NEAR AI request failed: ${e.message}`, 'NEAR_AI_UNREACHABLE'); }
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 402 ? ' (credits required)' : res.status === 401 ? ' (API key rejected)' : res.status === 429 ? ' (rate limited)' : res.status >= 500 ? ' (model temporarily unavailable)' : '';
      throw new HttpError(502, `NEAR AI returned HTTP ${res.status}${hint}. No ${noun} was generated.`, res.status === 401 || res.status === 403 ? 'NEAR_AI_AUTH' : 'NEAR_AI_ERROR');
    }
    let parsed; try { parsed = JSON.parse(text); } catch { throw new HttpError(502, 'NEAR AI response was not JSON', 'NEAR_AI_ERROR'); }
    const choice = parsed?.choices?.[0] || {};
    const content = choice.message?.content;
    const u = parsed?.usage || {};
    const usage = { promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null, reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? null };
    if (choice.finish_reason === 'length') throw new HttpError(502, `NEAR AI stopped at the token limit before finishing the ${noun} (${usage.completionTokens ?? '?'} tokens). No ${noun} was generated.`, 'NEAR_AI_TRUNCATED');
    let json; try { json = JSON.parse(content); } catch { json = null; }
    return { json, rawContent: typeof content === 'string' ? content.slice(0, 8000) : null, responseId: parsed?.id || null, model: parsed?.model || model, finishReason: choice.finish_reason ?? null, usage };
  }
  const thinkingOff = { enable_thinking: false };
  return {
    configured: Boolean(apiKey), model, baseUrl,
    async draft({ brief, storeName, assetMenu }) {
      const out = await complete({
        model, temperature: 0.3, max_tokens: maxTokens, chat_template_kwargs: thinkingOff,
        response_format: { type: 'json_schema', json_schema: { name: 'ferry_store_draft', strict: true, schema: DRAFT_SCHEMA } },
        messages: [
          { role: 'system', content: 'You draft storefront copy for a crypto checkout page. Output only JSON matching the schema. You do not set prices, wallets, addresses, payouts or payment status; never mention specific prices. suggestedAssetIds must be chosen only from the provided asset menu ids. Keep copy factual; do not promise anything about chains or fees.' },
          { role: 'user', content: `Store name: ${storeName}\nMerchant brief:\n${brief}\n\nAsset menu (id | symbol | chain):\n${assetMenu}` },
        ],
      }, 'draft');
      return { draft: out.json, ...out };
    },
    async narrate({ allowlist }) {
      const menu = { mandatoryClaimIds: allowlist.mandatoryClaimIds, claims: allowlist.claims.map((c) => ({ id: c.id, text: c.text })), steps: allowlist.steps.map((s) => ({ id: s.id, text: s.text })) };
      const out = await complete({
        model, temperature: 0, max_tokens: maxTokens, chat_template_kwargs: thinkingOff,
        response_format: { type: 'json_schema', json_schema: { name: 'ferry_case_narrative', strict: true, schema: NARRATIVE_SCHEMA } },
        messages: [
          { role: 'system', content: 'Choose claimIds and one stepId from the allowlist only. Return those ids and no other fields. Do not write amounts, deadlines, refresh results, or actions. Ferry writes every sentence that is shown.' },
          { role: 'user', content: JSON.stringify(menu) },
        ],
      }, 'explanation');
      return { narrative: out.json, ...out };
    },
  };
}

export function createAssistant({ db, ai, tokens, service }) {
  const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const view = (r) => ({ id: r.id, brief: r.brief, model: r.model, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, draft: j(r.draft, null), validation: j(r.validation, {}) });
  async function generate(merchantId, brief) {
    const b = String(brief ?? '').trim();
    if (b.length < 10 || b.length > 1500) throw new HttpError(400, 'Describe your store in 10–1500 characters');
    if (!ai.configured) throw new HttpError(503, 'NEAR AI is not configured on this server (NEAR_AI_API_KEY is unset). No draft was generated.', 'NEAR_AI_NOT_CONFIGURED');
    const m = await service.getMerchant(merchantId);
    const live = (await tokens.list()).list;
    const menu = live.filter((t) => ['USDC', 'USDT', 'ETH', 'BTC', 'SOL', 'wNEAR', 'NEAR', 'ZEC', 'TON', 'XRP', 'DOGE'].includes(t.symbol)).slice(0, 60)
      .map((t) => `${t.assetId} | ${t.symbol} | ${t.blockchain}`).join('\n');
    let out;
    try { out = await ai.draft({ brief: b, storeName: m.name, assetMenu: menu }); }
    catch (e) { if (e.code === 'NEAR_AI_AUTH') await setStatus('auth_failed'); throw e; }
    await setStatus('verified'); // only after an actual successful provider response
    const validation = validateDraft(out.draft, { liveAssetIds: new Set(live.map((t) => t.assetId)) });
    const id = randomId('drf', 9);
    await db.run('INSERT INTO ai_drafts(id,merchant_id,brief,model,draft,validation,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, merchantId, b, String(out.model).slice(0, 120), JSON.stringify(validation.ok ? validation.value : { rejectedRaw: out.rawContent }),
        JSON.stringify({ ok: validation.ok, errors: validation.errors.slice(0, 20), responseId: out.responseId, usage: out.usage || null }), validation.ok ? 'pending' : 'invalid', now()]);
    return view(await db.get('SELECT * FROM ai_drafts WHERE id=?', [id]));
  }
  // Connection state is only ever derived from real provider responses; holding a key proves nothing.
  const LABELS = {
    unset: 'Not configured: NEAR_AI_API_KEY is unset. Drafting is unavailable.',
    unverified: 'Key set — connection not verified. No successful NEAR AI response yet.',
    verified: 'Connected: the last NEAR AI request succeeded.',
    auth_failed: 'NEAR AI rejected the API key (HTTP 401/403) on the last attempt. Drafting will fail until the operator fixes the key.',
  };
  async function setStatus(state) {
    await db.run('INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at', ['near_ai_status', state, now()]);
  }
  async function status() {
    let state = 'unset', checkedAt = null;
    if (ai.configured) {
      const row = await db.get('SELECT v, updated_at FROM kv WHERE k = ?', ['near_ai_status']);
      state = row && LABELS[row.v] && row.v !== 'unset' ? row.v : 'unverified'; checkedAt = row ? row.updated_at : null;
    }
    return { configured: ai.configured, status: state, label: LABELS[state], checkedAt, model: ai.model };
  }
  const list = async (merchantId) => (await db.all('SELECT * FROM ai_drafts WHERE merchant_id=? ORDER BY created_at DESC LIMIT 20', [merchantId])).map(view);
  // Merchant approves selected fields. Product copy becomes products only with merchant-entered prices. All-or-nothing.
  async function approve(merchantId, draftId, { fields = [], productPrices = {} } = {}) {
    if (!Array.isArray(fields) || fields.length > 30) throw new HttpError(400, 'Invalid field selection');
    const want = new Set(fields.map(String));
    const r = await db.get('SELECT * FROM ai_drafts WHERE id=? AND merchant_id=?', [draftId, merchantId]);
    if (!r) throw new HttpError(404, 'Draft not found');
    if (r.status !== 'pending') throw new HttpError(409, `Draft is ${r.status}`);
    const d = j(r.draft, null);
    const m = await service.getMerchant(merchantId);
    const wantedProducts = d.productCopy.map((p, i) => ({ p, i })).filter(({ i }) => want.has(`product:${i}`));
    if (wantedProducts.length && !m.payout_asset_id) throw new HttpError(409, 'Set a payout asset before adding products');
    for (const { p, i } of wantedProducts) {
      const price = productPrices?.[i] ?? productPrices?.[String(i)];
      if (price == null || price === '') throw new HttpError(400, `Enter your own price for "${p.name}" before approving it`);
      service.priceToBase(String(price), Number(m.payout_decimals), `Price for "${p.name}"`);
    }
    let accepted = null;
    if (want.has('suggestedAssetIds')) {
      const live = new Set((await tokens.list()).list.map((t) => t.assetId));
      accepted = [...new Set([...j(m.accepted_assets, []), ...d.suggestedAssetIds])].filter((a) => live.has(a)).slice(0, 60);
    }
    const created = [];
    await db.tx(async (x) => {
      const claim = await x.run('UPDATE ai_drafts SET status=?, decided_at=? WHERE id=? AND merchant_id=? AND status=?', ['approved', now(), draftId, merchantId, 'pending']);
      if (!claim.changes) throw new HttpError(409, 'Draft was already decided');
      const profile = j(m.profile, {});
      for (const f of ['tagline', 'about', 'buttonLabel', 'accent', 'faq']) if (want.has(f)) profile[f] = d[f];
      await service.setProfile(merchantId, profile, x);
      if (accepted) await x.run('UPDATE merchants SET accepted_assets=?, updated_at=? WHERE id=?', [JSON.stringify(accepted), now(), merchantId]);
      for (const { p, i } of wantedProducts) created.push(await service.createProduct(merchantId, { name: p.name, description: p.description, price: String(productPrices[i] ?? productPrices[String(i)]) }, x));
    });
    return { draft: view(await db.get('SELECT * FROM ai_drafts WHERE id=?', [draftId])), createdProducts: created, merchant: service.merchantView(await service.getMerchant(merchantId)) };
  }
  async function reject(merchantId, draftId) {
    const r = await db.run('UPDATE ai_drafts SET status=?, decided_at=? WHERE id=? AND merchant_id=? AND status=?', ['rejected', now(), draftId, merchantId, 'pending']);
    if (!r.changes) throw new HttpError(404, 'Pending draft not found');
  }
  // Explains stored evidence. Refresh first when the provider can be asked. Never writes price, payout, or payment status.
  async function explain(merchantId, orderId) {
    await service.merchantOrder(merchantId, orderId); // 404 before any provider call if the order is not this merchant's
    if (!ai.configured) throw new HttpError(503, 'NEAR AI is not configured on this server (NEAR_AI_API_KEY is unset). No explanation was generated.', 'NEAR_AI_NOT_CONFIGURED');
    const pack = await service.caseEvidence(merchantId, orderId, { refresh: true });
    const before = { status: pack.order.status, amount: pack.order.amount_out_base, recipient: pack.order.recipient };
    const allowlist = buildAllowlist(pack.facts);
    let out;
    try { out = await ai.narrate({ allowlist }); }
    catch (e) { if (e.code === 'NEAR_AI_AUTH') await setStatus('auth_failed'); throw e; }
    await setStatus('verified');
    const validation = validateNarrative(out.narrative, { allowlist });
    const narrativeId = randomId('nar', 9);
    const factsDigest = sha256(JSON.stringify(pack.facts)).slice(0, 16);
    await service.recordNarrative(orderId, {
      narrativeId, status: validation.ok ? 'stored' : 'invalid', model: String(out.model).slice(0, 120), factsDigest,
      narrative: validation.ok ? validation.value : null, errors: validation.errors.slice(0, 20),
      responseId: out.responseId, refreshFailed: pack.refreshFailed,
    });
    const orderAfter = await service.merchantOrder(merchantId, orderId);
    return {
      explanation: { id: narrativeId, status: validation.ok ? 'stored' : 'invalid', model: out.model, factsDigest, narrative: validation.ok ? validation.value : null, errors: validation.errors.slice(0, 20), authority: 'none', accepted: validation.ok, composedBy: validation.ok ? 'ferry' : null, selectedBy: validation.ok ? 'near-ai' : null, label: validation.ok ? 'Ferry wrote these sentences from stored evidence. NEAR AI selected them. Not a payment decision.' : 'NEAR AI selection rejected. No explanation text is shown.' },
      diagnosis: orderAfter.diagnosis,
      unchanged: before.status === orderAfter.status && before.amount === orderAfter.amount.base && before.recipient === orderAfter.recipient,
    };
  }
  return { status, generate, list, approve, reject, explain };
}
