/**
 * Growably custom fields.
 *
 * Every Growably sub-account assigns its own opaque IDs to custom fields, so
 * the IDs cannot ship in code. This module finds them by name (or by a known
 * field key) through the API, caches the result in KV, and can create the
 * missing ones with one call from the Settings screen.
 *
 * Adding a field: add a row to FIELD_DEFS. The worker writes to it by `key`,
 * the frontend reads it by `key` through GET /api/fields.
 */

import { ghlGet, ghlPost } from './ghl.js';

export const FIELD_DEFS = [
  { key: 'linkedinUrl',   name: 'LinkedIn URL',   dataType: 'TEXT',       placeholder: 'https://linkedin.com/in/...',
    aliases: ['contact.linkedin_url', 'contact.linkedin_profile', 'contact.socials__linkedin_profile'] },
  { key: 'twitter',       name: 'Twitter URL',    dataType: 'TEXT',       placeholder: 'https://x.com/...',
    aliases: ['contact.twitter_url', 'contact.socials__twitter_profile'] },
  { key: 'jobTitle',      name: 'Job Title',      dataType: 'TEXT',       placeholder: 'CEO, Office Manager, ...',
    aliases: ['contact.job_title'] },
  { key: 'companyDomain', name: 'Company Domain', dataType: 'TEXT',       placeholder: 'example.com',
    aliases: ['contact.company_domain'] },
  { key: 'mobileNumber',  name: 'Mobile Number',  dataType: 'PHONE',      placeholder: '',
    aliases: ['contact.mobile_number', 'contact.mobile__cell_number'] },
  { key: 'employeeCount', name: 'Employee Count', dataType: 'NUMERICAL',  placeholder: '',
    aliases: ['contact.employee_count'] },
  { key: 'enrichDate',    name: 'Enrich Date',    dataType: 'TEXT',       placeholder: '2026-01-15T10:00:00.000Z',
    aliases: ['contact.enrich_date'] },
  { key: 'enrichError',   name: 'Enrich Error',   dataType: 'LARGE_TEXT', placeholder: '',
    aliases: ['contact.enrich_error'] },
];

const KV_KEY = 'config:fieldIds';
let memo = { at: 0, map: null };
const MEMO_MS = 60000;

/** Fetch the location's contact custom fields from Growably. */
export async function fetchLocationFields(env) {
  const data = await ghlGet(`/locations/${env.GHL_LOCATION_ID}/customFields?model=contact`, env);
  return data?.customFields ?? [];
}

/** Match FIELD_DEFS against the fields that exist. Returns { map, missing }. */
function matchFields(existing) {
  const byKey  = new Map();
  const byName = new Map();
  for (const f of existing) {
    if (f.fieldKey) byKey.set(String(f.fieldKey).toLowerCase(), f.id);
    if (f.name)     byName.set(String(f.name).trim().toLowerCase(), f.id);
  }
  const map = {};
  const missing = [];
  for (const def of FIELD_DEFS) {
    const id = def.aliases.map(a => byKey.get(a.toLowerCase())).find(Boolean)
            ?? byName.get(def.name.toLowerCase());
    if (id) map[def.key] = id;
    else missing.push(def);
  }
  return { map, missing };
}

/**
 * Resolve field IDs. Uses the in-isolate memo, then KV, then the API.
 * Returns a { key: id } map. Missing fields are simply absent from the map,
 * and callers skip writes to them.
 */
export async function resolveFieldIds(env, { refresh = false } = {}) {
  if (!refresh && memo.map && Date.now() - memo.at < MEMO_MS) return memo.map;
  if (!refresh) {
    const cached = await env.ENRICH_KV.get(KV_KEY, 'json');
    if (cached?.map) {
      memo = { at: Date.now(), map: cached.map };
      return cached.map;
    }
  }
  if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) return {};
  const existing = await fetchLocationFields(env);
  const { map } = matchFields(existing);
  await env.ENRICH_KV.put(KV_KEY, JSON.stringify({ map, resolvedAt: new Date().toISOString() }));
  memo = { at: Date.now(), map };
  return map;
}

/** Per-field status for the Settings screen. Always re-reads from Growably. */
export async function fieldStatus(env) {
  const map = await resolveFieldIds(env, { refresh: true });
  return FIELD_DEFS.map(d => ({ key: d.key, name: d.name, dataType: d.dataType, id: map[d.key] ?? null }));
}

/**
 * Create every field that does not exist yet. Returns what was created and
 * what failed, plus the refreshed map.
 */
export async function createMissingFields(env) {
  const existing = await fetchLocationFields(env);
  const { missing } = matchFields(existing);
  const created = [];
  const failed  = [];
  for (const def of missing) {
    try {
      const body = { name: def.name, dataType: def.dataType, model: 'contact' };
      if (def.placeholder) body.placeholder = def.placeholder;
      const res = await ghlPost(`/locations/${env.GHL_LOCATION_ID}/customFields`, body, env);
      created.push({ key: def.key, name: def.name, id: res?.customField?.id ?? null });
    } catch (e) {
      failed.push({ key: def.key, name: def.name, error: e.message });
    }
  }
  const map = await resolveFieldIds(env, { refresh: true });
  return { created, failed, map };
}

/** Names of the fields missing from a map, for error messages. */
export function missingFieldNames(map) {
  return FIELD_DEFS.filter(d => !map[d.key]).map(d => d.name);
}
