// Thin client for the public NEAR Intents 1Click API (https://1click.chaindefuser.com/docs/v0/openapi.yaml).
export const REMOTE_STATUSES = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];

export class OneClickError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export function createOneClick({ baseUrl, jwt, fetchImpl = fetch, timeoutMs = 15000 }) {
  async function call(method, pathname, body) {
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (jwt) headers.authorization = `Bearer ${jwt}`;
    const res = await fetchImpl(baseUrl + pathname, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new OneClickError(json?.message || `1Click HTTP ${res.status}`, res.status, json ?? text.slice(0, 500));
    return json;
  }
  return {
    authenticated: Boolean(jwt),
    tokens: () => call('GET', '/v0/tokens'),
    quote: (req) => call('POST', '/v0/quote', req),
    status: (depositAddress, depositMemo) => {
      const q = new URLSearchParams({ depositAddress });
      if (depositMemo) q.set('depositMemo', depositMemo);
      return call('GET', `/v0/status?${q}`);
    },
  };
}
