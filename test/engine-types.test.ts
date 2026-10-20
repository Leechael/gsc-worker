/**
 * Shared engine helpers (src/engines/types.ts): URL parsing and secret redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpUrl, redactSecret } from '../src/engines/types.js';

test('parseHttpUrl accepts absolute http(s) URLs', () => {
  assert.equal(parseHttpUrl('https://example.com/a?b=1')?.href, 'https://example.com/a?b=1');
  assert.equal(parseHttpUrl('  http://example.com/  ')?.host, 'example.com');
});

test('parseHttpUrl rejects other schemes, relative URLs and garbage', () => {
  for (const raw of ['ftp://example.com/', 'javascript:alert(1)', '/relative/path', 'example.com', '', '   ']) {
    assert.equal(parseHttpUrl(raw), null, raw);
  }
});

test('parseHttpUrl rejects URLs that carry credentials', () => {
  for (const raw of [
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://:pass@example.com/',
    'http://a%40b:c@example.com/page',
  ]) {
    assert.equal(parseHttpUrl(raw), null, raw);
  }
});

test('redactSecret removes raw and URL-encoded occurrences', () => {
  assert.equal(redactSecret('k=abc&x=abc', 'abc'), 'k=***&x=***');
  assert.equal(redactSecret('k=a%2Fb', 'a/b'), 'k=***');
  assert.equal(redactSecret('nothing here', undefined), 'nothing here');
});
