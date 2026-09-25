/**
 * Growably Contact Enricher - frontend
 *
 * Single-page app served as static assets by the worker, so the UI and the
 * API share one origin behind Cloudflare Access. API calls are same-origin
 * and carry the Access session; the worker verifies it on every request.
 *
 * On load the app calls GET /api/config and branches:
 *   - Access not configured yet   -> instructions screen (SETUP.md step 3)
 *   - no administrator exists yet -> first-run setup screen
 *   - otherwise                   -> the app, with admin cards for superusers
 *
 * Views: "add", "single", "bulk" (administrators), "settings".
 * No build step: plain ES2020, no bundler, no framework.
 */

const API_BASE = '';

// ── State ─────────────────────────────────────────────────────────────────────

let CONFIG = null;   // GET /api/config
let FIELDS = {};     // Growably custom field IDs by key, from CONFIG.fields
let currentUserEmail = null;
let currentUserRole  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** fetch wrapper: JSON in, JSON out, throws an Error with the server's message. */
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Escape text for safe insertion into innerHTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Temporary toast at the bottom of the screen. Error toasts stay until
 * dismissed; others go after 4 seconds. type: 'info' | 'success' | 'error'
 */
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.addEventListener('click', () => el.remove());
  document.getElementById('toast-container').appendChild(el);
  if (type !== 'error') setTimeout(() => el.remove(), 4000);
}

/** Avatar initials from a contact object. */
function initials(c) {
  return ((c.firstName?.[0] ?? '') + (c.lastName?.[0] ?? '')).toUpperCase() || '?';
}

/** Read a custom field value from a Growably contact by field ID. Null if absent or the field is not set up. */
function cf(contact, id) {
  if (!id) return null;
  return contact.customFields?.find(f => f.id === id)?.value ?? null;
}

/**
 * Enrichment status for the pill:
 *   date + no error -> Enriched, date + error -> Needs review,
 *   no date + error -> Failed, nothing -> Not enriched
 */
function enrichStatus(contact) {
  const date = cf(contact, FIELDS.enrichDate);
  const err  = cf(contact, FIELDS.enrichError);
  if (date && !err)  return { cls: 'pill-enriched', label: 'Enriched' };
  if (date && err)   return { cls: 'pill-partial',  label: 'Needs review' };
  if (!date && err)  return { cls: 'pill-failed',   label: 'Failed' };
  return { cls: 'pill-queued', label: 'Not enriched' };
}

/** Rows of the diff table, in display order. */
function fieldRows(contact) {
  return [
    { name: 'Email',          value: contact.email },
    { name: 'Email Status',   value: cf(contact, FIELDS.emailStatus), emailStatus: true },
    { name: 'Phone',          value: contact.phone, applyKeys: ['companyPhone'] },
    { name: 'Mobile',         value: cf(contact, FIELDS.mobileNumber) },
    { name: 'Company',        value: contact.companyName, applyKeys: ['companyName'] },
    { name: 'Employees',      value: cf(contact, FIELDS.employeeCount) },
    { name: 'Job Title',      value: cf(contact, FIELDS.jobTitle) },
    { name: 'Website',        value: contact.website, link: true, applyKeys: ['website'] },
    { name: 'Company Domain', value: cf(contact, FIELDS.companyDomain) },
    { name: 'Address',        value: [contact.address1, contact.city, contact.state, contact.postalCode, contact.country].filter(Boolean).join(', ') || null, applyKeys: ['address1', 'city', 'state', 'postalCode', 'country'], composite: 'address' },
    { name: 'LinkedIn',       value: cf(contact, FIELDS.linkedinUrl), link: true },
    { name: 'Twitter / X',    value: cf(contact, FIELDS.twitter), link: true },
    { name: 'Last enriched',  value: cf(contact, FIELDS.enrichDate) ? new Date(cf(contact, FIELDS.enrichDate)).toLocaleString() : null },
    { name: 'Enrich error',   value: cf(contact, FIELDS.enrichError) },
  ];
}

function goToSettings() {
  document.querySelector('[data-view="settings"]').click();
}

// ── Theme (light / dark) ──────────────────────────────────────────────────────
// Preference in localStorage under 'theme'; OS preference on first visit.

