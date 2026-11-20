/**
 * Enrichment pipeline.
 *
 * enrichContact() takes a Growably contact and a resolved runtime env (see
 * config.js), pulls data from Apollo.io, Brave Search and the company's own
 * website, and writes the result back to Growably. Nothing here calls an AI
 * model. Non-fatal step failures are collected and written to the
 * Enrich Error field so the operator can see what happened per contact.
 */

import { ghlPost, ghlPut } from './ghl.js';
import { resolveFieldIds } from './fields.js';

// Identify our scraper to web servers so it is not treated as a generic bot.
const BOT_UA = 'Mozilla/5.0 (compatible; GrowablyContactEnricher/1.0; +https://github.com/iansutherland75/growably-contact-enricher)';

// ─── Brave Search ─────────────────────────────────────────────────────────────
// Used as a general-purpose web research tool throughout enrichment and brief generation.
// count defaults to 5 - increase for broader coverage, lower for speed-critical paths.

export async function braveSearch(query, env, count = 5) {
  if (!env.BRAVE_API_KEY) throw new Error('Brave Search API key not set');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': env.BRAVE_API_KEY,
    },
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  return res.json();
}
// ─── HTML helpers ─────────────────────────────────────────────────────────────

/**
 * Strip <script> and <style> block contents from raw HTML before any text
 * extraction runs. This prevents:
 *   - JavaScript tracking IDs / analytics numbers being matched as phone numbers
 *   - CSS hex colour codes (e.g. #F6F6F6) being matched as Canadian postal codes
 *     (both follow the A1A1A1 pattern)
 * Called before extractPhone() and extractAddressFromText() in every scraping path.
 */
function stripNonContent(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Fetch a webpage as raw HTML text. Returns null on any failure so callers
 * can try fallback URLs without bubbling errors.
 * cf.timeout is a Cloudflare-specific fetch option that caps the subrequest.
 */
async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BOT_UA },
      redirect: 'follow',
      cf: { timeout: 8000 },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) return null;
    return res.text();
  } catch {
    return null;
  }
}

/**
 * Extract a phone number from raw HTML/text.
 * Matches North American 10-digit numbers in common formats: (604) 555-1234,
 * 604.555.1234, +16045551234, etc. Returns E.164 format (+1XXXXXXXXXX).
 * Returns null if no valid number found.
 */
function extractPhone(text) {
  // Strip HTML tags entirely so href/src URLs (e.g. asset filenames like
  // "astra-addon-69f913e8906383-86868999.css") can't be mistaken for phone
  // numbers. extractPhone is called on raw HTML in some paths; this makes it
  // safe regardless of input.
  const cleanText = String(text).replace(/<[^>]+>/g, ' ');
  const re = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  const matches = cleanText.match(re) ?? [];
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    let areaCode, e164;
    if (digits.length === 10) {
      areaCode = digits.slice(0, 3);
      e164 = `+1${digits}`;
    } else if (digits.length === 11 && digits[0] === '1') {
      areaCode = digits.slice(1, 4);
      e164 = `+${digits}`;
    } else {
      continue;
    }
    // NANP area codes never start with 0 or 1 - skip malformed matches
    if (areaCode[0] === '0' || areaCode[0] === '1') continue;
    return e164;
  }
  return null;
}

// Page titles that indicate the result is a generic/navigation page, not the company name
const GENERIC_TITLES = new Set([
  'contact us','contact','home','welcome','about us','about','services',
  'page not found','404','error','index','untitled','coming soon',
  'under construction','website','our website','default',
]);

/**
 * Strip navigation/SEO suffixes from a page title to get a clean company name.
 * Example: "Acme Family Dental | Home" → "Acme Family Dental"
 * Returns null if no non-generic segment is found.
 */
function cleanCompanyName(raw) {
  if (!raw) return null;
  const segments = raw.split(/\s*[-|–·—]\s*/);
  for (const seg of segments) {
    const clean = seg.trim().replace(/\s+/g, ' ');
    if (clean && !GENERIC_TITLES.has(clean.toLowerCase())) return clean;
  }
  return null;
}

/**
 * Extract structured company data from JSON-LD (Schema.org) blocks embedded in HTML.
 * Schema.org is the most reliable source on modern websites - it's machine-readable
 * and intended for search engines, so it's usually accurate.
 * Handles both top-level JSON-LD and @graph arrays.
 * `domain` is the contact's email domain, used to reject Schema.org URLs that
 * point at a staging host or CDN instead of the company's own site.
 */
