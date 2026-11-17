// Checks for the fixes ported from contact-enricher (2026-11-17). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { northAmericanPhone, parseSchemaOrg, needsNormalization, jobTitleFrom } from '../src/enrich.js';

const ld = (...blocks) => blocks.map(b => `<script type="application/ld+json">${b}</script>`).join('');

test('Schema.org phones with the North American shape become +1', () => {
  assert.equal(northAmericanPhone('604-555-0100'), '+16045550100');
  assert.equal(northAmericanPhone('Tel: (604) 555-0100 ext. 12'), '+16045550100');
  assert.equal(northAmericanPhone('+1 604 555 0100 / 604 555 0199'), '+16045550100');
  assert.equal(northAmericanPhone('+442079460958'), null);
  assert.equal(northAmericanPhone('98765 43210'), null);
  assert.equal(northAmericanPhone(' '.repeat(80) + '6045550100'), null);
});

test('a Schema.org phone stays as printed when the site is in another country', () => {
  const uk = ld(JSON.stringify({ '@graph': [
    { '@type': 'Organization', telephone: '020 7946 0958' },
    { '@type': 'LocalBusiness', address: { addressCountry: 'United Kingdom' } },
  ] }));
  assert.equal(parseSchemaOrg(uk, 'example.co.uk').phone, '020 7946 0958');
  const ca = ld(JSON.stringify({ '@type': 'Organization', telephone: '604.555.0100' }));
  assert.equal(parseSchemaOrg(ca, 'example.ca').phone, '+16045550100');
});

test('one odd JSON-LD block does not stop the rest', () => {
  const html = ld('null', '42', JSON.stringify([null, { '@type': 7 }, { '@type': 'Organization', name: { x: 1 } }]),
    JSON.stringify({ '@type': ['Organization'], name: 'Acme Dental', url: 'https://www.acme.ca/' }));
  const result = parseSchemaOrg(html, 'acme.ca');
  assert.equal(result.companyName, 'Acme Dental');
  assert.equal(result.website, 'https://www.acme.ca/');
});

test('only ALL CAPS or all lowercase names are re-cased', () => {
  assert.equal(needsNormalization('DeSouza'), false);
  assert.equal(needsNormalization('LeBlanc'), false);
  assert.equal(needsNormalization('JANE'), true);
  assert.equal(needsNormalization('jane'), true);
  assert.equal(needsNormalization('Jane'), false);
});

test('the job title comes from the accepted LinkedIn result only', () => {
  const accepted = { url: 'https://www.linkedin.com/in/jane-nguyen', description: 'Jane Nguyen - Office Manager at Acme | LinkedIn' };
  assert.equal(jobTitleFrom(accepted, 'Jane Nguyen'), 'Office Manager');
  assert.equal(jobTitleFrom({ description: 'nothing useful here' }, 'Jane (Nguyen)'), null);
});

test('an addressCountry object with no name gives no country', () => {
  const html = ld(JSON.stringify({ '@type': 'Organization', telephone: '604-555-0100',
    address: { addressCountry: { '@type': 'Country' } } }));
  const result = parseSchemaOrg(html, 'example.ca');
  assert.equal(result.country, undefined);
  assert.equal(result.phone, '+16045550100');
});
