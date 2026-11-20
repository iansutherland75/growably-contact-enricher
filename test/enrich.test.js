// A whole enrichment with Growably, Apollo, Brave and the company site stubbed. Run with: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enrichContact } from '../src/enrich.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const env = () => ({
  GHL_API_KEY: 'k', GHL_LOCATION_ID: 'loc', APOLLO_API_KEY: 'a', BRAVE_API_KEY: 'b', WORKER_URL: 'https://enrich.test',
  ENRICH_KV: { get: async () => null, put: async () => {} },
});

// routes: { apollo(body), brave(query), site(url) } each returning a JSON body (site: HTML).
function stub({ apollo = () => ({}), brave = () => ({ web: { results: [] } }), site = () => '' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/customFields')) return json({ customFields: [{ id: 'f-title', fieldKey: 'contact.job_title' }, { id: 'f-li', fieldKey: 'contact.linkedin_url' }] });
    if (u.includes('leadconnectorhq.com')) return json({});
    if (u.includes('api.apollo.io')) return json(apollo(JSON.parse(init.body)));
    if (u.includes('api.search.brave.com')) return json(brave(new URL(u).searchParams.get('q')));
    return new Response(site(u), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return calls;
}

const braveQueries = (calls) => calls.filter(c => c.url.includes('brave.com')).map(c => new URL(c.url).searchParams.get('q'));

test('a job title ends at the word "at", not at the letters a-t inside a word', async () => {
  stub({ brave: (q) => (q.includes('LinkedIn')
    ? { web: { results: [{ url: 'https://www.linkedin.com/in/jane-doe', title: 'Jane Doe - Chief Strategy Officer at Acme | LinkedIn' }] } }
    : { web: { results: [] } }) });
  const r = await enrichContact({ id: 'c1', email: 'jane@acme.ca', firstName: 'Jane', lastName: 'Doe' }, env());
  assert.equal(r.found.jobTitle, 'Chief Strategy Officer');
});

test("Apollo's name fills a contact with none, and the searches and the result use it", async () => {
  const calls = stub({ apollo: () => ({ person: { first_name: 'Dana', last_name: 'Marks' } }) });
  const r = await enrichContact({ id: 'c2', email: 'info@acme.ca' }, env());
  assert.equal(r.name, 'Dana Marks');
  assert.ok(braveQueries(calls).some(q => q.startsWith('"Dana Marks"') && q.includes('LinkedIn')), braveQueries(calls).join(' / '));
});

test('with no name found, the LinkedIn and Twitter searches are skipped', async () => {
  const calls = stub();
  const r = await enrichContact({ id: 'c3', email: 'info@acme.ca' }, env());
  assert.equal(r.found.linkedinUrl, undefined);
  assert.ok(!braveQueries(calls).some(q => q.includes('LinkedIn') || q.includes('twitter.com')));
});

test("the company site wins over Apollo: a site value that matches the contact clears Apollo's suggestion", async () => {
  const schema = JSON.stringify({ '@type': 'Organization', name: 'Acme', address: { addressRegion: 'BC', addressCountry: 'CA' } });
  stub({
    apollo: () => ({ person: { organization: { state: 'Alberta' } } }),
    site: () => `<html><script type="application/ld+json">${schema}</script></html>`,
  });
  const r = await enrichContact({ id: 'c4', email: 'jo.ray@acme.ca', firstName: 'Jo', lastName: 'Ray', state: 'BC' }, env());
  assert.equal(r.suggested.state, undefined);
});
