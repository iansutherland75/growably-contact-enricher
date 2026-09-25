/**
 * Growably Contact Enricher - Cloudflare Worker entry point.
 *
 * One worker serves the frontend (static assets from ./frontend) and the API
 * under /api/*. Cloudflare Access sits in front of the hostname; the worker
 * also verifies the Access JWT on every API request (src/access.js), so a
 * misconfigured Access app fails closed instead of open.
 *
 * Modules:
 *   config.js    runtime config: encrypted KV secrets with wrangler fallbacks
 *   crypto.js    AES-GCM for stored keys, derived webhook token
 *   fields.js    Growably custom field discovery and creation
 *   enrich.js    the enrichment pipeline
 *   brief.js     the AI pre-meeting brief
 *   ai.js        Anthropic / OpenAI provider switch
 *   branding.js  per-install branding and brief profile
 *   ghl.js       Growably API helpers
 *
 * Roles live in KV under user:{email} -> { role: "superuser" | "user" }.
 * The first person to sign in on a fresh install is shown the setup screen
 * and chooses the administrators (POST /api/setup). After that, only
 * administrators can change users, keys, fields, branding or the brief profile.
 */

import { Hono } from 'hono';
import { verifyAccessJwt, accessConfigured } from './access.js';
import { ghlGet, ghlPost, ghlPut, getContactById, testConnection } from './ghl.js';
import { runtimeEnv, writeSecrets, configStatus, rememberWorkerUrl, SECRET_FIELDS } from './config.js';
import { encryptionReady, secretMatches } from './crypto.js';
import { resolveFieldIds, fieldStatus, createMissingFields, missingFieldNames } from './fields.js';
import { enrichContact, braveSearch } from './enrich.js';
import { generateBrief } from './brief.js';
import { PROVIDERS, aiConfigured, modelFor, testProvider } from './ai.js';
import { getBranding, setBranding, getBriefProfile, setBriefProfile } from './branding.js';

const app = new Hono();

// ─── Users and roles ──────────────────────────────────────────────────────────

const USER_PREFIX   = 'user:';
const HAS_ADMIN_KEY = 'meta:hasAdmin';
const EMAIL_RE      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getUserRecord(env, email) {
  return env.ENRICH_KV.get(`${USER_PREFIX}${email}`, 'json');
}

async function listUsers(env) {
  const list = await env.ENRICH_KV.list({ prefix: USER_PREFIX });
  const users = await Promise.all(list.keys.map(async ({ name }) => {
    const record = await env.ENRICH_KV.get(name, 'json');
    return { email: name.slice(USER_PREFIX.length), role: record?.role ?? 'user' };
  }));
  users.sort((a, b) => a.email.localeCompare(b.email));
  return users;
}

async function countSuperusers(env) {
  return (await listUsers(env)).filter(u => u.role === 'superuser').length;
}

/** True once at least one administrator exists. Cached in KV after the first check. */
async function hasAdmin(env) {
  if (await env.ENRICH_KV.get(HAS_ADMIN_KEY)) return true;
  const n = await countSuperusers(env);
  if (n > 0) await env.ENRICH_KV.put(HAS_ADMIN_KEY, '1');
  return n > 0;
}

async function setRole(env, email, role) {
  await env.ENRICH_KV.put(`${USER_PREFIX}${email}`, JSON.stringify({ role }));
  if (role === 'superuser') await env.ENRICH_KV.put(HAS_ADMIN_KEY, '1');
}

/**
 * Make sure the signed-in caller has a record. ADMIN_EMAILS (optional secret
 * or var) pre-seeds administrators; everyone else starts as a user.
 */
