import crypto from 'node:crypto';
export const randomId = (prefix, bytes = 12) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
