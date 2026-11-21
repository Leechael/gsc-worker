/**
 * Request-side Search Analytics constraints: webMultimodal, brandedClassification,
 * and filterLists cardinality / cross-field rules. Combinations the API does not
 * document as invalid are left to the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANDED_CLASSIFICATION_VALUES,
  FILTER_LIST_MAX_EXPRESSIONS,
} from '../src/lib/enums.js';
import {
  canonicalBrandedValue,
  crossFieldError,
  dimensionFilterGroupsPayload,
  parseDimensionList,
  parseFilterLists,
  resolveSearchType,
  validateOrdinaryFilter,
} from '../src/lib/search-analytics-constraints.js';

test('resolveSearchType keeps the six existing types and webMultimodal', () => {
  assert.deepEqual(
    ['web', 'image', 'video', 'news', 'discover', 'googleNews', 'webMultimodal'].map((t) => {
      const parsed = resolveSearchType(t);
      assert.equal(parsed.ok, true);
      return parsed.ok ? parsed.type : t;
    }),
    ['web', 'image', 'video', 'news', 'discover', 'googleNews', 'webMultimodal'],
  );
  const folded = resolveSearchType('WEBMULTIMODAL');
  assert.equal(folded.ok, true);
  if (folded.ok) assert.equal(folded.type, 'webMultimodal');
  const bad = resolveSearchType('aiOverview');
  assert.equal(bad.ok, false);
});

test('parseDimensionList accepts brandedClassification among the existing dimensions', () => {
  const parsed = parseDimensionList('page,brandedClassification,date');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.dimensions, ['page', 'brandedClassification', 'date']);
  }
  const invalid = parseDimensionList('query,aiMode');
  assert.equal(invalid.ok, false);
});

test('brandedClassification filters are equals-only BRANDED or NON_BRANDED', () => {
  assert.equal(canonicalBrandedValue('branded'), 'BRANDED');
  assert.equal(canonicalBrandedValue('non_branded'), 'NON_BRANDED');
  assert.deepEqual(BRANDED_CLASSIFICATION_VALUES, ['BRANDED', 'NON_BRANDED']);

  const ok = validateOrdinaryFilter('brandedClassification', 'equals', 'non_branded');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.filter.expression, 'NON_BRANDED');

  const contains = validateOrdinaryFilter('brandedClassification', 'contains', 'BRANDED');
  assert.equal(contains.ok, false);
  if (!contains.ok) assert.match(contains.error, /equals/);

  const other = validateOrdinaryFilter('brandedClassification', 'equals', 'MIXED');
  assert.equal(other.ok, false);
});

test('filterLists keep country/device expressions losslessly and reject 1001', () => {
  const thousand = Array.from({ length: FILTER_LIST_MAX_EXPRESSIONS }, (_, i) => `c${i}`);
  const ok = parseFilterLists([{ dimension: 'country', expressions: thousand }]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.lists[0]!.expressions.length, FILTER_LIST_MAX_EXPRESSIONS);
    assert.equal(ok.lists[0]!.expressions[0], 'c0');
    assert.equal(ok.lists[0]!.expressions[999], 'c999');
  }

  const over = parseFilterLists([{
    dimension: 'device',
    expressions: Array.from({ length: FILTER_LIST_MAX_EXPRESSIONS + 1 }, (_, i) => `d${i}`),
  }]);
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.match(over.error, /1001 expressions/);
    assert.match(over.error, /maximum is 1000 per list/);
    assert.doesNotMatch(over.error, /50/);
  }

  const queryList = parseFilterLists([{ dimension: 'query', expressions: ['shoes'] }]);
  assert.equal(queryList.ok, false);
  if (!queryList.ok) assert.match(queryList.error, /country, device/);
});

test('cross-field rules match the documented combinations only', () => {
  assert.match(
    crossFieldError({
      searchType: 'webMultimodal',
      dimensions: ['query'],
      filters: [],
    }) ?? '',
    /webMultimodal cannot group by the query dimension/,
  );
  assert.match(
    crossFieldError({
      searchType: 'webMultimodal',
      dimensions: ['page'],
      filters: [{ dimension: 'query', operator: 'contains', expression: 'lens' }],
    }) ?? '',
    /webMultimodal cannot filter by query/,
  );
  assert.equal(
    crossFieldError({
      searchType: 'webMultimodal',
      dimensions: ['page', 'country'],
      filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }],
    }),
    null,
  );
  assert.equal(
    crossFieldError({
      searchType: 'webMultimodal',
      dimensions: ['page', 'brandedClassification'],
      filters: [],
    }),
    null,
  );

  assert.match(
    crossFieldError({
      dimensions: ['brandedClassification'],
      filters: [{ dimension: 'query', operator: 'contains', expression: 'brand' }],
    }) ?? '',
    /cannot be combined with a query filter/,
  );
  assert.match(
    crossFieldError({
      dimensions: ['page'],
      filters: [
        { dimension: 'brandedClassification', operator: 'equals', expression: 'BRANDED' },
        { dimension: 'query', operator: 'equals', expression: 'acme' },
      ],
    }) ?? '',
    /cannot be combined with a query filter/,
  );
  assert.equal(
    crossFieldError({
      dimensions: ['query', 'brandedClassification'],
      filters: [],
    }),
    null,
  );

  assert.match(
    crossFieldError({
      dimensions: ['page'],
      filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }],
      filterLists: [{ dimension: 'country', expressions: ['gbr', 'can'] }],
    }) ?? '',
    /cannot appear in both filters and filter_lists/,
  );
  assert.equal(
    crossFieldError({
      dimensions: ['page'],
      filters: [{ dimension: 'page', operator: 'contains', expression: '/blog' }],
      filterLists: [{ dimension: 'country', expressions: ['usa', 'gbr'] }],
    }),
    null,
  );
});

test('dimensionFilterGroupsPayload uses camelCase filterLists and omits empty arrays', () => {
  assert.equal(dimensionFilterGroupsPayload([], []), undefined);
  assert.deepEqual(
    dimensionFilterGroupsPayload(
      [{ dimension: 'page', operator: 'contains', expression: '/a' }],
      [],
    ),
    [{
      groupType: 'AND',
      filters: [{ dimension: 'page', operator: 'contains', expression: '/a' }],
    }],
  );
  const lists = [{ dimension: 'device', expressions: ['MOBILE', 'TABLET'] }];
  assert.deepEqual(dimensionFilterGroupsPayload([], lists), [{
    groupType: 'AND',
    filterLists: [{ dimension: 'device', expressions: ['MOBILE', 'TABLET'] }],
  }]);
});