(function () {
  let stored = null;
  try { stored = localStorage.getItem('theme'); } catch { /* private mode */ }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (stored === 'dark' || (!stored && prefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

function applyTheme(dark) {
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  const toggle = document.getElementById('dark-mode-toggle');
  if (toggle) toggle.setAttribute('aria-checked', String(dark));
  if (CONFIG?.branding) applyBrandColor(CONFIG.branding.brandColor, CONFIG.branding.accentColor);
}

document.getElementById('dark-mode-toggle').addEventListener('click', (e) => {
  applyTheme(e.currentTarget.getAttribute('aria-checked') !== 'true');
});

// ── Branding ──────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Blend `hex` toward `withHex` by `weight` (0 keeps hex, 1 gives withHex). */
function mix(hex, withHex, weight) {
  const a = hexToRgb(hex) ?? [232, 122, 37];
  const b = hexToRgb(withHex) ?? [255, 255, 255];
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * weight));
}

const DEFAULT_PRIMARY = '#e87a25';
const DEFAULT_ACCENT  = '#0f5aac';

/**
 * Push the two brand colours into the CSS variables the stylesheet uses.
 * Primary drives buttons, the active nav item and progress; accent drives
 * links, section labels and focus rings.
 */
function applyBrandColor(primary, accent) {
  if (!hexToRgb(primary)) primary = DEFAULT_PRIMARY;
  if (!hexToRgb(accent))  accent  = DEFAULT_ACCENT;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const root = document.documentElement.style;
  root.setProperty('--color-primary',       primary);
  root.setProperty('--color-primary-dark',  mix(primary, '#000000', 0.18));
  root.setProperty('--color-primary-light', dark ? mix(primary, '#111828', 0.86) : mix(primary, '#ffffff', 0.9));
  root.setProperty('--color-accent',        dark ? mix(accent, '#ffffff', 0.3) : accent);
  root.setProperty('--color-accent-dark',   mix(accent, '#000000', 0.2));
  root.setProperty('--color-info',          accent);
  const [r, g, b] = hexToRgb(accent);
  root.setProperty('--focus-ring', `rgba(${r}, ${g}, ${b}, 0.22)`);
}

function letterMark(name) {
  return (String(name ?? '').trim()[0] ?? 'L').toUpperCase();
}

function defaultFavicon(color, letter) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${color}'/><text x='16' y='22' font-family='system-ui,sans-serif' font-size='18' font-weight='700' fill='#fff' text-anchor='middle'>${letter}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** Apply name, logo and colour everywhere they show. */
function applyBranding(b) {
  const name = b?.appName || 'Lead Enrichment';
  document.title = name;
  document.getElementById('brand-name').textContent = name;
  document.getElementById('brand-mark').textContent = letterMark(name);

  const logo = document.getElementById('brand-logo');
  const mark = document.getElementById('brand-mark');
  if (b?.logoDataUrl) {
    logo.src = b.logoDataUrl;
    logo.classList.remove('hidden');
    mark.classList.add('hidden');
  } else {
    logo.removeAttribute('src');
    logo.classList.add('hidden');
    mark.classList.remove('hidden');
  }

  applyBrandColor(b?.brandColor, b?.accentColor);
  document.getElementById('favicon').href = b?.logoDataUrl || defaultFavicon(hexToRgb(b?.brandColor) ? b.brandColor : DEFAULT_PRIMARY, letterMark(name));
}

// ── Services (shared by first-run setup and Settings) ─────────────────────────

const SERVICES = [
  {
    id: 'ghl', label: 'Growably', desc: 'Contacts, custom fields and notes',
    help: 'In Growably: Settings, Private Integrations, Create new integration. Scopes: contacts (read and write), locations (read), custom fields (read and write). The Location ID is under Settings, Business Profile.',
    fields: [
      { key: 'ghlApiKey',     label: 'Private integration token', secret: true },
      { key: 'ghlLocationId', label: 'Location ID', mono: true },
    ],
  },
  {
    id: 'apollo', label: 'Apollo.io', desc: 'Person and company data, mobile numbers',
    help: [
      'Sign in at app.apollo.io. Open Settings (the gear icon, bottom left), then Integrations, then API Keys.',
      'Click Create new key and give it a name, such as Contact Enricher.',
      'Apollo asks which endpoints the key may use. Tick People Enrichment (the people/match call, under People) and the auth Health check. Or turn on Set as master key to allow everything.',
      'Click Create, copy the key, paste it below, then click Test.',
    ],
    note: 'Every enrichment spends Apollo credits, and mobile numbers spend more. Check your plan\'s allowance in Apollo under Settings, Plans and Billing.',
    fields: [{ key: 'apolloApiKey', label: 'API key', secret: true }],
  },
  {
    id: 'brave', label: 'Brave Search', desc: 'LinkedIn, Twitter and company lookups',
    help: 'api.search.brave.com: create a key on the Data for Search plan. The free tier covers light use.',
    fields: [{ key: 'braveApiKey', label: 'API key', secret: true }],
  },
  {
    id: 'ai', label: 'AI provider', desc: 'Pre-meeting briefs (optional)',
    help: 'Only the Generate Brief button uses this. Leave it blank if you do not need briefs.',
    fields: [
      { key: 'aiProvider', label: 'Provider', type: 'select' },
      { key: 'aiApiKey',   label: 'API key', secret: true },
      { key: 'aiModel',    label: 'Model', mono: true, optional: true, placeholder: 'blank = provider default' },
    ],
  },
];

/** Help block for a service: numbered steps when `help` is a list, one line otherwise, plus an optional note. */
function helpHtml(svc) {
  const steps = Array.isArray(svc.help)
    ? `<ol class="form-steps">${svc.help.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`
    : `<p class="form-hint">${esc(svc.help)}</p>`;
  return steps + (svc.note ? `<p class="form-hint">${esc(svc.note)}</p>` : '');
}

/** Provider options for the AI select, from /api/config. */
function providerOptions(selected) {
  const providers = CONFIG?.ai?.providers ?? {};
  return Object.entries(providers).map(([id, p]) =>
    `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(p.label)} (default model ${esc(p.defaultModel)})</option>`).join('');
}

/** Inputs for one service. `values` prefills non-secret fields. */
function serviceInputsHtml(svc, prefix, values = {}) {
  return svc.fields.map(f => {
    const id = `${prefix}-${svc.id}-${f.key}`;
    let control;
    if (f.type === 'select') {
      control = `<select id="${id}" class="text-input plain" data-key="${f.key}">${providerOptions(values[f.key] ?? 'anthropic')}</select>`;
    } else {
      control = `<input id="${id}" class="text-input plain ${f.mono ? 'mono' : ''}" data-key="${f.key}"
        type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
        placeholder="${esc(f.placeholder ?? (f.secret && values.__editing ? 'leave blank to keep current' : ''))}"
        value="${f.secret ? '' : esc(values[f.key] ?? '')}" />`;
    }
    return `<label class="form-field ${svc.fields.length === 1 ? 'form-field-wide' : ''}" for="${id}">
      <span class="form-label">${esc(f.label)}${f.optional ? ' <span class="optional-label">optional</span>' : ''}</span>${control}</label>`;
  }).join('');
}

/** Collect { key: value } from the inputs inside `container` (blank values skipped). */
function collectValues(container) {
  const out = {};
  container.querySelectorAll('[data-key]').forEach(el => {
    const v = el.value.trim();
    if (v) out[el.dataset.key] = v;
  });
  return out;
}

/** Test button handler: posts the current inputs of that service and shows the verdict. */
async function runServiceTest(svcId, container, resultEl, btn) {
  const values = collectValues(container);
  btn.disabled = true;
  resultEl.textContent = 'Testing…';
  resultEl.className = 'form-hint test-result';
  try {
    const r = await api('/api/admin/test', { method: 'POST', body: JSON.stringify({ service: svcId, values }) });
    if (r.ok) {
      const extra = r.locationName ? ` (${r.locationName})` : r.model ? ` (${r.model})` : '';
      resultEl.textContent = `Works${extra}.${r.note ? ' ' + r.note : ''}`;
      resultEl.classList.add('test-ok');
    } else {
      resultEl.textContent = r.error || 'Failed';
      resultEl.classList.add('test-fail');
    }
  } catch (e) {
    resultEl.textContent = e.message;
    resultEl.classList.add('test-fail');
  } finally {
    btn.disabled = false;
  }
}

// ── First-run setup ───────────────────────────────────────────────────────────

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showSetupScreen(cfg) {
  document.getElementById('app-shell').setAttribute('aria-hidden', 'true');
  document.getElementById('setup-title').textContent = `Set up ${cfg.branding?.appName || 'Lead Enrichment'}`;
  document.getElementById('setup-admins').value = cfg.user.email;

  const nokey = document.getElementById('setup-nokey');
  if (!cfg.encryptionReady) {
    nokey.classList.remove('hidden');
    const key = randomHex(32);
    document.getElementById('setup-generated-key').textContent = key;
    document.getElementById('setup-copy-key').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(key); toast('Copied.', 'success'); }
      catch { toast('Copy failed. Select the value and copy it manually.', 'error'); }
    });
  }

  const services = document.getElementById('setup-services');
  services.innerHTML = SERVICES.map(svc => `
    <fieldset class="setup-section" data-service="${svc.id}">
      <legend>${esc(svc.label)}${svc.id === 'ai' ? ' <span class="optional-label">optional</span>' : ''}</legend>
      ${helpHtml(svc)}
      <div class="form-grid">${serviceInputsHtml(svc, 'setup')}</div>
      <div class="test-row">
        <button type="button" class="btn btn-secondary btn-sm" data-test="${svc.id}">Test</button>
        <span class="form-hint test-result" data-test-result="${svc.id}"></span>
      </div>
    </fieldset>`).join('');

  services.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      const box = btn.closest('fieldset');
      runServiceTest(btn.dataset.test, box, box.querySelector('[data-test-result]'), btn);
    });
  });

  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('setup-error');
    const submit = document.getElementById('setup-submit');
    errEl.textContent = '';

    const admins = document.getElementById('setup-admins').value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    if (!admins.length) { errEl.textContent = 'Enter at least one administrator email.'; return; }

    const secrets = collectValues(services);
    const appName = document.getElementById('setup-app-name').value.trim();

    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const r = await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ admins, secrets, branding: appName ? { appName } : undefined }),
      });
      toast(r.youAreAdmin ? 'Setup complete. You are an administrator.' : 'Setup complete.', 'success');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      errEl.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'Finish setup';
    }
  });

  document.getElementById('setup-screen').classList.remove('hidden');
}

