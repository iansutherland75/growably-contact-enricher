/**
 * Per-install branding and the brief profile. Both are plain JSON in KV
 * (no secrets), editable by administrators under Settings.
 */

const BRANDING_KEY = 'config:branding';
const PROFILE_KEY  = 'config:briefProfile';

export const DEFAULT_BRANDING = {
  appName: 'Lead Enrichment',
  logoDataUrl: '',
  brandColor: '#005488',
};

export const DEFAULT_PROFILE = {
  repName: '',
  companyName: '',
  companyDescription: '',
  region: '',
  differentiators: '',
  timezone: '',
};

// Logos are stored inline as data URLs. 300 KB of base64 is plenty for a
// sidebar logo and keeps the KV value well under its limit.
const LOGO_MAX_CHARS = 300 * 1024;
const LOGO_TYPES = /^data:image\/(png|jpeg|webp|svg\+xml|gif);base64,/;

export async function getBranding(env) {
  const stored = await env.ENRICH_KV.get(BRANDING_KEY, 'json').catch(() => null);
  return { ...DEFAULT_BRANDING, ...(stored ?? {}) };
}

/** Validate and save branding. Returns the saved object or throws with a readable message. */
export async function setBranding(env, patch) {
  const current = await getBranding(env);
  const next = { ...current };

  if ('appName' in patch) {
    const v = String(patch.appName ?? '').trim().slice(0, 60);
    next.appName = v || DEFAULT_BRANDING.appName;
  }
  if ('brandColor' in patch) {
    const v = String(patch.brandColor ?? '').trim();
    if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error('Brand colour must be a six-digit hex value like #005488.');
    next.brandColor = v || DEFAULT_BRANDING.brandColor;
  }
  if ('logoDataUrl' in patch) {
    const v = String(patch.logoDataUrl ?? '');
    if (v && !LOGO_TYPES.test(v)) throw new Error('Logo must be a PNG, JPEG, WebP, GIF or SVG image.');
    if (v.length > LOGO_MAX_CHARS) throw new Error('Logo is too large. Keep it under 300 KB.');
    next.logoDataUrl = v;
  }

  await env.ENRICH_KV.put(BRANDING_KEY, JSON.stringify(next));
  return next;
}

export async function getBriefProfile(env) {
  const stored = await env.ENRICH_KV.get(PROFILE_KEY, 'json').catch(() => null);
  return { ...DEFAULT_PROFILE, ...(stored ?? {}) };
}

export async function setBriefProfile(env, patch) {
  const current = await getBriefProfile(env);
  const next = { ...current };
  for (const k of Object.keys(DEFAULT_PROFILE)) {
    if (k in patch) next[k] = String(patch[k] ?? '').trim().slice(0, k === 'differentiators' ? 2000 : 200);
  }
  if (next.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); }
    catch { throw new Error(`Unknown timezone "${next.timezone}". Use an IANA name like America/Toronto.`); }
  }
  await env.ENRICH_KV.put(PROFILE_KEY, JSON.stringify(next));
  return next;
}
