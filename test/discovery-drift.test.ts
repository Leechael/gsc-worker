/** scripts/discovery-drift.ts: enum comparison against a discovery document. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiscoveryDrift, formatDriftReport, toWireEnum, type DiscoveryDocument } from '../scripts/discovery-drift.js';

/** Trimmed copy of the relevant part of the v1 discovery document. */
function doc(): DiscoveryDocument {
  return {
    revision: '20261020',
    schemas: {
      SearchAnalyticsQueryRequest: {
        properties: {
          type: { enum: ['WEB', 'IMAGE', 'VIDEO', 'NEWS', 'DISCOVER', 'GOOGLE_NEWS'] },
          dimensions: { items: { enum: ['DATE', 'QUERY', 'PAGE', 'COUNTRY', 'DEVICE', 'SEARCH_APPEARANCE', 'HOUR'] } },
          dataState: { enum: ['DATA_STATE_UNSPECIFIED', 'FINAL', 'ALL', 'HOURLY_ALL'] },
          aggregationType: { enum: ['AUTO', 'BY_PROPERTY', 'BY_PAGE', 'BY_NEWS_SHOWCASE_PANEL'] },
        },
      },
      ApiDimensionFilter: {
        properties: {
          operator: { enum: ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'INCLUDING_REGEX', 'EXCLUDING_REGEX'] },
          dimension: { enum: ['QUERY', 'PAGE', 'COUNTRY', 'DEVICE', 'SEARCH_APPEARANCE'] },
        },
      },
    },
  };
}

test('toWireEnum maps camelCase to the API form', () => {
  assert.equal(toWireEnum('googleNews'), 'GOOGLE_NEWS');
  assert.equal(toWireEnum('byNewsShowcasePanel'), 'BY_NEWS_SHOWCASE_PANEL');
  assert.equal(toWireEnum('hourlyAll'), 'HOURLY_ALL');
  assert.equal(toWireEnum('web'), 'WEB');
});

test('matching document reports no drift', () => {
  const report = checkDiscoveryDrift(doc());
  assert.equal(report.hasDrift, false, formatDriftReport(report));
  assert.equal(report.revision, '20261020');
});

test('a new API value and a removed one are both reported', () => {
  const d = doc();
  d.schemas!.SearchAnalyticsQueryRequest!.properties!.dimensions = {
    items: { enum: ['DATE', 'QUERY', 'PAGE', 'COUNTRY', 'DEVICE', 'SEARCH_APPEARANCE', 'NEW_DIMENSION'] },
  };
  const report = checkDiscoveryDrift(d);
  assert.equal(report.hasDrift, true);
  const dims = report.results.find((r) => r.label === 'DIMENSIONS')!;
  assert.deepEqual(dims.missingLocally, ['NEW_DIMENSION']);
  assert.deepEqual(dims.unknownRemotely, ['HOUR']);
  assert.match(formatDriftReport(report), /DRIFT DIMENSIONS: new in API: NEW_DIMENSION; gone from API: HOUR/);
});

test('a field missing from the document counts as drift', () => {
  const d = doc();
  delete d.schemas!.ApiDimensionFilter;
  const report = checkDiscoveryDrift(d);
  assert.equal(report.hasDrift, true);
  assert.ok(report.results.find((r) => r.label === 'FILTER_OPERATORS')!.notFound);
});
