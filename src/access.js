/**
 * Cloudflare Access JWT verification.
 *
 * Every request that passes the Access policy carries a Cf-Access-Jwt-Assertion
 * header. The header alone proves nothing: if Access is misconfigured or a
 * path is bypassed, a caller can type any header they like. So we verify the
 * JWT signature against the Zero Trust team's public keys and check the
 * audience tag. Only a JWT minted by this team for this Access app passes, and
 * until both values are set nothing passes at all.
 *
 * Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 *
 * Required secrets (SETUP.md step 3):
 *   ACCESS_TEAM_DOMAIN   e.g. "yourteam.cloudflareaccess.com"
 *   ACCESS_APP_AUD       the Access application's Audience (AUD) tag
 *                        (Zero Trust -> Access -> Applications -> your app -> Overview)
 */

function clean(v) {
  return typeof v === 'string' ? v.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
}

// A team domain is <team>.cloudflareaccess.com; an AUD tag is 64 hex characters.
// Anything else (blank, "pending", a placeholder) means setup is not finished,
// and the UI shows instructions instead of a failed sign-in.
const TEAM_RE = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;
const AUD_RE  = /^[a-f0-9]{64}$/i;

/** True once both Access values hold something that looks real. */
export function accessConfigured(env) {
  return TEAM_RE.test(clean(env.ACCESS_TEAM_DOMAIN)) && AUD_RE.test(clean(env.ACCESS_APP_AUD));
}

// Module-level cache. Workers isolates persist between requests, so most
// requests skip the JWKS fetch. Access rotates keys roughly every 6 weeks;
// we also refetch on an unknown kid, which covers rotation mid-TTL.
let jwksCache = { keys: {}, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getSigningKey(kid, env) {
  const stale = Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (stale || !jwksCache.keys[kid]) {
    const res = await fetch(`https://${clean(env.ACCESS_TEAM_DOMAIN)}/cdn-cgi/access/certs`);
    if (!res.ok) return jwksCache.keys[kid] ?? null;
    const { keys } = await res.json();
    const imported = {};
    for (const jwk of keys ?? []) {
      try {
        imported[jwk.kid] = await crypto.subtle.importKey(
          'jwk', jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false, ['verify'],
        );
      } catch { /* skip malformed keys */ }
    }
    jwksCache = { keys: imported, fetchedAt: Date.now() };
  }
  return jwksCache.keys[kid] ?? null;
}

/**
 * Verify an Access JWT. Returns the claims object ({ email, ... }) on success,
 * null on any failure. Fails closed: missing config means nothing verifies.
 */
export async function verifyAccessJwt(token, env) {
  if (!token || !accessConfigured(env)) return null;
  const teamDomain = clean(env.ACCESS_TEAM_DOMAIN);
  const expectedAud = clean(env.ACCESS_APP_AUD);
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || now > claims.exp) return null;
  if (typeof claims.nbf === 'number' && now < claims.nbf - 60) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expectedAud)) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;

  const key = await getSigningKey(header.kid, env);
  if (!key) return null;

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), data);
  return valid ? claims : null;
}