function showAccessScreen(kind) {
  document.getElementById('app-shell').setAttribute('aria-hidden', 'true');
  const title = document.getElementById('access-title');
  const body  = document.getElementById('access-body');
  const host  = window.location.hostname;
  if (kind === 'not_configured') {
    title.textContent = 'Sign-in is not set up yet';
    body.innerHTML = `
      <p class="page-desc">The worker is running, but it does not know which Cloudflare Access application protects it. This is step 3 of SETUP.md.</p>
      <ol class="setup-steps">
        <li>In the Cloudflare dashboard, open this worker, then the <em>Access</em> tab, and click <em>Protect this Worker behind Access</em>. Scope: All traffic. Policy: Cloudflare account.</li>
        <li>The Access tab then shows <em>Application values</em>: an AUD tag and a JWKS URL.</li>
        <li>In the worker's <em>Settings</em>, <em>Variables and Secrets</em>, set <code>ACCESS_APP_AUD</code> to the AUD tag and <code>ACCESS_TEAM_DOMAIN</code> to the JWKS URL.</li>
        <li>In Zero Trust, create a self-hosted application for <code>${esc(host)}/api/apollo-webhook</code> with a Bypass policy for Everyone (SETUP.md step 2c).</li>
        <li>Wait a minute, then reload this page. You will be asked to sign in.</li>
      </ol>`;
  } else {
    title.textContent = 'Your sign-in could not be verified';
    body.innerHTML = `
      <p class="page-desc">Cloudflare let you through, but the worker could not verify the session. Reload once. If it keeps happening, the <code>ACCESS_TEAM_DOMAIN</code> or <code>ACCESS_APP_AUD</code> secret does not match the Access application on <code>${esc(host)}</code>.</p>
      <p><a class="btn btn-primary" href="/cdn-cgi/access/logout">Sign out and try again</a></p>`;
  }
  document.getElementById('access-screen').classList.remove('hidden');
}

// ── Profile card and sign-out ─────────────────────────────────────────────────

function renderProfile(user) {
  const displayName = user.name || user.email;
  document.getElementById('profile-name').textContent  = displayName;
  document.getElementById('profile-email').textContent = user.email;
  document.getElementById('profile-initials').textContent =
    displayName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('profile-card').classList.remove('hidden');
}

document.getElementById('profile-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('profile-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', () => {
  document.getElementById('profile-dropdown')?.classList.add('hidden');
});
document.getElementById('logout-btn').addEventListener('click', () => {
  window.location.href = '/cdn-cgi/access/logout';
});

// ── Admin: integrations ───────────────────────────────────────────────────────

let integrationsStatus = null;

async function loadIntegrations() {
  const tbody = document.getElementById('integrations-tbody');
  try {
    integrationsStatus = await api('/api/admin/integrations');
    document.getElementById('integrations-nokey').classList.toggle('hidden', integrationsStatus.encryptionReady);
    renderIntegrations();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-error);padding:12px">${esc(e.message)}</td></tr>`;
  }
}

function integrationSummary(svc, s) {
  if (svc.id === 'ghl')    return s.ghl ? `Location ${esc(s.masked.ghlLocationId)}, token ${esc(s.masked.ghlApiKey)}` : 'Not connected';
  if (svc.id === 'apollo') return s.masked.apolloApiKey ? esc(s.masked.apolloApiKey) : 'No key';
  if (svc.id === 'brave')  return s.masked.braveApiKey ? esc(s.masked.braveApiKey) : 'No key';
  if (svc.id === 'ai') {
    const p = s.providers?.[s.aiProvider];
    return s.ai ? `${esc(p?.label ?? s.aiProvider)}, ${esc(s.aiModel || p?.defaultModel || '')}, key ${esc(s.masked.aiApiKey)}` : 'No key';
  }
  return '';
}