export function parseSchemaOrg(html, domain) {
  const result = {};
  let telephone;
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1]); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data?.['@graph'] ?? [data]);
    // One odd block (null, a bare value, a non-string @type) is skipped, not fatal.
    for (const node of [nodes].flat()) {
      if (!node || typeof node !== 'object') continue;
      const type = String(node['@type'] ?? '');
      const isOrg = ['Organization','LocalBusiness','Corporation','MedicalBusiness',
                     'ProfessionalService','Store','Restaurant'].some(t => type.includes(t));
      if (!isOrg) continue;
      if (typeof node.name === 'string' && node.name.trim() && !result.companyName) result.companyName = node.name.trim();
      if (telephone === undefined && node.telephone != null) telephone = node.telephone;
      // Only use Schema.org url if it's on the same root domain - rejects staging/CDN redirects
      if (typeof node.url === 'string' && !result.website) {
        try {
          const urlHost = new URL(node.url).hostname.replace(/^www\./, '');
          const domainRoot = domain.replace(/^www\./, '');
          if (urlHost === domainRoot || urlHost.endsWith(`.${domainRoot}`)) result.website = node.url;
        } catch { /* ignore unparseable URLs */ }
      }
      const addr = node.address;
      if (addr && typeof addr === 'object') {
        if (addr.streetAddress && !result.address1) result.address1 = addr.streetAddress;
        if (addr.addressLocality && !result.city)   result.city    = addr.addressLocality;
        if (addr.addressRegion   && !result.state)  result.state   = addr.addressRegion;
        if (addr.postalCode      && !result.postalCode) result.postalCode = addr.postalCode;
        if (addr.addressCountry  && !result.country) {
          const c = addr.addressCountry;
          // An object with no name ({ "@type": "Country" }) gives no country, not "[object Object]".
          const country = normaliseCountry(typeof c === 'object' ? c?.name : c);
          if (country) result.country = country;
        }
      }
    }
  }
  // The phone is decided once, against the country from any node: an @graph often
  // puts the telephone and the address on different nodes.
  const phone = telephone === undefined ? null : schemaPhone(telephone, result.country);
  if (phone) result.phone = phone;
  return result;
}

// A country we know and that is not Canada or the US: its numbers are never +1.
const isForeign = (country) => !!country && !['CA', 'US'].includes(country);

