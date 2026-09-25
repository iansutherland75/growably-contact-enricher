/**
 * Runtime configuration.
 *
 * Values entered in the app (first-run setup or Settings) live in KV as one
 * encrypted JSON blob under `config:secrets`. Wrangler vars and secrets act as
 * fallbacks, so an install can use either. The resolved result is exposed
 * through runtimeEnv(), a Proxy over the Workers env whose property names
 * match the old wrangler names (GHL_API_KEY, APOLLO_API_KEY, ...). Code that
 * reads `env.GHL_API_KEY` keeps working and never knows where the value came from.
 */

import { encryptString, decryptString, deriveToken, encryptionReady } from './crypto.js';

const SECRETS_KEY   = 'config:secrets';
const WORKER_URL_KEY = 'config:workerUrl';
const CACHE_MS = 15000;

/** Fields the setup screen and Settings can store. Anything else in a patch is ignored. */
export const SECRET_FIELDS = [
  'ghlApiKey', 'ghlLocationId',
  'apolloApiKey', 'braveApiKey',
  'aiProvider', 'aiApiKey', 'aiModel',
];

let secretsCache = { at: 0, value: null };
let workerUrlMemo = null;

function placeholder(v) {
  return typeof v === 'string' && v.startsWith('REPLACE_WITH');
}

function envValue(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() && !placeholder(v) ? v.trim() : '';
}

/** Read and decrypt the stored secrets. Returns {} when nothing is stored or CONFIG_KEY is missing. */
export async function readSecrets(env) {
  if (Date.now() - secretsCache.at < CACHE_MS && secretsCache.value) return secretsCache.value;
  const blob = await env.ENRICH_KV.get(SECRETS_KEY);
  let value = {};
  if (blob) {
    const plain = await decryptString(blob, env);
    if (plain) {
      try { value = JSON.parse(plain); } catch { value = {}; }
    }
  }
  secretsCache = { at: Date.now(), value };
  return value;
}

/**
 * Merge a patch into the stored secrets and write them back encrypted.
 * Empty strings remove a value. Unknown keys are dropped.
 */
export async function writeSecrets(env, patch) {
  if (!encryptionReady(env)) throw new Error('CONFIG_KEY secret is not set. See SETUP.md.');
  const current = await readSecrets(env);
  const next = { ...current };
  for (const k of SECRET_FIELDS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v == null || String(v).trim() === '') delete next[k];
    else next[k] = String(v).trim();
  }
  await env.ENRICH_KV.put(SECRETS_KEY, await encryptString(JSON.stringify(next), env));
  secretsCache = { at: 0, value: null };
  return next;
}

/** Last four characters behind bullets, or null when unset. */
export function maskValue(v) {
  if (!v) return null;
  const s = String(v);
  return '••••••••' + s.slice(-4);
}

/**
 * Remember this worker's public origin so the Apollo webhook URL can be built
 * from cron, where there is no request to read it from.
 */
export async function rememberWorkerUrl(env, origin) {
  if (!origin || envValue(env, 'WORKER_URL')) return;
  if (workerUrlMemo === origin) return;
  workerUrlMemo = origin;
  await env.ENRICH_KV.put(WORKER_URL_KEY, origin).catch(() => {});
}

/**
 * Build the resolved env. Stored values win over wrangler vars and secrets.
 * Returns a Proxy so bindings like ENRICH_KV still come from the real env.
 */
export async function runtimeEnv(env) {
  const s = await readSecrets(env);
  const workerUrl = envValue(env, 'WORKER_URL')
    || workerUrlMemo
    || (await env.ENRICH_KV.get(WORKER_URL_KEY)) || '';
  if (workerUrl && !workerUrlMemo) workerUrlMemo = workerUrl;

  const webhookSecret = envValue(env, 'APOLLO_WEBHOOK_SECRET') || (await deriveToken('apollo-webhook', env));

  const resolved = {
    GHL_API_KEY:           s.ghlApiKey     || envValue(env, 'GHL_API_KEY'),
    GHL_LOCATION_ID:       s.ghlLocationId || envValue(env, 'GHL_LOCATION_ID'),
    APOLLO_API_KEY:        s.apolloApiKey  || envValue(env, 'APOLLO_API_KEY'),
    BRAVE_API_KEY:         s.braveApiKey   || envValue(env, 'BRAVE_API_KEY'),
    AI_PROVIDER:           (s.aiProvider   || envValue(env, 'AI_PROVIDER') || 'anthropic').toLowerCase(),
    AI_API_KEY:            s.aiApiKey      || envValue(env, 'AI_API_KEY'),
    AI_MODEL:              s.aiModel       || envValue(env, 'AI_MODEL'),
    WORKER_URL:            workerUrl,
    APOLLO_WEBHOOK_SECRET: webhookSecret,
  };

  return new Proxy(env, {
    get(target, prop) {
      return Object.prototype.hasOwnProperty.call(resolved, prop) ? resolved[prop] : target[prop];
    },
  });
}

/** What is and is not configured, for the UI. Never includes the values themselves. */
export async function configStatus(env, renv) {
  const s = await readSecrets(env);
  return {
    encryptionReady: encryptionReady(env),
    ghl:    Boolean(renv.GHL_API_KEY && renv.GHL_LOCATION_ID),
    apollo: Boolean(renv.APOLLO_API_KEY),
    brave:  Boolean(renv.BRAVE_API_KEY),
    ai:     Boolean(renv.AI_API_KEY),
    aiProvider: renv.AI_PROVIDER,
    aiModel: renv.AI_MODEL || null,
    masked: {
      ghlApiKey:     maskValue(renv.GHL_API_KEY),
      ghlLocationId: renv.GHL_LOCATION_ID || null,
      apolloApiKey:  maskValue(renv.APOLLO_API_KEY),
      braveApiKey:   maskValue(renv.BRAVE_API_KEY),
      aiApiKey:      maskValue(renv.AI_API_KEY),
    },
    // True when a value came from the app rather than wrangler, so the UI can
    // say which ones Settings can change.
    stored: Object.fromEntries(SECRET_FIELDS.map(k => [k, Boolean(s[k])])),
  };
}