function renderIntegrations() {
  const s = integrationsStatus;
  document.getElementById('integrations-tbody').innerHTML = SERVICES.map(svc => {
    const ok = Boolean(s[svc.id]);
    return `
    <tr data-service="${svc.id}">
      <td class="td-field-name"><div>${esc(svc.label)}</div><div class="td-sub">${esc(svc.desc)}</div></td>
      <td><span class="key-status ${ok ? 'key-status-ok' : 'key-status-missing'}">${ok ? 'Configured' : 'Not set'}</span></td>
      <td class="key-masked-cell"><span class="key-masked">${integrationSummary(svc, s)}</span></td>
      <td style="text-align:right"><button class="btn btn-secondary btn-sm" data-edit="${svc.id}">Update</button></td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#integrations-tbody [data-edit]').forEach(btn => {
    btn.addEventListener('click', () => startIntegrationEdit(btn.dataset.edit));
  });
}

function startIntegrationEdit(svcId) {
  const svc = SERVICES.find(x => x.id === svcId);
  const row = document.querySelector(`#integrations-tbody tr[data-service="${svcId}"]`);
  if (!svc || !row) return;
  const s = integrationsStatus;
  const prefill = { __editing: true, ghlLocationId: s.masked.ghlLocationId ?? '', aiProvider: s.aiProvider, aiModel: s.aiModel ?? '' };

  row.innerHTML = `
    <td colspan="4" class="edit-cell">
      <div class="td-field-name">${esc(svc.label)}</div>
      ${helpHtml(svc)}
      <div class="form-grid" data-service="${svcId}">${serviceInputsHtml(svc, 'settings', prefill)}</div>
      <div class="test-row">
        <button type="button" class="btn btn-secondary btn-sm" data-test="${svcId}">Test</button>
        <button type="button" class="btn btn-primary btn-sm" data-save="${svcId}">Save</button>
        <button type="button" class="btn btn-secondary btn-sm" data-cancel="${svcId}">Cancel</button>
        <span class="form-hint test-result" data-test-result="${svcId}"></span>
      </div>
    </td>`;

  const grid = row.querySelector('.form-grid');
  const result = row.querySelector('[data-test-result]');
  row.querySelector('[data-cancel]').addEventListener('click', renderIntegrations);
  row.querySelector('[data-test]').addEventListener('click', (e) => runServiceTest(svcId, grid, result, e.currentTarget));
  row.querySelector('[data-save]').addEventListener('click', async (e) => {
    const values = collectValues(grid);
    if (!Object.keys(values).length) { toast('Nothing to save.', 'info'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      integrationsStatus = await api('/api/admin/integrations', { method: 'PUT', body: JSON.stringify(values) });
      toast(`${svc.label} updated.`, 'success');
      renderIntegrations();
      refreshConfig();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  grid.querySelector('input, select')?.focus();
}

// ── Admin: Growably fields ────────────────────────────────────────────────────

async function loadFieldStatus() {
  const tbody = document.getElementById('fields-status-tbody');
  const note  = document.getElementById('fields-note');
  note.textContent = '';
  try {
    const { fields } = await api('/api/admin/fields');
    renderFieldStatus(fields);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-error);padding:12px">${esc(e.message)}</td></tr>`;
  }
}

function renderFieldStatus(fields) {
  document.getElementById('fields-status-tbody').innerHTML = fields.map(f => `
    <tr>
      <td class="td-field-name">${esc(f.name)}</td>
      <td class="td-current">${esc(f.dataType)}</td>
      <td><span class="key-status ${f.id ? 'key-status-ok' : 'key-status-missing'}">${f.id ? 'Exists' : 'Missing'}</span></td>
    </tr>`).join('');
  const missing = fields.filter(f => !f.id).length;
  document.getElementById('fields-create-btn').disabled = missing === 0;
  document.getElementById('fields-note').textContent = missing ? `${missing} to create.` : 'All fields exist.';
}

document.getElementById('fields-refresh-btn').addEventListener('click', loadFieldStatus);
document.getElementById('fields-create-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const r = await api('/api/admin/fields/create', { method: 'POST' });
    renderFieldStatus(r.fields);
    if (r.failed?.length) toast(`Created ${r.created.length}, failed ${r.failed.length}: ${r.failed.map(f => f.name).join(', ')}`, 'error');
    else toast(`Created ${r.created.length} field${r.created.length === 1 ? '' : 's'} in Growably.`, 'success');
    await refreshConfig();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.textContent = 'Create missing fields';
  }
});

// ── Admin: branding ───────────────────────────────────────────────────────────

let pendingLogo; // undefined = unchanged, '' = remove, 'data:...' = new logo

function loadBrandingForm() {
  const b = CONFIG.branding;
  document.getElementById('brand-app-name').value = b.appName;
  document.getElementById('brand-color').value = b.brandColor;
  document.getElementById('brand-color-hex').value = b.brandColor;
  document.getElementById('accent-color').value = b.accentColor || DEFAULT_ACCENT;
  document.getElementById('accent-color-hex').value = b.accentColor || DEFAULT_ACCENT;
  const preview = document.getElementById('brand-logo-preview');
  if (b.logoDataUrl) { preview.src = b.logoDataUrl; preview.classList.remove('hidden'); }
  else { preview.removeAttribute('src'); preview.classList.add('hidden'); }
  document.getElementById('brand-logo-file').value = '';
  pendingLogo = undefined;
}

document.getElementById('brand-color').addEventListener('input', (e) => {
  document.getElementById('brand-color-hex').value = e.target.value;
});
document.getElementById('brand-color-hex').addEventListener('input', (e) => {
  if (hexToRgb(e.target.value)) document.getElementById('brand-color').value = e.target.value;
});
document.getElementById('accent-color').addEventListener('input', (e) => {
  document.getElementById('accent-color-hex').value = e.target.value;
});
document.getElementById('accent-color-hex').addEventListener('input', (e) => {
  if (hexToRgb(e.target.value)) document.getElementById('accent-color').value = e.target.value;
});

document.getElementById('brand-logo-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 300 * 1024) { toast('Logo is too large. Keep it under 300 KB.', 'error'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    pendingLogo = String(reader.result);
    const preview = document.getElementById('brand-logo-preview');
    preview.src = pendingLogo;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

document.getElementById('brand-logo-remove').addEventListener('click', () => {
  pendingLogo = '';
  const preview = document.getElementById('brand-logo-preview');
  preview.removeAttribute('src');
  preview.classList.add('hidden');
  document.getElementById('brand-logo-file').value = '';
});

document.getElementById('brand-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const patch = {
    appName: document.getElementById('brand-app-name').value,
    brandColor: document.getElementById('brand-color-hex').value.trim(),
    accentColor: document.getElementById('accent-color-hex').value.trim(),
  };
  if (pendingLogo !== undefined) patch.logoDataUrl = pendingLogo;
  btn.disabled = true;
  try {
    const { branding } = await api('/api/admin/branding', { method: 'PUT', body: JSON.stringify(patch) });
    CONFIG.branding = branding;
    applyBranding(branding);
    loadBrandingForm();
    toast('Branding saved.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Admin: brief profile ──────────────────────────────────────────────────────

const PROFILE_INPUTS = {
  repName: 'bp-rep-name', companyName: 'bp-company-name', companyDescription: 'bp-company-desc',
  region: 'bp-region', timezone: 'bp-timezone', differentiators: 'bp-differentiators',
};

async function loadBriefProfile() {
  try {
    const { profile } = await api('/api/admin/brief-profile');
    for (const [k, id] of Object.entries(PROFILE_INPUTS)) document.getElementById(id).value = profile[k] ?? '';
    if (!profile.timezone) {
      try { document.getElementById('bp-timezone').placeholder = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* keep default */ }
    }
  } catch (e) {
    toast(`Could not load brief profile: ${e.message}`, 'error');
  }
}

document.getElementById('bp-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const patch = {};
  for (const [k, id] of Object.entries(PROFILE_INPUTS)) patch[k] = document.getElementById(id).value;
  btn.disabled = true;
  try {
    await api('/api/admin/brief-profile', { method: 'PUT', body: JSON.stringify(patch) });
    toast('Brief profile saved.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Admin: users ──────────────────────────────────────────────────────────────

async function loadUsers() {
  try {
    const { users } = await api('/api/auth/users');
    renderUsers(users ?? []);
  } catch (e) {
    document.getElementById('users-tbody').innerHTML =
      `<tr><td colspan="2" style="color:var(--color-error);padding:12px">${esc(e.message)}</td></tr>`;
  }
}

function renderUsers(users) {
  const TRASH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  const tbody = document.getElementById('users-tbody');

  tbody.innerHTML = users.map(u => {
    const isSelf = u.email === currentUserEmail?.toLowerCase();
    return `
    <tr>
      <td class="td-field-name">${esc(u.email)}${isSelf ? ' <span class="td-sub">(you)</span>' : ''}</td>
      <td>
        <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end">
          <select class="text-input plain user-role-select" data-email="${esc(u.email)}" data-original="${u.role}" ${isSelf ? 'disabled' : ''}>
            <option value="user"      ${u.role === 'user'      ? 'selected' : ''}>User</option>
            <option value="superuser" ${u.role === 'superuser' ? 'selected' : ''}>Administrator</option>
          </select>
          ${isSelf ? '' : `<button class="btn btn-primary btn-sm user-save-btn" data-email="${esc(u.email)}" disabled>Save</button>`}
          ${isSelf ? '' : `<button class="btn btn-secondary btn-sm user-delete-btn" data-email="${esc(u.email)}" title="Remove user">${TRASH_ICON}</button>`}
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('select.user-role-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const btn = sel.closest('tr').querySelector('.user-save-btn');
      if (btn) btn.disabled = sel.value === sel.dataset.original;
    });
  });

  tbody.querySelectorAll('.user-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sel = btn.closest('tr').querySelector('select.user-role-select');
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api('/api/auth/users', { method: 'POST', body: JSON.stringify({ email: sel.dataset.email, role: sel.value }) });
        toast(`${sel.dataset.email} is now ${sel.value === 'superuser' ? 'an administrator' : 'a user'}.`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      await loadUsers();
    });
  });

  // Two-click delete: first click arms the button, second click deletes
  tbody.querySelectorAll('.user-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1';
        btn.classList.add('btn-danger');
        btn.textContent = 'Confirm?';
        setTimeout(() => {
          if (btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.classList.remove('btn-danger');
            btn.innerHTML = TRASH_ICON;
          }
        }, 4000);
        return;
      }
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api(`/api/auth/users/${encodeURIComponent(btn.dataset.email)}`, { method: 'DELETE' });
        toast(`${btn.dataset.email} removed.`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      await loadUsers();
    });
  });
}

document.getElementById('add-user-btn').addEventListener('click', async () => {
  const email = document.getElementById('add-user-email').value.trim().toLowerCase();
  const role  = document.getElementById('add-user-role').value;
  if (!email) return;
  const btn = document.getElementById('add-user-btn');
  btn.disabled = true;
  try {
    await api('/api/auth/users', { method: 'POST', body: JSON.stringify({ email, role }) });
    document.getElementById('add-user-email').value = '';
    await loadUsers();
    toast(`${email} added as ${role === 'superuser' ? 'an administrator' : 'a user'}.`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Config load and app start ─────────────────────────────────────────────────

/** Re-read config after an admin change so banners and the brief button stay accurate. */
async function refreshConfig() {
  try {
    const cfg = await api('/api/config');
    CONFIG = cfg;
    FIELDS = cfg.fields ?? {};
    applyStatusUi(cfg);
  } catch { /* the next page load will catch up */ }
}

function applyStatusUi(cfg) {
  const isAdmin = cfg.user.role === 'superuser';
  document.getElementById('ghl-banner').classList.toggle('hidden', !(isAdmin && !cfg.integrations.ghl));
  const missing = cfg.fieldsMissing ?? [];
  document.getElementById('fields-banner').classList.toggle('hidden', !(isAdmin && cfg.integrations.ghl && missing.length));
  if (missing.length) {
    document.getElementById('fields-banner-text').textContent =
      `${missing.length} Growably field${missing.length === 1 ? ' is' : 's are'} missing (${missing.join(', ')}), so parts of each enrichment cannot be saved.`;
  }
  document.getElementById('sync-label').textContent = cfg.integrations.ghl ? 'Connected to Growably' : 'Growably not connected';
  document.getElementById('sync-dot').classList.toggle('sync-dot-off', !cfg.integrations.ghl);

  const briefBtn = document.getElementById('brief-btn');
  const hint = document.getElementById('brief-hint');
  briefBtn.disabled = !cfg.ai.configured;
  hint.classList.toggle('hidden', cfg.ai.configured);
  hint.textContent = isAdmin
    ? 'Add an AI provider under Settings, Integrations to generate briefs.'
    : 'Briefs are off until an administrator adds an AI provider under Settings.';
}

async function init() {
  let res, cfg;
  try {
    res = await fetch(`${API_BASE}/api/config`);
    cfg = await res.json().catch(() => null);
  } catch (e) {
    toast(`Cannot reach the API: ${e.message}`, 'error');
    return;
  }
  if (res.status === 401) {
    showAccessScreen(cfg?.reason === 'access_not_configured' ? 'not_configured' : 'unauthorized');
    return;
  }
  if (!res.ok) { toast(cfg?.error ?? `HTTP ${res.status}`, 'error'); return; }
  if (cfg.accessConfigured === false) { showAccessScreen('not_configured'); return; }

  CONFIG = cfg;
  FIELDS = cfg.fields ?? {};
  applyBranding(cfg.branding);
  currentUserEmail = cfg.user.email;
  currentUserRole  = cfg.user.role;
  renderProfile(cfg.user);

  if (cfg.setupRequired) { showSetupScreen(cfg); return; }

  if (cfg.user.role === 'superuser') {
    document.getElementById('nav-bulk').classList.remove('hidden');
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
  applyStatusUi(cfg);
  document.getElementById('fields-banner-btn').addEventListener('click', goToSettings);
  document.getElementById('ghl-banner-btn').addEventListener('click', goToSettings);
  pollBulkStatus();
}

init();

// ── Navigation ────────────────────────────────────────────────────────────────
// Toggle between "single" and "bulk" views by swapping .active classes.
// The topbar title updates to match the active view.

const VIEW_TITLES = { add: 'Add Contact', single: 'Enrich Contact', bulk: 'Bulk Enrich', settings: 'Settings' };

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.dataset.view) return; // skip buttons without a view (e.g. profile menu)
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    document.getElementById('topbar-title').textContent = VIEW_TITLES[btn.dataset.view] ?? '';
    if (btn.dataset.view === 'bulk') pollBulkStatus();
    // Sync the dark mode toggle and reload users when the settings view opens
    if (btn.dataset.view === 'settings') {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.getElementById('dark-mode-toggle').setAttribute('aria-checked', String(isDark));
      if (currentUserRole === "superuser") { loadUsers(); loadIntegrations(); loadFieldStatus(); loadBriefProfile(); loadBrandingForm(); }
    }
  });
});

// ── Add Contact ───────────────────────────────────────────────────────────────

async function doAddContact() {
  const email = document.getElementById('add-contact-email').value.trim();
  if (!email) return;

  const btn      = document.getElementById('add-contact-btn');
  const resultEl = document.getElementById('add-contact-result');
  const inner    = document.getElementById('add-contact-result-inner');

  btn.innerHTML = '<span class="spinner"></span> Adding…';
  btn.disabled  = true;
  resultEl.classList.add('hidden');

  const dot       = document.querySelector('.sync-dot');
  const syncLabel = document.getElementById('sync-label');
  dot.classList.add('syncing');
  syncLabel.textContent = 'Adding contact…';

  try {
    const res = await fetch(`${API_BASE}/api/add-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (res.status === 409 && data.duplicate) {
      const c = data.contact;
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.email;
      inner.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <div class="contact-avatar" style="width:40px;height:40px;font-size:15px">
            ${((c.firstName?.[0] ?? '') + (c.lastName?.[0] ?? '')).toUpperCase() || c.email[0].toUpperCase()}
          </div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--color-black)">${name}</div>
            <div style="font-size:12px;color:var(--color-gray-text);margin-top:2px">${c.email}</div>
          </div>
          <span class="status-pill pill-partial" style="margin-left:auto">Already exists</span>
        </div>
        <div style="margin-top:14px">
          <button id="enrich-duplicate-btn" class="btn btn-primary">Enrich this contact instead?</button>
        </div>`;
      resultEl.classList.remove('hidden');
      toast('Contact already exists in Growably.', 'info');

      document.getElementById('enrich-duplicate-btn').addEventListener('click', async () => {
        const enrichBtn = document.getElementById('enrich-duplicate-btn');
        enrichBtn.innerHTML = '<span class="spinner"></span> Enriching…';
        enrichBtn.disabled = true;
        try {
          const er = await fetch(`${API_BASE}/api/enrich/${c.id}`, { method: 'POST' });
          const { success, result, error } = await er.json();
          if (!success) throw new Error(error ?? 'Unknown error');
          const found = result.found ?? {};
          const FIELD_LABELS = {
            firstName: 'First Name', lastName: 'Last Name', linkedinUrl: 'LinkedIn',
            jobTitle: 'Job Title', emailStatus: 'Email Status', numEmployees: 'Employees',
            mobilePhone: 'Mobile', website: 'Website', twitter: 'Twitter / X',
            companyDomain: 'Company Domain', sectorTag: 'Sector', city: 'City',
            address1: 'Address', companyName: 'Company', companyPhone: 'Company Phone',
          };
          const foundKeys   = Object.keys(FIELD_LABELS).filter(k => found[k]);
          const missingKeys = Object.keys(FIELD_LABELS).filter(k => !found[k] && !(k === 'mobilePhone' && found.phonePending));
          enrichBtn.outerHTML = `
            <div class="found-tags" style="margin-top:4px">
              ${foundKeys.map(k => `<span class="tag-found">${FIELD_LABELS[k]}</span>`).join('')}
              ${found.phonePending && !found.mobilePhone ? `<span class="tag-pending">Mobile: arriving</span>` : ''}
              ${missingKeys.map(k => `<span class="tag-missing">${FIELD_LABELS[k]} not found</span>`).join('')}
            </div>`;
          toast('Contact enriched and synced to Growably.', 'success');
        } catch (e) {
          enrichBtn.textContent = 'Enrich this contact instead?';
          enrichBtn.disabled = false;
          toast(`Enrichment failed: ${e.message}`, 'error');
        }
      });
      return;
    }

    const { success, contact, result, error } = data;
    if (!success) throw new Error(error ?? 'Unknown error');

    const found = result.found ?? {};
    const FIELD_LABELS = {
      firstName:     'First Name',
      lastName:      'Last Name',
      linkedinUrl:   'LinkedIn',
      jobTitle:      'Job Title',
      emailStatus:   'Email Status',
      numEmployees:  'Employees',
      mobilePhone:   'Mobile',
      website:       'Website',
      twitter:       'Twitter / X',
      companyDomain: 'Company Domain',
      sectorTag:     'Sector',
      city:          'City',
      address1:      'Address',
      companyName:   'Company',
      companyPhone:  'Company Phone',
    };

    const foundKeys   = Object.keys(FIELD_LABELS).filter(k => found[k]);
    const missingKeys = Object.keys(FIELD_LABELS).filter(k => !found[k] && !(k === 'mobilePhone' && found.phonePending));
    const name        = result.name || email;

    inner.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <div class="contact-avatar" style="width:40px;height:40px;font-size:15px">
          ${((found.firstName?.[0] ?? '') + (found.lastName?.[0] ?? '')).toUpperCase() || email[0].toUpperCase()}
        </div>
        <div>
          <div style="font-size:16px;font-weight:600;color:var(--color-black)">${name}</div>
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-gray-text)">${contact.id}</div>
        </div>
        <span class="status-pill pill-enriched" style="margin-left:auto">Created &amp; Enriched</span>
      </div>
      <div class="found-tags">
        ${foundKeys.map(k => `<span class="tag-found">${FIELD_LABELS[k]}</span>`).join('')}
        ${found.phonePending && !found.mobilePhone ? `<span class="tag-pending">Mobile: arriving</span>` : ''}
        ${missingKeys.map(k => `<span class="tag-missing">${FIELD_LABELS[k]} not found</span>`).join('')}
      </div>
      ${result.errors?.length ? `<p style="margin-top:12px;font-size:12px;color:var(--color-gray-text)">Non-fatal errors: ${result.errors.join('; ')}</p>` : ''}`;

    resultEl.classList.remove('hidden');
    document.getElementById('add-contact-email').value = '';
    toast(`${name} added and enriched in Growably.`, 'success');
  } catch (e) {
    inner.innerHTML = `<p style="color:var(--color-error);font-size:14px">${e.message}</p>`;
    resultEl.classList.remove('hidden');
    toast(e.message, 'error');
  } finally {
    btn.textContent = 'Add & Enrich';
    btn.disabled    = false;
    dot.classList.remove('syncing');
    syncLabel.textContent = CONFIG?.integrations?.ghl === false ? "Growably not connected" : "Connected to Growably";
  }
}

document.getElementById('add-contact-btn').addEventListener('click', doAddContact);
document.getElementById('add-contact-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') doAddContact();
});

// ── Search ────────────────────────────────────────────────────────────────────

/** The currently selected contact - used by enrich and brief handlers. */
let selectedContact = null;

/** Call the worker search API and render the results list. */
async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;

  const btn = document.getElementById('search-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`);
    const { contacts, error } = await res.json();
    if (error) throw new Error(error);
    renderResults(contacts ?? []);
  } catch (e) {
    renderResults([], e.message);
  } finally {
    btn.textContent = 'Search';
    btn.disabled = false;
  }
}

/**
 * Render the list of search results.
 * Each row shows: avatar initials, name, email + company, enrichment status pill.
 * Clicking a row calls selectContact() to load the full contact panel.
 */
function renderResults(contacts, error) {
  const el = document.getElementById('search-results');
  document.getElementById('contact-panel').classList.add('hidden');

  if (error) {
    el.innerHTML = `<div class="empty-state" style="color:var(--color-error)">${error}</div>`;
    el.classList.remove('hidden');
    return;
  }

  if (!contacts.length) {
    el.innerHTML = `<div class="empty-state">No contacts found. Try a different name or email address.</div>`;
    el.classList.remove('hidden');
    return;
  }

  el.innerHTML = contacts.map(c => {
    const status = enrichStatus(c);
    return `
      <div class="result-row" data-id="${c.id}" tabindex="0" role="button">
        <div class="result-avatar">${initials(c)}</div>
        <div class="result-info">
          <div class="result-name">${c.firstName ?? ''} ${c.lastName ?? ''}</div>
          <div class="result-sub">${[c.email, c.companyName].filter(Boolean).join(' · ')}</div>
        </div>
        <span class="status-pill ${status.cls}">${status.label}</span>
      </div>`;
  }).join('');

  el.classList.remove('hidden');

  el.querySelectorAll('.result-row').forEach(row => {
    const handler = () => {
      const contact = contacts.find(c => c.id === row.dataset.id);
      if (contact) selectContact(contact);
    };
    row.addEventListener('click', handler);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
  });
}

/** Load a contact into the detail panel and render the field diff table. */
function selectContact(contact) {
  selectedContact = contact;
  document.getElementById('search-results').classList.add('hidden');

  document.getElementById('contact-avatar').textContent = initials(contact);
  document.getElementById('contact-name').textContent =
    `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
  document.getElementById('contact-id').textContent = contact.id;

  const status = enrichStatus(contact);
  const pill = document.getElementById('contact-status-pill');
  pill.className = `status-pill ${status.cls}`;
  pill.textContent = status.label;

  // Show current values with empty enriched column - diff will fill in after enrichment
  renderFieldTable(contact, {});
  document.getElementById('enrich-result').classList.add('hidden');
  document.getElementById('contact-panel').classList.remove('hidden');
}

// ── Field table renderers ─────────────────────────────────────────────────────

/** SVG icon appended to link values - opens the link in a new tab. */
const EXT_ICON = `<svg class="ext-link-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

/**
 * Render a URL value as a readable label with an external-link icon.
 * Strips noise from known platforms:
 *   LinkedIn  → "linkedin.com/in/username"
 *   Twitter/X → "@handle"
 *   Facebook  → "facebook.com/pagename"
 *   Instagram → "instagram.com/handle"
 *   Other     → hostname + path (strips www.)
 */
function renderLinkValue(value) {
  try {
    const u = new URL(value);
    let label = value;
    if (u.hostname.includes('linkedin.com')) {
      const slug = u.pathname.split('/').filter(Boolean)[1];
      label = slug ? `linkedin.com/in/${slug}` : 'linkedin.com';
    } else if (u.hostname.includes('twitter.com') || u.hostname.includes('x.com')) {
      const handle = u.pathname.split('/').filter(Boolean)[0];
      label = handle ? `@${handle}` : u.hostname;
    } else if (u.hostname.includes('facebook.com')) {
      const slug = u.pathname.split('/').filter(Boolean)[0];
      label = slug ? `facebook.com/${slug}` : 'facebook.com';
    } else if (u.hostname.includes('instagram.com')) {
      const slug = u.pathname.split('/').filter(Boolean)[0];
      label = slug ? `instagram.com/${slug}` : 'instagram.com';
    } else {
      label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
    }
    return `<a href="${value}" target="_blank" rel="noopener" class="link-value">${label}${EXT_ICON}</a>`;
  } catch {
    return `<a href="${value}" target="_blank" rel="noopener" class="link-value">${value}${EXT_ICON}</a>`;
  }
}

/**
 * Colour-coded badge for email validation results.
 * Green  → valid (safe to email)
 * Amber  → catch-all or unknown (deliverability uncertain)
 * Red    → invalid or do-not-mail (the worker also sets email DND in Growably)
 */
const EMAIL_STATUS_META = {
  valid:        { cls: 'es-valid',   label: 'Valid' },
  'catch-all':  { cls: 'es-warning', label: 'Catch-all' },
  unknown:      { cls: 'es-warning', label: 'Unknown' },
  invalid:      { cls: 'es-invalid', label: 'Invalid' },
  'do-not-mail':{ cls: 'es-invalid', label: 'Do not mail' },
};

function renderEmailStatus(value) {
  if (!value) return null;
  const meta = EMAIL_STATUS_META[value] ?? { cls: 'es-warning', label: value };
  return `<span class="email-status-badge ${meta.cls}">${meta.label}</span>`;
}

/**
 * Render the field diff table showing current Growably values vs enriched values.
 *
 * newValues is a dict of { fieldName: enrichedValue } populated after a successful
 * enrichment API call. Before enrichment, newValues is {}, so both columns show
 * the current value (or em-dash if empty).
 *
 * Cells with a new enriched value highlight in green with a "via web search" source note.
 * Special renderers apply for link fields (renderLinkValue) and email status (renderEmailStatus).
 */
/**
 * Holds the most recent enrichment delta for the selected contact, so Apply
 * button clicks can mutate it (and re-render) without losing other rows.
 */
let lastEnrichmentSuggested = {};

function renderFieldTable(contact, newValues, suggestedValues = {}) {
  lastEnrichmentSuggested = suggestedValues;

  const tbody = document.getElementById('fields-tbody');
  tbody.innerHTML = fieldRows(contact).map(row => {
    const enriched = newValues[row.name];
    const current  = row.value;
    const isNew    = enriched && enriched !== current;

    // Collect suggestions for this row (one row may map to multiple suggestion keys, e.g. Address)
    const applyKeys = row.applyKeys ?? [];
    const rowSuggestions = {};
    for (const k of applyKeys) {
      if (suggestedValues[k]) rowSuggestions[k] = suggestedValues[k];
    }
    const hasSuggestion = Object.keys(rowSuggestions).length > 0;

    const formatValue = (val) => {
      if (row.emailStatus) return renderEmailStatus(val) ?? val;
      if (row.link)        return renderLinkValue(val);
      return val;
    };

    let currentCell = current
      ? `<span class="td-current">${formatValue(current)}</span>`
      : `<span class="td-current empty">—</span>`;

    let enrichedCell;
    if (hasSuggestion) {
      // Build the suggested display value. For composite Address, merge suggested
      // and current pieces so the operator sees the full proposed address.
      let display;
      if (row.composite === 'address') {
        display = [
          rowSuggestions.address1   ?? contact.address1,
          rowSuggestions.city       ?? contact.city,
          rowSuggestions.state      ?? contact.state,
          rowSuggestions.postalCode ?? contact.postalCode,
          rowSuggestions.country    ?? contact.country,
        ].filter(Boolean).join(', ');
      } else {
        display = formatValue(Object.values(rowSuggestions)[0]);
      }
      const fieldsAttr = encodeURIComponent(JSON.stringify(rowSuggestions));
      enrichedCell = `
        <span class="td-suggested">
          ${display}
          <button class="btn-apply" data-fields="${fieldsAttr}">Overwrite</button>
          <span class="field-source">currently differs · click to apply</span>
        </span>`;
    } else if (isNew) {
      enrichedCell = `<span class="td-enriched">${formatValue(enriched)}<span class="field-source">via web search · just now</span></span>`;
    } else if (current) {
      enrichedCell = `<span class="td-enriched no-change">${formatValue(current)}</span>`;
    } else {
      enrichedCell = `<span class="td-enriched empty">—</span>`;
    }

    return `
      <tr>
        <td class="td-field-name">${row.name}</td>
        <td>${currentCell}</td>
        <td>${enrichedCell}</td>
      </tr>`;
  }).join('');

  // Wire up Apply buttons. Each button knows the full set of suggestion keys
  // for its row (e.g. all five address parts).
  tbody.querySelectorAll('.btn-apply').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fields = JSON.parse(decodeURIComponent(btn.dataset.fields));
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/contact/${selectedContact.id}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
        });
        const { success, error } = await res.json();
        if (!success) throw new Error(error ?? 'Unknown error');

        // Refresh the contact from Growably so the table reflects what was actually written
        const updated = await fetch(`${API_BASE}/api/contact/${selectedContact.id}`);
        const { contact: refreshed } = await updated.json();
        if (refreshed) selectedContact = refreshed;

        // Drop the keys we just applied so they don't reappear as suggestions
        for (const k of Object.keys(fields)) delete lastEnrichmentSuggested[k];
        renderFieldTable(selectedContact, newValues, lastEnrichmentSuggested);
        toast('Field overwritten in Growably.', 'success');
      } catch (e) {
        btn.textContent = 'Overwrite';
        btn.disabled = false;
        toast(`Apply failed: ${e.message}`, 'error');
      }
    });
  });
}

const logoHome = document.getElementById('logo-home');
logoHome.addEventListener('click', () => document.querySelector('[data-view="single"]').click());
logoHome.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') document.querySelector('[data-view="single"]').click(); });

document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

// ── Enrich single contact ─────────────────────────────────────────────────────

/**
 * Call the worker enrich API for the selected contact, then:
 *   1. Re-fetch the updated contact from Growably (so the table shows committed values)
 *   2. Re-render the field table with the enriched diff highlighted
 *   3. Show a summary of found/missing fields
 */
document.getElementById('enrich-btn').addEventListener('click', async () => {
  if (!selectedContact) return;

  const btn = document.getElementById('enrich-btn');
  btn.innerHTML = '<span class="spinner"></span> Enriching…';
  btn.disabled = true;

  const dot = document.querySelector('.sync-dot');
  const syncLabel = document.getElementById('sync-label');
  dot.classList.add('syncing');
  syncLabel.textContent = 'Enriching…';

  const resultEl = document.getElementById('enrich-result');
  resultEl.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/enrich/${selectedContact.id}`, { method: 'POST' });
    const { success, result, error } = await res.json();
    if (!success) throw new Error(error ?? 'Unknown error');

    const found = result.found ?? {};

    // Map worker `found` keys to the field row names used in the diff table
    const newValues = {
      'LinkedIn':      found.linkedinUrl    ?? null,
      'Job Title':     found.jobTitle       ?? null,
      'Email Status':  found.emailStatus    ?? null,
      'Employees':     found.numEmployees   ? String(found.numEmployees) : null,
      'Mobile':        found.mobilePhone    ?? null,
      'Website':       found.website        ?? null,
      'Twitter / X':   found.twitter        ?? null,
      'Company Domain':found.companyDomain  ?? null,
      'Address':       found.address1       ?? null,
    };

    // Re-fetch the contact so the table reflects what was actually written to Growably,
    // not just what the worker returned (they can diverge if Growably rejected a field)
    try {
      const updated = await fetch(`${API_BASE}/api/contact/${selectedContact.id}`);
      const { contact } = await updated.json();
      if (contact) {
        selectedContact = contact;
        const status = enrichStatus(contact);
        const pill = document.getElementById('contact-status-pill');
        pill.className = `status-pill ${status.cls}`;
        pill.textContent = status.label;
      }
    } catch (_) {}

    renderFieldTable(selectedContact, newValues, result.suggested ?? {});

    // Human-readable labels for the found/missing summary tags
    const FIELD_LABELS = {
      linkedinUrl:   'LinkedIn',
      jobTitle:      'Job Title',
      emailStatus:   'Email Status',
      numEmployees:  'Employees',
      mobilePhone:   'Mobile',
      website:       'Website',
      twitter:       'Twitter / X',
      companyDomain: 'Company Domain',
      sectorTag:     'Sector',
      city:          'City',
      address1:      'Address',
      companyName:   'Company',
      companyPhone:  'Company Phone',
    };

    const allKeys     = Object.keys(FIELD_LABELS);
    const missingKeys = allKeys.filter(k => !found[k] && !(k === 'mobilePhone' && found.phonePending));

    resultEl.className = 'enrich-result enrich-result-success';
    resultEl.innerHTML = `
      <h3>Enrichment complete</h3>
      <div class="found-tags">
        ${allKeys.filter(k => found[k]).map(k => `<span class="tag-found">${FIELD_LABELS[k]}</span>`).join('')}
        ${found.phonePending && !found.mobilePhone ? `<span class="tag-pending">Mobile: arriving</span>` : ''}
        ${missingKeys.map(k => `<span class="tag-missing">${FIELD_LABELS[k]} not found</span>`).join('')}
      </div>`;
    resultEl.classList.remove('hidden');

    toast('Contact enriched and synced to Growably.', 'success');

  } catch (e) {
    resultEl.className = 'enrich-result enrich-result-error';
    resultEl.innerHTML = `<h3>Enrichment failed</h3><p style="font-size:13px;color:var(--color-gray-text)">${e.message}</p>`;
    resultEl.classList.remove('hidden');
    toast(e.message, 'error');
  } finally {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Enrich now`;
    btn.disabled = false;
    dot.classList.remove('syncing');
    syncLabel.textContent = CONFIG?.integrations?.ghl === false ? "Growably not connected" : "Connected to Growably";
  }
});

