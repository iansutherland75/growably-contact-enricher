/**
 * Growably (GoHighLevel) API helpers.
 *
 * LeadConnector is the API layer behind Growably. Every request needs the
 * Version header; without it the API returns 404 for everything.
 *
 * All helpers take the resolved runtime env (see config.js) so GHL_API_KEY
 * comes from encrypted KV first and the wrangler secret second.
 */

export const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function authHeaders(env, extra = {}) {
  return { Authorization: `Bearer ${env.GHL_API_KEY}`, Version: VERSION, ...extra };
}

async function fail(verb, path, res) {
  const text = await res.text().catch(() => '');
  throw new Error(`Growably ${verb} ${path} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
}

export async function ghlGet(path, env) {
  const res = await fetch(`${GHL_BASE}${path}`, { headers: authHeaders(env) });
  if (!res.ok) await fail('GET', path, res);
  return res.json();
}

export async function ghlPost(path, body, env) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail('POST', path, res);
  return res.json();
}

export async function ghlPut(path, body, env) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method: 'PUT',
    headers: authHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail('PUT', path, res);
  return res.json();
}

export async function getContactById(id, env) {
  const data = await ghlGet(`/contacts/${id}`, env);
  return data?.contact ?? null;
}

/**
 * Check that a token and location ID work together. Tries the location
 * endpoint first (needs the locations.readonly scope) and falls back to a
 * one-contact list (needs contacts.readonly), so a token missing the first
 * scope still gets a useful answer.
 *
 * Returns { ok: true, locationName } or { ok: false, error }.
 */
export async function testConnection(env) {
  if (!env.GHL_API_KEY)     return { ok: false, error: 'No Growably token set' };
  if (!env.GHL_LOCATION_ID) return { ok: false, error: 'No location ID set' };
  try {
    const data = await ghlGet(`/locations/${env.GHL_LOCATION_ID}`, env);
    return { ok: true, locationName: data?.location?.name ?? null };
  } catch (e) {
    try {
      await ghlGet(`/contacts/?locationId=${env.GHL_LOCATION_ID}&limit=1`, env);
      return { ok: true, locationName: null, note: 'Token works for contacts. Add the locations.readonly scope to see the location name.' };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}