// The whole value must have the North American shape: an optional 1 or +1, then
// 3-3-4 digits. A label in front ("Call", "tel:"), a note in brackets behind and an
// extension are allowed and dropped.
const NANP_SHAPE = /^(?:[A-Za-z]+:?\s*)?(?:\(?\+?1\)?[\s.-]*)?\(?([2-9]\d{2})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})(?:\s*,?\s*(?:x|ext\.?|extension|#)\s*\d{1,6})?(?:\s*\([^()\d]*\))?$/i;

/**
 * The first phone in a value (a list split on / , ; or "or") as E.164 when it has
 * the North American shape, else null. Unlike extractPhone it never reads a number
 * out of a longer one, so +442079460958 is not mistaken for +14420794609.
 */
export function northAmericanPhone(value) {
  // A real phone value is short; a long one is page junk, and the pattern slows
  // down badly on long runs of spaces.
  if (String(value).length > 60) return null;
  const first = String(value).split(/\s*(?:[\/,;]|\bor\b)\s*(?=[+(\d])/i)[0].trim();
  const m = first.match(NANP_SHAPE);
  return m ? `+1${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * A Schema.org telephone (a string, or a list of them) in the same +1 format as
 * phones found in the page text. A number outside North America, or any number
 * when the site's address names another country, stays as printed. A bare JSON
 * number that is not North American is dropped unless the country is known.
 */
function schemaPhone(telephone, country) {
  const raw = [telephone].flat().find((t) => (typeof t === 'string' && t.trim()) || typeof t === 'number');
  if (raw === undefined) return null;
  const plus1 = isForeign(country) ? null : northAmericanPhone(raw);
  if (plus1) return plus1;
  if (typeof raw === 'number') return isForeign(country) ? String(raw) : null;
  return raw.trim();
}

/**
 * Extract company name from Open Graph and <title> meta tags.
 * Fallback when Schema.org is absent. og:site_name is preferred over <title>
 * because it's specifically the brand name without navigation noise.
 */
function parseMetaTags(html) {
  const result = {};
  const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogSite) result.companyName = ogSite[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title && !result.companyName) result.companyName = cleanCompanyName(title[1]);
  return result;
}

// Postal code / zip patterns used to infer country and province/state from page text
const CA_POSTAL_RE = /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i;
const US_ZIP_RE    = /\b(\d{5}(?:-\d{4})?)\b/;
const CA_PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];

// Common street-type suffixes - used to stop city-name extraction from walking
// past a street name (e.g. "Gilmore Way Burnaby" → just "Burnaby").
const STREET_SUFFIX_RE = /^(Street|St|Ave|Avenue|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Crescent|Cres|Highway|Hwy)\.?$/i;

/**
 * Walk backwards from the end of `text` collecting capitalized words to form
 * a city name. Stops at digits (street number), commas, or street suffixes.
 * Caps at 3 words to keep "City of X" style strings sensible.
 */
function extractCityFromBeforeText(text) {
  const tokens = text.trim().split(/[,\s]+/).filter(Boolean);
  const words = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^\d/.test(t)) break;
    if (STREET_SUFFIX_RE.test(t)) break;
    if (!/^[A-Z][a-zA-Z]+$/.test(t) && !/^[A-Z][a-zA-Z]+-[A-Z][a-zA-Z]+$/.test(t)) break;
    words.unshift(t);
    if (words.length >= 3) break;
  }
  return words.length ? words.join(' ') : null;
}

/** Normalise a country name to its ISO 3166-1 alpha-2 code (GHL expects 2-letter codes). */
function normaliseCountry(input) {
  if (!input) return null;
  const v = String(input).trim();
  if (/^[A-Z]{2}$/i.test(v)) return v.toUpperCase();
  const map = {
    'canada': 'CA',
    'united states': 'US',
    'united states of america': 'US',
    'usa': 'US',
    'u.s.a.': 'US',
    'united kingdom': 'GB',
    'uk': 'GB',
    'australia': 'AU',
    'mexico': 'MX',
  };
  return map[v.toLowerCase()] ?? v;
}
const US_STATES    = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
                      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
                      'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
                      'TX','UT','VT','VA','WA','WV','WI','WY','DC'];

/**
 * Scan raw page text (with HTML tags stripped) for address signals.
 * Looks for Canadian postal codes, US zip codes, province/state abbreviations,
 * and street address patterns. Used to fill gaps left by Schema.org.
 */
function extractAddressFromText(html) {
  const result = {};
  const text = stripNonContent(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Canadian postal code - require a province abbreviation within 120 chars before
  // it. This rejects random 6-character A1A1A1 strings that happen to match the
  // pattern but aren't actually addresses.
  for (const m of text.matchAll(new RegExp(CA_POSTAL_RE.source, 'gi'))) {
    const postIdx = m.index;
    const before = text.slice(Math.max(0, postIdx - 120), postIdx);
    const prov = CA_PROVINCES.find(p => new RegExp(`\\b${p}\\b`).test(before));
    if (!prov) continue;

    result.postalCode = m[1].toUpperCase();
    result.country = 'CA';
    result.state = prov;
    const provIdx = before.search(new RegExp(`\\b${prov}\\b`));
    const beforeProv = before.slice(0, provIdx).replace(/[,\s]+$/, '');
    const city = extractCityFromBeforeText(beforeProv);
    if (city) result.city = city;
    break;
  }

  // US ZIP code - require a US state abbreviation within 120 chars before it.
  // Without this guard, random 5-digit numbers like ISO standard IDs or year
  // counts get mistaken for ZIP codes (e.g. "ISO 50001" → ZIP "50001").
  if (!result.postalCode) {
    for (const m of text.matchAll(new RegExp(US_ZIP_RE.source, 'g'))) {
      const zipIdx = m.index;
      const before = text.slice(Math.max(0, zipIdx - 120), zipIdx);
      const st = US_STATES.find(s => new RegExp(`\\b${s}\\b`).test(before));
      if (!st) continue;

      result.postalCode = m[1];
      result.country = 'US';
      result.state = st;
      const stIdx = before.search(new RegExp(`\\b${st}\\b`));
      const beforeSt = before.slice(0, stIdx).replace(/[,\s]+$/, '');
      const city = extractCityFromBeforeText(beforeSt);
      if (city) result.city = city;
      break;
    }
  }

  const streetRe = /\b(\d{1,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Crescent|Cres|Highway|Hwy)\.?)\b/;
  const street = text.match(streetRe);
  if (street) result.address1 = street[1];

  return result;
}

/**
 * Primary company enrichment source: scrape the company's own website.
 * Tries homepage, /contact, /contact-us, /about, and www. subdomain variants.
 * Stops early once the key fields (name, phone, address, postal code) are all found.
 * Falls back to Schema.org → meta tags → regex text scanning in priority order.
 */
async function enrichCompanyFromWebsite(domain) {
  const result = {};
  // Try contact pages first - they're authoritative for the company's address.
  // Falling back to homepage only after gives Schema.org markup or contact-page
  // text the chance to populate postalCode/country before we hit the marketing
  // homepage (which often references unrelated locations).
  const urls = [
    `https://${domain}/contact`,
    `https://${domain}/contact-us`,
    `https://${domain}/about`,
    `https://${domain}`,
    `https://www.${domain}`,
  ];

  for (const url of urls) {
    const html = await fetchPage(url);
    if (!html) continue;

    const schema = parseSchemaOrg(html, domain);
    for (const [k, v] of Object.entries(schema)) {
      if (v && !result[k]) result[k] = v;
    }

    if (!result.companyName) {
      const meta = parseMetaTags(html);
      if (meta.companyName) result.companyName = meta.companyName;
    }

    // Page text only yields +1 numbers, so it is skipped for a site in another country.
    if (!result.phone && !isForeign(result.country)) {
      const phone = extractPhone(stripNonContent(html));
      if (phone) result.phone = phone;
    }

    if (!result.postalCode || !result.address1) {
      const addrFromText = extractAddressFromText(html);
      for (const [k, v] of Object.entries(addrFromText)) {
        if (v && !result[k]) result[k] = v;
      }
    }

    if (result.companyName && result.phone && result.address1 && result.postalCode) break;
  }

  if (!result.website) result.website = `https://${domain}`;
  return result;
}

/**
 * Brave Search fallback for company data when website scraping comes up empty.
 * Searches for the company name and domain together to find contact pages,
 * directory listings, etc. that may contain phone numbers.
 */
async function enrichCompanyFromSearch(domain, companyName, env) {
  const result = {};
  const query = companyName
    ? `"${companyName}" address phone site:${domain} OR "${companyName}"`
    : `${domain} company address phone`;

  {
    // A Brave failure throws; the caller records it in the Enrich Error field.
    const r = await braveSearch(query, env, 5);
    for (const item of r?.web?.results ?? []) {
      // Phone extraction from Brave snippets is intentionally omitted - one-line
      // descriptions frequently contain tracking IDs or unrelated numbers that
      // look like phone numbers. Phone comes from the website scrape or Apollo only.
      if (!result.companyName && item.url?.includes(domain)) {
        result.companyName = cleanCompanyName(item.title);
      }
      if (result.companyName) break;
    }
  }

  return result;
}

// ─── Name normalization ───────────────────────────────────────────────────────

/**
 * Convert a name to Title Case, with special handling for:
 * - Mc prefixes: McDonald (no Mac rule: one for MacLeod also turns Macy into MacY)
 * - O' prefixes: O'Brien, O'Neill
 * - Hyphenated names: Smith-Jones
 */
function toTitleCase(str) {
  if (!str) return str;
  return str
    .trim()
    .split(/\s+/)
    .map(word => {
      if (!word) return word;
      if (word.match(/^mc[a-z]/i)) return 'Mc' + word[2].toUpperCase() + word.slice(3).toLowerCase();
      if (word.match(/^o'[a-z]/i)) return "O'" + word[2].toUpperCase() + word.slice(3).toLowerCase();
      if (word.includes('-')) {
        return word.split('-').map(p => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join('-');
      }
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * True for a name typed ALL CAPS or all lowercase that Title Case would change.
 * Mixed case is left alone: DeSouza, LeBlanc and Macy are already right.
 */
export function needsNormalization(str) {
  if (!str || !str.trim()) return false;
  if (str !== str.toUpperCase() && str !== str.toLowerCase()) return false;
  return toTitleCase(str) !== str;
}

// ─── Person-level extractors ──────────────────────────────────────────────────

/**
 * Find a LinkedIn profile URL in Brave search results.
 * Only accepts URLs matching linkedin.com/in/ (personal profiles, not company pages).
 *
 * lastName validation: if a last name is provided, the URL slug must contain it
 * (normalized to lowercase alphanumeric). This prevents writing a LinkedIn URL
 * for a completely different person when Brave returns an irrelevant first result.
 * Example: searching "Jane Nguyen acme.com LinkedIn" might return a result
 * for "Jane Smith" - the slug check catches that.
 */
/** The accepted LinkedIn result and its clean URL, so the job title comes from the same profile. */
function linkedInResult(results, lastName) {
  const slugFragment = lastName
    ? lastName.toLowerCase().replace(/[^a-z0-9]/g, '')
    : null;

  for (const r of results?.web?.results ?? []) {
    const url = r.url ?? '';
    if (!url.includes('linkedin.com/in/')) continue;
    const cleanUrl = url.split('?')[0];

    if (slugFragment) {
      const slug = (cleanUrl.split('/in/')[1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!slug.includes(slugFragment)) continue;
    }

    return { url: cleanUrl, result: r };
  }
  return null;
}

/**
 * Find a Twitter/X profile URL in Brave search results.
 * Only matches root profile pages (no sub-paths like /status/...) to avoid
 * returning links to individual tweets.
 */
function extractTwitter(results) {
  for (const r of results?.web?.results ?? []) {
    const url = r.url ?? '';
    if (url.match(/^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/?$/)) return url.split('?')[0];
  }
  return null;
}

/**
 * A job title from the snippet of the LinkedIn result already accepted for this
 * person (never another result, which can be someone else). Snippets typically
 * read "Name - Title at Company | LinkedIn". Null if nothing confident is found.
 */
export function jobTitleFrom(result, name) {
  const desc = result?.description ?? result?.title ?? '';
  const m = desc.match(/[-–|]\s*([A-Z][^|–\-]{3,50}?)(?:\s+(?:at\b|@)|\s*[|–-])/);
  if (m && plausibleTitle(m[1])) return m[1].trim();
  const lastName = name.split(' ').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m2 = desc.match(new RegExp(`${lastName}[,.]?\\s*[-–]?\\s*([A-Z][^|.]{3,50})`, 'i'));
  if (m2 && plausibleTitle(m2[1])) return m2[1].trim();
  return null;
}

/**
 * Reject snippet fragments that are not job titles: too short, not starting
 * with a capital, or a stray word like "embers" cut out of "Members".
 */
function plausibleTitle(raw) {
  const t = String(raw ?? '').trim();
  if (t.length < 4 || !/^[A-Z]/.test(t)) return false;
  if (!/[a-z]/.test(t)) return false;                 // all caps fragments
  if (/^(members?|people|connections?|followers?|profile|view|see|more|about)\b/i.test(t)) return false;
  return true;
}

/**
 * Names shorter than this cannot anchor a search-result match. "Tasha M"
 * would let almost any LinkedIn slug or Twitter handle through, so search
 * fallbacks are skipped for such contacts and only Apollo's own data is used.
 */
const MIN_LAST_NAME = 3;

// ─── Apollo enrichment ───────────────────────────────────────────────────────

/**
 * Look up a person by email using the Apollo.io People Match API.
 * Apollo performs identity resolution against their database of ~275M contacts.
 * When credits are available this is the most reliable source for LinkedIn URLs
 * (verified against Apollo's own data, not a Brave search guess).
 *
 * Phone number revelation is async - Apollo calls back our webhook endpoint
 * (/api/apollo-webhook) when it resolves the phone. The webhook then writes
 * the number directly to GHL. That's why phone numbers don't appear immediately
 * after enrichment but arrive within seconds to minutes.
 *
 * Auth changed in 2025: API key must be in the X-Api-Key header, not the body.
 * reveal_phone_number requires a valid webhook_url - without it Apollo returns 422.
 *
 * Returns null (not an error) when Apollo has no record for the email.
 */
async function enrichFromApollo(email, env) {
  const body = { email, reveal_personal_emails: true };
  // Only request phone reveal if we have a webhook URL configured to receive it.
  // The webhook secret rides in the URL because Apollo can't send custom headers;
  // the auth middleware checks it before the handler runs.
  if (env.WORKER_URL && env.APOLLO_WEBHOOK_SECRET) {
    body.reveal_phone_number = true;
    body.webhook_url = `${env.WORKER_URL}/api/apollo-webhook?t=${env.APOLLO_WEBHOOK_SECRET}`;
  }

  const res = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 404) return null; // no match in Apollo's database - not an error
  if (!res.ok) {
    // Surface the actual error message (e.g. "Not Enough Credits") so it appears
    // in the GHL enrichError field and is visible to the operator
    const body = await res.json().catch(() => ({}));
    const msg = body?.error ?? body?.message ?? body?.errorMessage ?? `HTTP ${res.status}`;
    throw new Error(msg); // the caller adds "Apollo: "
  }

  const data = await res.json();
  const person = data?.person;
  if (!person) return null;

  // Whether a phone reveal was asked for, so the page only says "arriving" when one is coming.
  const result = { phoneRequested: Boolean(body.reveal_phone_number) };
  if (person.id)           result.apolloId    = person.id; // stored in KV so webhook can resolve email
  if (person.first_name)   result.firstName   = person.first_name;
  if (person.last_name)    result.lastName    = person.last_name;
  if (person.title)        result.jobTitle    = person.title;
  if (person.linkedin_url) result.linkedinUrl = person.linkedin_url.split('?')[0];

  // Prefer mobile > direct dial > any number - phones arrive via webhook, not here
  const phones = person.phone_numbers ?? [];
  const best   = phones.find(p => p.type === 'mobile')
              ?? phones.find(p => p.type === 'direct_phone')
              ?? phones[0];
  if (best?.sanitized_number) result.mobilePhone = best.sanitized_number;

  // Org-level data - employee count, and location for contacts whose website blocks scraping
  const org = person.organization ?? {};
  const employees = org.estimated_num_employees ?? org.num_employees;
  if (employees) result.numEmployees = employees;
  if (org.city)    result.city    = org.city;
  if (org.state)   result.state   = org.state;
  if (org.country) result.country = normaliseCountry(org.country);

  return result;
}

// ─── Name completion ──────────────────────────────────────────────────────────

/**
 * Attempt to infer first/last name from an email username.
 * Handles two common patterns:
 *   first.last / first_last / first-last → high confidence (e.g. john.smith@)
 *   jsmith / dmarks (initial + surname)  → low confidence (only initial known)
 * Returns null if the username doesn't match either pattern.
 */
function parseEmailUsername(emailUser) {
  const twoPartMatch = emailUser.match(/^([a-zA-Z]{2,})[._-]([a-zA-Z]{2,})$/);
  if (twoPartMatch) {
    return { firstName: toTitleCase(twoPartMatch[1]), lastName: toTitleCase(twoPartMatch[2]), confidence: 'high' };
  }
  const initialLastMatch = emailUser.match(/^([a-zA-Z])([a-zA-Z]{3,})$/);
  if (initialLastMatch) {
    return { initial: initialLastMatch[1].toUpperCase(), inferredLast: toTitleCase(initialLastMatch[2]), confidence: 'low' };
  }
  return null;
}

/**
 * Resolve a full name for contacts that only have a first name, last name, or neither.
 * Two-stage process:
 *   1. Parse the email username - "john.smith@" → John Smith (high confidence)
 *   2. Brave LinkedIn search - find the LinkedIn profile, extract name from title
 *
 * The LinkedIn title match includes a plausibility check against any name we
 * already know to avoid writing a completely wrong name (e.g. a namesake at
 * a different company). Returns an updates object {firstName?, lastName?} or null.
 */
async function resolveFullName(contact, env, errors = []) {
  const firstName = contact.firstName?.trim() || '';
  const lastName  = contact.lastName?.trim()  || '';
  if (firstName && lastName) return null; // nothing to fill

  const email    = contact.email ?? '';
  const emailUser = email.includes('@') ? email.split('@')[0] : '';
  const domain   = email.includes('@') ? email.split('@')[1] : '';
  const company  = contact.companyName ?? '';

  const updates = {};

  const parsed = emailUser ? parseEmailUsername(emailUser) : null;

  if (parsed?.confidence === 'high') {
    const parsedFirstOk = !firstName || parsed.firstName.toLowerCase().startsWith(firstName.toLowerCase()[0]);
    const parsedLastOk  = !lastName  || parsed.lastName.toLowerCase() === lastName.toLowerCase();
    if (parsedFirstOk && parsedLastOk) {
      if (!firstName) updates.firstName = parsed.firstName;
      if (!lastName)  updates.lastName  = parsed.lastName;
      if (updates.firstName && updates.lastName) return updates;
    }
  }

  // Build the most targeted LinkedIn search possible from what we know
  const knownName = firstName || lastName;
  let searchQuery;
  if (knownName && domain) {
    searchQuery = `"${knownName}" ${domain} site:linkedin.com/in`;
  } else if (knownName && company) {
    searchQuery = `"${knownName}" "${company}" site:linkedin.com/in`;
  } else if (parsed?.inferredLast && domain) {
    searchQuery = `"${parsed.inferredLast}" ${domain} site:linkedin.com/in`;
  } else if (emailUser && domain) {
    searchQuery = `${emailUser} ${domain} linkedin`;
  } else {
    return null;
  }

  try {
    const r = await braveSearch(searchQuery, env, 5);
    for (const result of r?.web?.results ?? []) {
      if (!result.url?.includes('linkedin.com/in/')) continue;
      // LinkedIn page titles follow the pattern: "FirstName LastName - Title | LinkedIn"
      const titleMatch = result.title?.match(/^([A-Z][a-zÀ-ÿ'-]+(?:\s+[A-Z][a-z'-]+)?)\s+([A-Z][A-Za-zÀ-ÿ''-]+(?:\s+[A-Z][a-z'-]+)?)\s*[-|]/);
      if (!titleMatch) continue;

      const [, liFirst, liLast] = titleMatch;

      // Plausibility checks - reject if the result contradicts what we already know
      if (firstName && !liFirst.toLowerCase().startsWith(firstName.toLowerCase().slice(0, 2))) continue;
      if (lastName  && liLast.toLowerCase() !== lastName.toLowerCase()) continue;
      if (parsed?.initial && !liFirst.toUpperCase().startsWith(parsed.initial)) continue;

      if (!firstName) updates.firstName = liFirst;
      if (!lastName)  updates.lastName  = liLast;
      break;
    }
  } catch (e) {
    // The names read from the email stay; the failure is recorded, not swallowed.
    errors.push(`Name completion: ${e.message}`);
  }

  return Object.keys(updates).length ? updates : null;
}

// ─── Main enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich a single Growably contact record.
 *
 * `env` must be the resolved runtime env from config.js (routes and the cron
 * handler do this before calling in).
 *
 * Pipeline (in order):
 *   0.   Name normalization - fix ALL CAPS / all-lowercase names
 *   0.5  Name completion - fill missing first/last name from email or Brave
 *   1.   Apollo - person data, org size and location
 *   2.   Brave → LinkedIn (fallback if Apollo had no record)
 *   3.   Brave → Twitter/X
 *   4.   Company website scrape + Brave search fallback
 *   5.   Sector tag
 *   6.   Stamp enrich date and any errors to Growably
 *
 * Non-fatal errors (individual step failures) are collected and written to the
 * Enrich Error custom field so the operator can see exactly what failed without
 * the whole enrichment being lost.
 *
 * Returns { contactId, name, found, suggested, errors, missingFields }.
 */
export async function enrichContact(contact, env) {
  // Custom field IDs for this Growably account. A field that has not been
  // created yet is simply absent from the map; writes to it are skipped and
  // reported, never fatal.
  const fieldIds = await resolveFieldIds(env);
  const missingFields = new Set();

  let firstName = contact.firstName?.trim() || '';
  let lastName  = contact.lastName?.trim()  || '';
  const email   = contact.email ?? '';
  const domain  = email.includes('@') ? email.split('@')[1] : null;
  const company = contact.companyName ?? '';

  // Skip company enrichment for contacts with personal email addresses.
  // Otherwise we'd scrape gmail.com and write Google's address to the record.
  const freeMail = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','me.com'];
  const isFreeMail = domain ? freeMail.includes(domain.toLowerCase()) : true;

  const updates   = { customFields: [] }; // accumulates everything to PUT to Growably at the end
  const found     = {};                   // returned to the frontend - fields actually written
  const suggested = {};                   // fields where new data conflicts with existing - user can apply manually
  const errors    = [];                   // non-fatal errors written to the Enrich Error field

  // Queue a custom field write, or record that the field is not set up yet.
  function setField(key, value) {
    const id = fieldIds[key];
    if (!id) { missingFields.add(key); return; }
    updates.customFields.push({ id, value });
  }

  // Helper for fields where we only fill empties. If the field already has a different
  // value, surface it as `suggested` so the operator can choose to overwrite from the UI.
  function setOrSuggest(currentVal, newVal, foundKey, applyFn) {
    if (newVal == null || newVal === '') return;
    const cur = String(currentVal ?? '').trim();
    const nv  = String(newVal).trim();
    if (!cur) {
      found[foundKey] = nv;
      applyFn(nv);
    } else if (cur.toLowerCase() !== nv.toLowerCase()) {
      suggested[foundKey] = nv;
    } else {
      delete suggested[foundKey]; // the company site runs after Apollo, so the site wins
    }
  }

  // ── 0. Name normalization ────────────────────────────────────────────────
  if (needsNormalization(contact.firstName)) {
    const fixed = toTitleCase(contact.firstName);
    updates.firstName = fixed;
    found.firstName = fixed;
    firstName = fixed;
  }
  if (needsNormalization(contact.lastName)) {
    const fixed = toTitleCase(contact.lastName);
    updates.lastName = fixed;
    found.lastName = fixed;
    lastName = fixed;
  }

  // ── 0.5. Name completion ─────────────────────────────────────────────────
  if (!firstName || !lastName) {
    try {
      const nameUpdates = await resolveFullName({ ...contact, firstName, lastName }, env, errors);
      if (nameUpdates) {
        if (nameUpdates.firstName) { updates.firstName = nameUpdates.firstName; found.firstName = nameUpdates.firstName; firstName = nameUpdates.firstName; }
        if (nameUpdates.lastName)  { updates.lastName  = nameUpdates.lastName;  found.lastName  = nameUpdates.lastName;  lastName  = nameUpdates.lastName;  }
      }
    } catch (e) { errors.push(`Name completion: ${e.message}`); }
  }

  // ── 1. Apollo ────────────────────────────────────────────────────────────
  let apollo = null;
  if (email && env.APOLLO_API_KEY) {
    try { apollo = await enrichFromApollo(email, env); }
    catch (e) { errors.push(`Apollo: ${e.message}`); }
  } else if (!env.APOLLO_API_KEY) {
    errors.push('Apollo: API key not set');
  }

  if (apollo) {
    // Store apolloId → email in KV (24h TTL) so the async phone webhook can resolve the GHL contact
    if (apollo.apolloId && email) {
      // Without this mapping the webhook cannot find the contact, so no phone will arrive.
      const mapped = await env.ENRICH_KV.put(`apollo:${apollo.apolloId}`, email, { expirationTtl: 86400 })
        .then(() => true, (e) => { errors.push(`Phone reveal: ${e.message}`); return false; });
      // Phone arrives via webhook - signal the frontend so it shows "arriving" rather than "not found"
      if (mapped && apollo.phoneRequested && !apollo.mobilePhone) found.phonePending = true;
    }

    // Only fill name fields if they're still empty after step 0.5
    if (apollo.firstName && !firstName) { updates.firstName = apollo.firstName; found.firstName = apollo.firstName; firstName = apollo.firstName; }
    if (apollo.lastName  && !lastName)  { updates.lastName  = apollo.lastName;  found.lastName  = apollo.lastName;  lastName  = apollo.lastName;  }
    if (apollo.jobTitle) {
      found.jobTitle = apollo.jobTitle;
      setField('jobTitle', apollo.jobTitle);
    }
    if (apollo.linkedinUrl) {
      found.linkedinUrl = apollo.linkedinUrl;
      setField('linkedinUrl', apollo.linkedinUrl);
    }
    if (apollo.mobilePhone) {
      found.mobilePhone = apollo.mobilePhone;
      setField('mobileNumber', apollo.mobilePhone);
    }
    if (apollo.numEmployees) {
      found.numEmployees = apollo.numEmployees;
      // GHL NUMERICAL fields require string values, not numbers
      setField('employeeCount', String(apollo.numEmployees));
    }
    // Location from Apollo org - used as fallback when website scraping is blocked
    setOrSuggest(contact.city,    apollo.city,    'city',    v => updates.city    = v);
    setOrSuggest(contact.state,   apollo.state,   'state',   v => updates.state   = v);
    setOrSuggest(contact.country, apollo.country, 'country', v => updates.country = v);
  }

  // The searches and the result use the best name after normalization, completion and Apollo.
  const name = `${firstName} ${lastName}`.trim();

  // ── 2. LinkedIn + job title (Brave fallback if Apollo had no record) ─────
  // linkedInResult validates the URL slug contains the last name, preventing
  // mismatched profiles from being written (see function comment for details).
  // A last name too short to validate against means no search fallback at all.
  const nameIsSearchable = lastName.length >= MIN_LAST_NAME;
  if (!apollo?.linkedinUrl && nameIsSearchable) {
    try {
      const r = await braveSearch(`"${name}" ${company || domain} LinkedIn`, env);
      const li = linkedInResult(r, lastName);
      if (li) {
        found.linkedinUrl = li.url;
        setField('linkedinUrl', li.url);
        if (!apollo?.jobTitle) {
          const title = jobTitleFrom(li.result, name);
          if (title) {
            found.jobTitle = title;
            setField('jobTitle', title);
          }
        }
      }
    } catch (e) { errors.push(`LinkedIn: ${e.message}`); }
  }

  // ── 3. Twitter / X ──────────────────────────────────────────────────────
  // The handle must contain the last name (letters and digits only). Weaker
  // than the LinkedIn check but it stops obvious strangers.
  if (nameIsSearchable) {
    try {
      const r = await braveSearch(`"${name}" ${company || domain} twitter.com OR x.com`, env);
      const tw = extractTwitter(r);
      const fragment = lastName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const handle = tw ? (new URL(tw).pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      if (tw && fragment && handle.includes(fragment)) {
        found.twitter = tw;
        setField('twitter', tw);
      }
    } catch (e) { errors.push(`Twitter: ${e.message}`); }
  }

  // ── 4. Company enrichment ────────────────────────────────────────────────
  // Website scrape is primary; Brave search fills gaps if scrape is incomplete.
  // We skip freemail domains to avoid polluting records with Google/Microsoft data.
  if (domain && !isFreeMail) {
    try {
      setField('companyDomain', domain);
      found.companyDomain = domain;

      const web = await enrichCompanyFromWebsite(domain);
      let co = web;
      // Search only finds a name (it never reads phones from snippets), so it runs only without one.
      if (!co.companyName) {
        try {
          const search = await enrichCompanyFromSearch(domain, web.companyName || company, env);
          co = { ...search, ...co }; // website data wins over search data on conflicts
        } catch (e) { errors.push(`Company search: ${e.message}`); }
      }

      // Fill empties automatically; surface conflicts as `suggested` so the
      // operator can apply them per-field from the diff table.
      setOrSuggest(contact.companyName, co.companyName, 'companyName', v => updates.companyName = v);
      setOrSuggest(contact.website,     co.website,     'website',     v => updates.website     = v);
      setOrSuggest(contact.address1,    co.address1,    'address1',    v => updates.address1    = v);
      setOrSuggest(contact.city,        co.city,        'city',        v => updates.city        = v);
      setOrSuggest(contact.state,       co.state,       'state',       v => updates.state       = v);
      setOrSuggest(contact.country,     co.country,     'country',     v => updates.country     = v);
      setOrSuggest(contact.phone,       co.phone,       'companyPhone', v => updates.phone      = v);

      if (co.postalCode) {
        // Reject a US-format ZIP for contacts that are clearly Canadian (.ca email or country=CA)
        const isCanadian = contact.country === 'CA' || (contact.email ?? '').toLowerCase().endsWith('.ca');
        const looksLikeUsZip = /^\d{5}(-\d{4})?$/.test(co.postalCode);
        if (!isCanadian || !looksLikeUsZip) {
          setOrSuggest(contact.postalCode, co.postalCode, 'postalCode', v => updates.postalCode = v);
        }
      }
    } catch (e) { errors.push(`Company: ${e.message}`); }
  }

  // ── Sector tag ───────────────────────────────────────────────────────────
  // Applies a tag like "sector-healthcare" or "sector-nonprofit" to enable
  // sector-specific automations and filtering in GHL.
  try {
    const sector  = inferSector(updates.companyName || company, domain || '', found.jobTitle || '');
    const tag     = sector === 'smb' ? 'sector-general' : `sector-${sector}`;
    await ghlPost(`/contacts/${contact.id}/tags`, { tags: [tag] }, env);
    found.sectorTag = tag;
  } catch (e) { errors.push(`Sector tag: ${e.message}`); }

  // ── Stamp enrich date + error log ────────────────────────────────────────
  setField('enrichDate', new Date().toISOString());
  if (missingFields.size > 0) {
    errors.push(`Fields not set up in Growably: ${[...missingFields].join(', ')} (Settings → Growably fields)`);
  }
  if (errors.length > 0) {
    setField('enrichError', errors.join('; '));
  }

  await ghlPut(`/contacts/${contact.id}`, updates, env);
  console.log(`[enrich] ${contact.id} found=${Object.keys(found).join(',') || 'nothing'} ` +
    `suggested=${Object.keys(suggested).join(',') || 'none'} errors=${errors.length}`);
  return { contactId: contact.id, name, found, suggested, errors, missingFields: [...missingFields] };
}

// ─── Sector detection ─────────────────────────────────────────────────────────

/**
 * Infer the contact's industry sector from company name, domain, and job title.
 * Used for two purposes:
 *   1. Applying sector tags in GHL (sector-healthcare, sector-legal, etc.)
 *   2. Selecting the right sector context search query in generateBrief
 *
 * 'smb' is the catch-all fallback - maps to tag "sector-general".
 *
 * Coverage gaps to be aware of:
 *   - Nonprofits often use "Society" or "Family Services" in their name
 *     (covered) but a name with no sector words in it won't match
 *   - Real estate, manufacturing, retail are not explicitly detected (fall through to smb)
 */
export function inferSector(company, domain, jobTitle) {
  const text = `${company} ${domain} ${jobTitle}`.toLowerCase();
  if (/health|medical|clinic|dental|hospital|pharma|care|therapy|rehab|physio|chiro|optom|nurs|doctor|md\./.test(text)) return 'healthcare';
  if (/legal|law firm|lawyer|attorney|solicitor|barrister|notary|paralegal|litigation/.test(text)) return 'legal';
  if (/account|cpa|bookkeep|tax prep|audit|chartered professional|wealth manag|financial plan/.test(text)) return 'accounting';
  if (/insur|broker|underwr|claims|actuari|risk manag/.test(text)) return 'insurance';
  if (/nonprofit|non-profit|charity|foundation|society|association|\bngo\b|social service|community service|family service|youth service|senior service|mental health|supportive housing|community health|food bank|\bshelter\b|hospice|immigrant service|refugee|transition house/.test(text)) return 'nonprofit';
  return 'smb';
}