// ── Nurture ───────────────────────────────────────────────────────────────

document.getElementById('nurture-btn').addEventListener('click', async () => {
  if (!selectedContact) return;

  const btn = document.getElementById('nurture-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/nurture/${selectedContact.id}`, { method: 'POST' });
    const { success, error } = await res.json();
    if (!success) throw new Error(error ?? 'Unknown error');
    toast('Nurture tag added in Growably.', 'success');
  } catch (e) {
    toast(`Nurture failed: ${e.message}`, 'error');
  } finally {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      Nurture`;
    btn.disabled = false;
  }
});

// ── Generate Brief ────────────────────────────────────────────────────────────

const briefModal     = document.getElementById('brief-modal');
const briefModalBody = document.getElementById('brief-modal-body');

function openBriefModal(text, name) {
  briefModalBody.textContent = text;
  briefModalBody.scrollTop = 0;
  document.getElementById('brief-modal-title').textContent =
    name ? `Sales brief - ${name}` : 'Sales brief';
  briefModal.showModal();
}

document.getElementById('brief-modal-close').addEventListener('click', () => {
  briefModal.close();
});

// Clicking the backdrop closes the modal
briefModal.addEventListener('click', (e) => {
  if (e.target === briefModal) briefModal.close();
});

document.getElementById('brief-modal-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(briefModalBody.textContent);
    toast('Brief copied to clipboard.', 'success');
  } catch {
    toast('Copy failed - select the text manually.', 'error');
  }
});

/**
 * Post meeting options to the worker brief API.
 * The worker runs 5+ parallel Brave searches + MX lookup + Claude Opus 5,
 * then saves the finished brief as a Growably note on the contact.
 * This typically takes 5–10 seconds.
 */
document.getElementById('brief-btn').addEventListener('click', async () => {
  if (!selectedContact) return;

  const btn = document.getElementById('brief-btn');
  btn.innerHTML = '<span class="spinner"></span> Generating…';
  btn.disabled = true;

  const dot       = document.querySelector('.sync-dot');
  const syncLabel = document.getElementById('sync-label');
  dot.classList.add('syncing');
  syncLabel.textContent = 'Generating brief…';

  try {
    const res = await fetch(`${API_BASE}/api/brief/${selectedContact.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingDate:  document.getElementById('brief-date').value  || '',
        meetingStage: document.getElementById('brief-stage').value || 'first meeting',
        focusNotes:   document.getElementById('brief-focus').value || '',
      }),
    });
    const { success, result, error } = await res.json();
    if (!success) throw new Error(error ?? 'Unknown error');
    if (result?.brief) openBriefModal(result.brief, result.name);
    toast('Sales brief saved to the contact notes in Growably.', 'success');
  } catch (e) {
    toast(`Brief failed: ${e.message}`, 'error');
  } finally {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
      Generate Brief`;
    btn.disabled = false;
    dot.classList.remove('syncing');
    syncLabel.textContent = CONFIG?.integrations?.ghl === false ? "Growably not connected" : "Connected to Growably";
  }
});

// ── Bulk enrichment ───────────────────────────────────────────────────────────

/**
 * Poll interval reference - stored so we can clear it when the job stops.
 * Polling runs every 15 seconds while a job is running.
 */
let bulkPollInterval = null;

/** Last job state seen by updateBulkUI - used to decide resume vs fresh start. */
let lastBulkJob = null;

/** Read the scope picker. Returns a filter object, null for "all", or throws on bad input. */
function getSelectedBulkFilter() {
  const mode = document.querySelector('input[name="bulk-scope"]:checked')?.value ?? 'all';
  if (mode === 'since') {
    const since = document.getElementById('bulk-since-date').value;
    if (!since) throw new Error('Pick a date for "Created since".');
    return { type: 'since', since };
  }
  if (mode === 'tag') {
    const tag = document.getElementById('bulk-tag-input').value.trim();
    if (!tag) throw new Error('Enter a tag name for "With tag".');
    return { type: 'tag', tag };
  }
  return null;
}

/** Human-readable description of a job's filter for status lines. */
function describeBulkFilter(filter) {
  if (!filter) return 'all contacts';
  // The filter date is UTC midnight - render the UTC date so it doesn't shift back a day locally
  if (filter.type === 'since') return `contacts created since ${new Date(filter.since).toLocaleDateString(undefined, { timeZone: 'UTC' })}`;
  if (filter.type === 'tag')   return `contacts tagged "${filter.tag}"`;
  return 'all contacts';
}

// Enable/disable the date and tag inputs to match the selected scope radio
document.querySelectorAll('input[name="bulk-scope"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const mode = document.querySelector('input[name="bulk-scope"]:checked')?.value;
    document.getElementById('bulk-since-date').disabled = mode !== 'since';
    document.getElementById('bulk-tag-input').disabled  = mode !== 'tag';
  });
});

/** Fetch the current bulk job state from the worker and update the UI. */
async function pollBulkStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/bulk/status`);
    const { job } = await res.json();
    updateBulkUI(job);
  } catch (e) {
    document.getElementById('bulk-status-note').textContent = `Cannot reach API: ${e.message}`;
  }
}