async function provisionCaller(env, email) {
  const existing = await getUserRecord(env, email);
  if (existing?.role) return existing.role;
  const admins = String(env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const role = admins.includes(email) ? 'superuser' : 'user';
  await setRole(env, email, role);
  return role;
}

/** Resolve the verified caller to a superuser. Returns their email, or null. */
async function requireSuperuser(c) {
  const email = c.get('authEmail');
  if (!email) return null;
  const record = await getUserRecord(c.env, email);
  return record?.role === 'superuser' ? email : null;
}

/** Administrators can configure. So can anyone, but only while no administrator exists yet. */
async function canConfigure(c) {
  if (await requireSuperuser(c)) return true;
  return !(await hasAdmin(c.env));
}

function forbidden(c) {
  return c.json({ error: 'Administrators only' }, 403);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
// Everything under /api/ needs a verified Access JWT, except the Apollo
// webhook, which Apollo calls server to server and which is gated by a token
// in its URL instead (Apollo cannot send custom headers).

app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();

  const renv = await runtimeEnv(c.env);
  c.set('renv', renv);

  if (c.req.path === '/api/apollo-webhook') {
    if (!(await secretMatches(c.req.query('t'), renv.APOLLO_WEBHOOK_SECRET))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  }

  if (c.env.DEV_AUTH_EMAIL) {
    // Local development only (.dev.vars). wrangler dev has no Access in front of it.
    c.set('authEmail', String(c.env.DEV_AUTH_EMAIL).toLowerCase());
    c.set('authName', c.env.DEV_AUTH_EMAIL);
  } else {
    if (!accessConfigured(c.env)) {
      // Setup step 3 not done yet. Let the UI show instructions instead of a bare 401.
      if (c.req.path === '/api/config') return c.json({ accessConfigured: false });
      return c.json({ error: 'unauthorized', reason: 'access_not_configured' }, 401);
    }
    const claims = await verifyAccessJwt(c.req.header('cf-access-jwt-assertion'), c.env);
    if (!claims?.email) return c.json({ error: 'unauthorized' }, 401);
    c.set('authEmail', claims.email.toLowerCase());
    c.set('authName', claims.name || claims.email);
  }

  await rememberWorkerUrl(c.env, new URL(c.req.url).origin);
  return next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ghlReady(renv) {
  return Boolean(renv.GHL_API_KEY && renv.GHL_LOCATION_ID);
}

function notConnected(c) {
  return c.json({ error: 'Growably is not connected yet. An administrator can finish this under Settings.' }, 409);
}

/** Overlay candidate values (from a form) onto the resolved env, for test calls. */
function overlay(renv, values) {
  const names = {
    ghlApiKey: 'GHL_API_KEY', ghlLocationId: 'GHL_LOCATION_ID',
    apolloApiKey: 'APOLLO_API_KEY', braveApiKey: 'BRAVE_API_KEY',
    aiProvider: 'AI_PROVIDER', aiApiKey: 'AI_API_KEY', aiModel: 'AI_MODEL',
  };
  const over = {};
  for (const [k, envName] of Object.entries(names)) {
    if (values?.[k] != null && String(values[k]).trim() !== '') over[envName] = String(values[k]).trim();
  }
  if (over.AI_PROVIDER) over.AI_PROVIDER = over.AI_PROVIDER.toLowerCase();
  return new Proxy(renv, { get: (t, p) => (Object.prototype.hasOwnProperty.call(over, p) ? over[p] : t[p]) });
}

async function testApollo(env) {
  if (!env.APOLLO_API_KEY) return { ok: false, error: 'No Apollo API key set' };
  try {
    const res = await fetch('https://api.apollo.io/api/v1/auth/health', { headers: { 'X-Api-Key': env.APOLLO_API_KEY } });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.is_logged_in) return { ok: true };
    return { ok: false, error: res.ok ? 'Apollo did not recognise this key' : `Apollo returned ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testBrave(env) {
  if (!env.BRAVE_API_KEY) return { ok: false, error: 'No Brave API key set' };
  try {
    await braveSearch('cloudflare workers', env, 1);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function publicProviders() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, {
    label: v.label, defaultModel: v.defaultModel, keyUrl: v.keyUrl,
  }]));
}

// ─── Config, setup, admin ─────────────────────────────────────────────────────

/**
 * GET /api/config
 * Everything the UI needs on load: who you are, branding, what is configured,
 * the field map, and whether first-run setup is still pending.
 */
app.get('/api/config', async (c) => {
  const env = c.env;
  const renv = c.get('renv');
  const email = c.get('authEmail');
  const role = await provisionCaller(env, email);

  const [branding, admin, status, fields] = await Promise.all([
    getBranding(env),
    hasAdmin(env),
    configStatus(env, renv),
    resolveFieldIds(renv).catch(() => ({})),
  ]);

  const out = {
    accessConfigured: true,
    user: { email, name: c.get('authName'), role },
    branding,
    setupRequired: !admin,
    encryptionReady: status.encryptionReady,
    integrations: { ghl: status.ghl, apollo: status.apollo, brave: status.brave, ai: status.ai },
    ai: { configured: aiConfigured(renv), provider: renv.AI_PROVIDER, model: modelFor(renv), providers: publicProviders() },
    fields,
  };
  if (role === 'superuser' || !admin) {
    out.fieldsMissing = status.ghl ? missingFieldNames(fields) : [];
  }
  return c.json(out);
});

/**
 * POST /api/setup
 * First-run only: choose administrators and store the API keys.
 * Body: { admins: [email], secrets: { ghlApiKey, ghlLocationId, apolloApiKey, braveApiKey, aiProvider, aiApiKey, aiModel }, branding?: { appName } }
 */
app.post('/api/setup', async (c) => {
  if (await hasAdmin(c.env)) return c.json({ error: 'Setup has already been completed.' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const admins = [...new Set((Array.isArray(body.admins) ? body.admins : [])
    .map(e => String(e).trim().toLowerCase())
    .filter(e => EMAIL_RE.test(e)))];
  if (!admins.length) return c.json({ error: 'Enter at least one administrator email address.' }, 400);

  const secrets = body.secrets && typeof body.secrets === 'object' ? body.secrets : {};
  const hasSecrets = SECRET_FIELDS.some(k => secrets[k] != null && String(secrets[k]).trim() !== '');
  if (hasSecrets) {
    if (!encryptionReady(c.env)) {
      return c.json({ error: 'The CONFIG_KEY secret is not set, so keys cannot be stored yet. See the note above the form.' }, 400);
    }
    if (secrets.aiProvider && !PROVIDERS[String(secrets.aiProvider).toLowerCase()]) {
      return c.json({ error: 'AI provider must be "anthropic" or "openai".' }, 400);
    }
    await writeSecrets(c.env, secrets);
  }

  if (body.branding && typeof body.branding === 'object') {
    try { await setBranding(c.env, body.branding); } catch { /* branding is optional at setup */ }
  }

  const caller = c.get('authEmail');
  for (const email of admins) await setRole(c.env, email, 'superuser');
  if (!admins.includes(caller)) await provisionCaller(c.env, caller);

  return c.json({ ok: true, admins, youAreAdmin: admins.includes(caller) });
});

/**
 * POST /api/admin/test
 * Try a key before saving it. Body: { service: "ghl" | "apollo" | "brave" | "ai", values: {...} }
 * Allowed for administrators, and for anyone during first-run setup.
 */
app.post('/api/admin/test', async (c) => {
  if (!(await canConfigure(c))) return forbidden(c);
  const { service, values } = await c.req.json().catch(() => ({}));
  const env = overlay(c.get('renv'), values ?? {});
  switch (service) {
    case 'ghl':    return c.json(await testConnection(env));
    case 'apollo': return c.json(await testApollo(env));
    case 'brave':  return c.json(await testBrave(env));
    case 'ai':     return c.json(await testProvider(env));
    default:       return c.json({ ok: false, error: 'Unknown service' }, 400);
  }
});

/** GET /api/admin/integrations: what is configured, masked. Administrators only. */
app.get('/api/admin/integrations', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const status = await configStatus(c.env, c.get('renv'));
  return c.json({ ...status, providers: publicProviders() });
});

/** PUT /api/admin/integrations: store or replace keys. Body is a partial of SECRET_FIELDS. */
app.put('/api/admin/integrations', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const patch = await c.req.json().catch(() => ({}));
  if (patch.aiProvider && !PROVIDERS[String(patch.aiProvider).toLowerCase()]) {
    return c.json({ error: 'AI provider must be "anthropic" or "openai".' }, 400);
  }
  try {
    await writeSecrets(c.env, patch);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  const renv = await runtimeEnv(c.env);
  const status = await configStatus(c.env, renv);
  return c.json({ ...status, providers: publicProviders() });
});

/** GET /api/fields: the { key: id } map for the frontend. */
app.get('/api/fields', async (c) => {
  const fields = await resolveFieldIds(c.get('renv')).catch(() => ({}));
  return c.json({ fields });
});

/** GET /api/admin/fields: per-field status, re-read from Growably. */
app.get('/api/admin/fields', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    return c.json({ fields: await fieldStatus(renv) });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** POST /api/admin/fields/create: create every missing custom field in Growably. */
app.post('/api/admin/fields/create', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    const result = await createMissingFields(renv);
    return c.json({ ...result, fields: await fieldStatus(renv) });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** PUT /api/admin/branding: app name, logo, brand colour. */
app.put('/api/admin/branding', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const patch = await c.req.json().catch(() => ({}));
  try {
    return c.json({ branding: await setBranding(c.env, patch) });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

/** GET and PUT /api/admin/brief-profile: who the brief is written for. */
app.get('/api/admin/brief-profile', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  return c.json({ profile: await getBriefProfile(c.env) });
});

app.put('/api/admin/brief-profile', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const patch = await c.req.json().catch(() => ({}));
  try {
    return c.json({ profile: await setBriefProfile(c.env, patch) });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// ─── User management ──────────────────────────────────────────────────────────

/** GET /api/auth/users: all provisioned users. Administrators only. */
app.get('/api/auth/users', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  return c.json({ users: await listUsers(c.env) });
});

/**
 * POST /api/auth/users: add a user or change a role. Administrators only.
 * You cannot change your own role, and the last administrator cannot be demoted.
 */
app.post('/api/auth/users', async (c) => {
  const requester = await requireSuperuser(c);
  if (!requester) return forbidden(c);

  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const role  = body.role;
  if (!EMAIL_RE.test(email) || !['superuser', 'user'].includes(role)) {
    return c.json({ error: 'A valid email and a role (superuser or user) are required' }, 400);
  }
  if (email === requester) return c.json({ error: 'Ask another administrator to change your role.' }, 400);

  if (role === 'user') {
    const current = await getUserRecord(c.env, email);
    if (current?.role === 'superuser' && (await countSuperusers(c.env)) <= 1) {
      return c.json({ error: 'At least one administrator is required.' }, 400);
    }
  }
  await setRole(c.env, email, role);
  return c.json({ email, role });
});

/** DELETE /api/auth/users/:email: remove a user. Not yourself, not the last administrator. */
app.delete('/api/auth/users/:email', async (c) => {
  const requester = await requireSuperuser(c);
  if (!requester) return forbidden(c);

  const target = decodeURIComponent(c.req.param('email')).toLowerCase();
  if (target === requester) return c.json({ error: 'You cannot remove your own account.' }, 400);
  const current = await getUserRecord(c.env, target);
  if (current?.role === 'superuser' && (await countSuperusers(c.env)) <= 1) {
    return c.json({ error: 'At least one administrator is required.' }, 400);
  }
  await c.env.ENRICH_KV.delete(`${USER_PREFIX}${target}`);
  return c.json({ deleted: target });
});

// ─── Contacts and enrichment ──────────────────────────────────────────────────

/** Search Growably contacts by name or email. */
app.get('/api/search', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  const query = c.req.query('q');
  if (!query) return c.json({ error: 'Missing q param' }, 400);
  try {
    const data = await ghlGet(`/contacts/?locationId=${renv.GHL_LOCATION_ID}&query=${encodeURIComponent(query)}&limit=10`, renv);
    return c.json({ contacts: data?.contacts ?? [] });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Fetch one contact by ID, used to refresh the panel after enrichment. */
app.get('/api/contact/:id', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    const contact = await getContactById(c.req.param('id'), renv);
    if (!contact) return c.json({ error: 'Not found' }, 404);
    return c.json({ contact });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Enrich a single contact on demand. */
app.post('/api/enrich/:id', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    const contact = await getContactById(c.req.param('id'), renv);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);
    const result = await enrichContact(contact, renv);
    return c.json({ success: true, result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/**
 * Apply one or more field overwrites the enrichment surfaced as `suggested`.
 * Body: { fields: { companyName?, website?, address1?, city?, state?, country?, postalCode?, companyPhone? } }
 */
app.post('/api/contact/:id/apply', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    const body  = await c.req.json().catch(() => ({}));
    const input = body.fields ?? (body.field ? { [body.field]: body.value } : null);
    if (!input || !Object.keys(input).length) return c.json({ error: 'Missing fields' }, 400);

    const STANDARD = new Set(['companyName', 'website', 'address1', 'city', 'state', 'country', 'postalCode']);
    const payload  = {};
    for (const [k, v] of Object.entries(input)) {
      if (v == null) continue;
      if (k === 'companyPhone') payload.phone = String(v);
      else if (STANDARD.has(k)) payload[k] = String(v);
      else return c.json({ error: `Unknown field: ${k}` }, 400);
    }
    if (!Object.keys(payload).length) return c.json({ error: 'No valid fields' }, 400);

    await ghlPut(`/contacts/${c.req.param('id')}`, payload, renv);
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Create a contact from an email address, then enrich it. 409 if it already exists. */
app.post('/api/add-contact', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    const { email } = await c.req.json().catch(() => ({}));
    if (!email?.trim()) return c.json({ error: 'Missing email' }, 400);
    const normalised = email.trim().toLowerCase();

    const search = await ghlGet(`/contacts/?locationId=${renv.GHL_LOCATION_ID}&query=${encodeURIComponent(normalised)}&limit=5`, renv);
    const duplicate = (search?.contacts ?? []).find(ct => ct.email?.toLowerCase() === normalised);
    if (duplicate) return c.json({ duplicate: true, contact: duplicate }, 409);

    const created = await ghlPost('/contacts/', { locationId: renv.GHL_LOCATION_ID, email: normalised }, renv);
    const contact = created?.contact;
    if (!contact?.id) return c.json({ error: 'Growably did not return a contact ID' }, 500);

    const result = await enrichContact(contact, renv);
    return c.json({ success: true, contact, result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Add the "nurture" tag to a contact. */
app.post('/api/nurture/:id', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  try {
    await ghlPost(`/contacts/${c.req.param('id')}/tags`, { tags: ['nurture'] }, renv);
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Generate and save a pre-meeting brief. Body: { meetingDate, meetingStage, focusNotes } */
app.post('/api/brief/:id', async (c) => {
  const renv = c.get('renv');
  if (!ghlReady(renv)) return notConnected(c);
  if (!aiConfigured(renv)) return c.json({ error: 'No AI provider is configured. An administrator can add one under Settings.' }, 409);
  try {
    const contact = await getContactById(c.req.param('id'), renv);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);
    const body   = await c.req.json().catch(() => ({}));
    const result = await generateBrief(contact, body, renv);
    return c.json({ success: true, result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/**
 * Apollo phone webhook. Apollo POSTs here after reveal_phone_number completes,
 * seconds to minutes after enrichment. Always answers 200 so Apollo does not retry.
 */
app.post('/api/apollo-webhook', async (c) => {
  const renv = c.get('renv');
  try {
    const body = await c.req.json().catch(() => null);
    if (!body) { console.log('[apollo-webhook] empty or unparseable body'); return c.json({ ok: true }); }

    // Apollo's webhook payload uses people[0]; the direct match API uses person
    const person = body?.person ?? body?.people?.[0];
    if (!person) { console.log('[apollo-webhook] no person in payload'); return c.json({ ok: true }); }

    // The webhook payload omits the email; look it up from the mapping written during enrichment
    let email = person.email ?? person.contact?.email ?? person.primary_email;
    if (!email && person.id) email = await c.env.ENRICH_KV.get(`apollo:${person.id}`);
    if (!email) { console.log('[apollo-webhook] no email on person'); return c.json({ ok: true }); }

    const phones = person.phone_numbers ?? [];
    // Apollo uses type_cd in webhook payloads, type in direct API responses
    const phoneType = p => p.type_cd ?? p.type ?? '';
    const best = phones.find(p => phoneType(p) === 'mobile')
              ?? phones.find(p => phoneType(p) === 'direct_phone')
              ?? phones[0];
    if (!best?.sanitized_number) { console.log(`[apollo-webhook] ${email}: no usable number`); return c.json({ ok: true }); }

    const fieldIds = await resolveFieldIds(renv);
    if (!fieldIds.mobileNumber) { console.log('[apollo-webhook] Mobile Number field not set up'); return c.json({ ok: true }); }

    const data = await ghlGet(`/contacts/?locationId=${renv.GHL_LOCATION_ID}&query=${encodeURIComponent(email)}&limit=5`, renv);
    const contact = (data?.contacts ?? []).find(ct => ct.email?.toLowerCase() === email.toLowerCase());
    if (!contact) { console.log(`[apollo-webhook] ${email}: no matching contact`); return c.json({ ok: true }); }

    await ghlPut(`/contacts/${contact.id}`, {
      customFields: [{ id: fieldIds.mobileNumber, value: best.sanitized_number }],
    }, renv);
    console.log(`[apollo-webhook] ${email}: wrote ${phoneType(best)} number to contact ${contact.id}`);
    return c.json({ ok: true });
  } catch (e) {
    console.error('[apollo-webhook] error:', e.message);
    return c.json({ ok: true });
  }
});

// ─── Bulk enrichment ──────────────────────────────────────────────────────────

/**
 * Validate the optional bulk filter. Returns a normalized filter, null for
 * "all contacts", or an Error.
 */
function parseBulkFilter(body) {
  const f = body?.filter;
  if (!f) return null;
  if (f.type === 'since') {
    const d = new Date(f.since);
    if (isNaN(d.getTime())) return new Error('Invalid date for "created since" filter');
    return { type: 'since', since: d.toISOString() };
  }
  if (f.type === 'tag') {
    const tag = String(f.tag ?? '').trim().toLowerCase(); // Growably stores tags lowercased
    if (!tag) return new Error('Tag filter requires a tag name');
    return { type: 'tag', tag };
  }
  return new Error(`Unknown filter type: ${f.type}`);
}

/** Start (or resume) a bulk job. Administrators only. Body: { filter?, restart? } */
app.post('/api/bulk/start', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  if (!ghlReady(c.get('renv'))) return notConnected(c);

  const existing = await c.env.ENRICH_KV.get('bulk_job', 'json');
  if (existing?.status === 'running') return c.json({ message: 'Bulk job already running', job: existing });

  const body = await c.req.json().catch(() => ({}));
  if (existing?.status === 'paused' && !body.restart) {
    existing.status = 'running';
    await c.env.ENRICH_KV.put('bulk_job', JSON.stringify(existing));
    return c.json({ message: 'Bulk enrichment resumed', job: existing });
  }

  const filter = parseBulkFilter(body);
  if (filter instanceof Error) return c.json({ error: filter.message }, 400);

  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    processed: 0, succeeded: 0, failed: 0, total: 0,
    lastContactId: null, lastStartAfter: null,
    filter,
    searchPage: 1,
  };
  await c.env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
  return c.json({ message: 'Bulk enrichment started', job });
});

app.post('/api/bulk/pause', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const job = await c.env.ENRICH_KV.get('bulk_job', 'json');
  if (!job) return c.json({ error: 'No job found' }, 404);
  job.status = 'paused';
  await c.env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
  return c.json({ message: 'Bulk enrichment paused', job });
});

app.get('/api/bulk/status', async (c) => {
  const job = await c.env.ENRICH_KV.get('bulk_job', 'json');
  return c.json({ job: job ?? null });
});

/** Post-mortem for the last filtered job: each matched contact's enrich error and date. */
app.get('/api/bulk/errors', async (c) => {
  if (!(await requireSuperuser(c))) return forbidden(c);
  const renv = c.get('renv');
  const job = await c.env.ENRICH_KV.get('bulk_job', 'json');
  if (!job?.filter) return c.json({ error: 'Last bulk job had no filter (or no job found)' }, 404);

  const fieldIds = await resolveFieldIds(renv);
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const data = await searchContactsPage(job.filter, page, 50, renv);
    const hits = data?.contacts ?? [];
    for (const h of hits) {
      const full = await getContactById(h.id, renv).catch(() => null);
      if (!full) { out.push({ id: h.id, fetchFailed: true }); continue; }
      const cf = (id) => (id ? full.customFields?.find(f => f.id === id)?.value ?? null : null);
      out.push({
        id: full.id,
        email: full.email ?? null,
        name: `${full.firstName ?? ''} ${full.lastName ?? ''}`.trim(),
        enrichError: cf(fieldIds.enrichError),
        enrichDate: cf(fieldIds.enrichDate),
      });
    }
    if (hits.length < 50) break;
  }
  return c.json({ filter: job.filter, count: out.length, contacts: out });
});

/**
 * One page of contacts matching a filter, via Growably's search endpoint
 * (the plain list endpoint cannot filter). Sorted by dateAdded ascending so
 * page-based pagination stays stable while the job runs.
 */
async function searchContactsPage(filter, page, limit, env) {
  const filters = [];
  if (filter.type === 'since') filters.push({ field: 'dateAdded', operator: 'range', value: { gte: filter.since } });
  else if (filter.type === 'tag') filters.push({ field: 'tags', operator: 'eq', value: filter.tag });
  return ghlPost('/contacts/search', {
    locationId: env.GHL_LOCATION_ID,
    page,
    pageLimit: limit,
    filters,
    sort: [{ field: 'dateAdded', direction: 'asc' }],
  }, env);
}

/**
 * Cron handler: one batch per invocation. 10 contacts with a 1.5 s pause
 * between them keeps Growably's rate limits happy. Needs the Workers Paid
 * plan: each enrichment makes 10 to 20 subrequests and the Free plan caps an
 * invocation at 50.
 */
async function runBulkBatch(rawEnv) {
  const env = await runtimeEnv(rawEnv);
  const job = await env.ENRICH_KV.get('bulk_job', 'json');
  if (!job || job.status !== 'running') return;
  if (!ghlReady(env)) {
    job.status = 'error'; job.error = 'Growably is not connected';
    await env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
    return;
  }

  const BATCH_SIZE = 10;
  const DELAY_MS   = 1500;
  const fieldIds   = await resolveFieldIds(env);

  try {
    let contacts, meta = {}, hasMore;

    if (job.filter) {
      const data = await searchContactsPage(job.filter, job.searchPage ?? 1, BATCH_SIZE, env);
      // Search results use a different shape; re-fetch each hit so enrichContact sees a standard contact
      const hits = data?.contacts ?? [];
      contacts = (await Promise.all(hits.map(h => getContactById(h.id, env).catch(() => null)))).filter(Boolean);
      if (job.total === 0 && data?.total) job.total = data.total;
      hasMore = hits.length === BATCH_SIZE;
      job.searchPage = (job.searchPage ?? 1) + 1;
    } else {
      const params = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, limit: String(BATCH_SIZE) });
      if (job.lastStartAfter) params.set('startAfter', job.lastStartAfter);
      if (job.lastContactId)  params.set('startAfterId', job.lastContactId);
      const data = await ghlGet(`/contacts/?${params}`, env);
      contacts = data?.contacts ?? [];
      meta     = data?.meta ?? {};
      if (job.total === 0 && meta.total) job.total = meta.total;
      hasMore = Boolean(meta.nextPage);
    }

    if (contacts.length === 0 && !hasMore) {
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      await env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
      return;
    }

    for (const contact of contacts) {
      try {
        await enrichContact(contact, env);
        job.succeeded++;
      } catch (e) {
        job.failed++;
        if (fieldIds.enrichError) {
          await ghlPut(`/contacts/${contact.id}`, {
            customFields: [{ id: fieldIds.enrichError, value: e.message }],
          }, env).catch(() => {});
        }
      }
      job.processed++;
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (meta.startAfter)   job.lastStartAfter = meta.startAfter;
    if (meta.startAfterId) job.lastContactId  = meta.startAfterId;
    if (!hasMore) {
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
    }
    await env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
  } catch (e) {
    job.status = 'error';
    job.error  = e.message;
    await env.ENRICH_KV.put('bulk_job', JSON.stringify(job));
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBulkBatch(env));
  },
};
