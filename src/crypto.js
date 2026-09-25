/**
 * Encryption for values kept in KV, keyed by the CONFIG_KEY wrangler secret.
 *
 * Why: API keys entered in the app are stored in KV. KV is encrypted at rest,
 * but anyone with dashboard access can read KV values in the clear. Wrangler
 * secrets are write-only in the dashboard, so we keep one secret (CONFIG_KEY)
 * and use it to AES-GCM encrypt everything else. Dashboard viewers see
 * ciphertext; the worker decrypts at request time.
 *
 * The same secret derives the Apollo webhook token, so an install needs
 * exactly one `wrangler secret put`.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

let keyCache = { secret: null, key: null };

/** True when CONFIG_KEY is set and long enough to be worth using. */
export function encryptionReady(env) {
  return typeof env.CONFIG_KEY === 'string' && env.CONFIG_KEY.trim().length >= 32;
}

async function getAesKey(env) {
  if (!encryptionReady(env)) return null;
  const secret = env.CONFIG_KEY.trim();
  if (keyCache.secret === secret) return keyCache.key;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  keyCache = { secret, key };
  return key;
}

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a string. Output format: v1.<iv b64>.<ciphertext b64>. */
export async function encryptString(plain, env) {
  const key = await getAesKey(env);
  if (!key) throw new Error('CONFIG_KEY secret is not set. See SETUP.md.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

/** Decrypt a string produced by encryptString. Returns null if it cannot be decrypted. */
export async function decryptString(blob, env) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) return null;
  const key = await getAesKey(env);
  if (!key) return null;
  try {
    const [, ivB64, ctB64] = blob.split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, fromB64(ctB64));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/**
 * Derive a stable token from CONFIG_KEY for a named purpose. Used for the
 * Apollo webhook URL so no separate secret is needed for it.
 */
export async function deriveToken(purpose, env) {
  if (!encryptionReady(env)) return '';
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.CONFIG_KEY.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`growably-contact-enricher:${purpose}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison via SHA-256 digests. */
export async function secretMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(candidate)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
