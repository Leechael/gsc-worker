/**
 * Caller-supplied site URLs must resolve to one Search Console property.
 * Properties that share a host stay distinct unless the input is a bare
 * domain and one of the fixed fallbacks exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSiteUrl,
  resolveSiteUrl,
  rewriteRequestSiteUrl,
  sameProperty,
} from '../src/lib/site-url.js';

const listed = [
  'sc-domain:example.com',
  'https://example.com/',
  'http://example.com/',
  'https://example.com/blog/',
  'https://example.com/Blog/',
];

test('parseSiteUrl keeps property type, scheme, host case-folding, and path case', () => {
  assert.deepEqual(parseSiteUrl('sc-domain:EXAMPLE.com'), { form: 'domain', raw: 'sc-domain:EXAMPLE.com', host: 'example.com' });
  assert.deepEqual(parseSiteUrl('https://EXAMPLE.com/Blog'), {
    form: 'url-prefix',
    raw: 'https://EXAMPLE.com/Blog',
    scheme: 'https',
    host: 'example.com',
    path: '/Blog/',
  });
  assert.deepEqual(parseSiteUrl('example.com'), { form: 'bare', raw: 'example.com', host: 'example.com' });
  assert.equal(parseSiteUrl('example.com/blog/').form, 'unknown');
});

test('resolveSiteUrl exact-matches type, scheme, host and path', () => {
  assert.deepEqual(resolveSiteUrl('sc-domain:example.com', listed), { status: 'resolved', siteUrl: 'sc-domain:example.com' });
  assert.deepEqual(resolveSiteUrl('https://example.com/', listed), { status: 'resolved', siteUrl: 'https://example.com/' });
  assert.deepEqual(resolveSiteUrl('http://example.com/', listed), { status: 'resolved', siteUrl: 'http://example.com/' });
  assert.deepEqual(resolveSiteUrl('https://example.com/blog/', listed), { status: 'resolved', siteUrl: 'https://example.com/blog/' });
  assert.deepEqual(resolveSiteUrl('https://example.com/Blog/', listed), { status: 'resolved', siteUrl: 'https://example.com/Blog/' });
});

test('URL-prefix trailing slashes and host case still exact-match the listed property', () => {
  assert.deepEqual(resolveSiteUrl('https://example.com', listed), { status: 'resolved', siteUrl: 'https://example.com/' });
  assert.deepEqual(resolveSiteUrl('https://EXAMPLE.com/blog', listed), { status: 'resolved', siteUrl: 'https://example.com/blog/' });
  assert.deepEqual(resolveSiteUrl('sc-domain:Example.com', listed), { status: 'resolved', siteUrl: 'sc-domain:example.com' });
});

test('a subdirectory never matches the URL-prefix root', () => {
  const onlyRoot = ['https://example.com/', 'http://example.com/'];
  const result = resolveSiteUrl('https://example.com/blog/', onlyRoot);
  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') {
    assert.deepEqual(result.candidates, ['https://example.com/', 'http://example.com/']);
  }
});

test('bare domains try sc-domain, then https, then http', () => {
  assert.deepEqual(resolveSiteUrl('example.com', listed), { status: 'resolved', siteUrl: 'sc-domain:example.com' });
  assert.deepEqual(resolveSiteUrl('EXAMPLE.com', ['https://example.com/', 'http://example.com/']), {
    status: 'resolved',
    siteUrl: 'https://example.com/',
  });
  assert.deepEqual(resolveSiteUrl('example.com', ['http://example.com/', 'https://example.com/blog/']), {
    status: 'resolved',
    siteUrl: 'http://example.com/',
  });
});

test('bare domains that miss the fallback order list the other host properties', () => {
  const result = resolveSiteUrl('example.com', ['https://example.com/blog/', 'https://example.com/docs/']);
  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') {
    assert.deepEqual(result.candidates, ['https://example.com/blog/', 'https://example.com/docs/']);
  }
});

test('an https input does not fall through to sc-domain or http', () => {
  const result = resolveSiteUrl('https://example.com/', ['sc-domain:example.com', 'http://example.com/']);
  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') {
    assert.deepEqual(result.candidates, ['sc-domain:example.com', 'http://example.com/']);
  }
});

test('a host with no related properties is not found', () => {
  assert.deepEqual(resolveSiteUrl('https://other.example/', listed), { status: 'not_found' });
  assert.deepEqual(resolveSiteUrl('other.example', listed), { status: 'not_found' });
});

test('sameProperty ignores host case and URL-prefix trailing slashes, not path case or scheme', () => {
  assert.equal(sameProperty('https://EXAMPLE.com', 'https://example.com/'), true);
  assert.equal(sameProperty('https://example.com/Blog/', 'https://example.com/blog/'), false);
  assert.equal(sameProperty('https://example.com/', 'http://example.com/'), false);
  assert.equal(sameProperty('sc-domain:example.com', 'https://example.com/'), false);
});

test('rewriteRequestSiteUrl replaces the sites path segment and inspection body', () => {
  const path = rewriteRequestSiteUrl(
    `/webmasters/v3/sites/${encodeURIComponent('example.com')}/searchAnalytics/query`,
    {},
    'sc-domain:example.com',
  );
  assert.equal(path.path, `/webmasters/v3/sites/${encodeURIComponent('sc-domain:example.com')}/searchAnalytics/query`);
  const inspect = rewriteRequestSiteUrl('/v1/urlInspection/index:inspect', { inspectionUrl: 'https://example.com/x', siteUrl: 'example.com' }, 'https://example.com/');
  assert.deepEqual(inspect.body, { inspectionUrl: 'https://example.com/x', siteUrl: 'https://example.com/' });
});