/**
 * Update the bulk enrichment view based on current job state.
 * States: null (never started), running, paused, complete, error.
 * Progress bar and stat counters update on every poll.
 */
function updateBulkUI(job) {
  lastBulkJob = job;
  const startBtn = document.getElementById('bulk-start-btn');
  const pauseBtn = document.getElementById('bulk-pause-btn');
  const note     = document.getElementById('bulk-status-note');

  // Scope picker is only editable when no job is active - a paused job resumes
  // with its original scope, so changing the picker mid-job would be misleading
  const scopeLocked = job?.status === 'running' || job?.status === 'paused';
  document.querySelectorAll('#bulk-scope input').forEach(el => {
    if (el.type === 'radio') el.disabled = scopeLocked;
  });
  const mode = document.querySelector('input[name="bulk-scope"]:checked')?.value;
  document.getElementById('bulk-since-date').disabled = scopeLocked || mode !== 'since';
  document.getElementById('bulk-tag-input').disabled  = scopeLocked || mode !== 'tag';

  document.getElementById('stat-processed').textContent = job?.processed ?? '—';
  document.getElementById('stat-succeeded').textContent = job?.succeeded ?? '—';
  document.getElementById('stat-failed').textContent    = job?.failed    ?? '—';
  document.getElementById('stat-total').textContent     = job?.total     ?? '—';

  const pct = job?.total ? Math.round((job.processed / job.total) * 100) : 0;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = job?.total
    ? `${pct}% complete - ${job.processed.toLocaleString()} of ${job.total.toLocaleString()} contacts`
    : 'Not started';

  // Clear any existing poll interval before potentially starting a new one
  clearInterval(bulkPollInterval);
  bulkPollInterval = null;

  if (!job || job.status === 'complete' || job.status === 'error') {
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    startBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      ${job?.status === 'complete' ? 'Re-run bulk enrichment' : 'Start bulk enrichment'}`;
    if (job?.status === 'complete') note.textContent = `Completed ${new Date(job.completedAt).toLocaleString()} (${describeBulkFilter(job.filter)})`;
    if (job?.status === 'error')    note.textContent = `Stopped with error: ${job.error}`;

  } else if (job.status === 'running') {
    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    note.textContent = `Running on ${describeBulkFilter(job.filter)}. The worker processes a batch every 5 minutes automatically.`;
    // Poll every 15s while running so progress bar stays current
    bulkPollInterval = setInterval(pollBulkStatus, 15000);

  } else if (job.status === 'paused') {
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    startBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Resume bulk enrichment`;
    note.textContent = `Paused at ${(job.processed ?? 0).toLocaleString()} of ${(job.total ?? 0).toLocaleString()} contacts (${describeBulkFilter(job.filter)}). Resume picks up where it left off.`;
  }
}

document.getElementById('bulk-start-btn').addEventListener('click', async () => {
  const btn = document.getElementById('bulk-start-btn');

  // A paused job resumes as-is; a fresh start sends the selected scope
  let body = {};
  if (lastBulkJob?.status !== 'paused') {
    try {
      body = { filter: getSelectedBulkFilter(), restart: true };
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
  }

  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  try {
    const res  = await fetch(`${API_BASE}/api/bulk/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await pollBulkStatus();
    toast(data.message ?? 'Bulk enrichment started.', 'info');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('bulk-pause-btn').addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/bulk/pause`, { method: 'POST' });
  await pollBulkStatus();
  toast('Bulk enrichment paused.', 'info');
});

