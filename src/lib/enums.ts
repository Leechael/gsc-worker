/**
 * GSC API enums, centralized and aligned with the discovery document
 * (last checked against revision 20261118). `npm run discovery-check`
 * compares these lists with the live document and exits non-zero on drift;
 * it is a manual check, not wired into CI.
 */

/** searchAnalytics `type` values (searchType is deprecated — plan §1.5-8). */
export const SEARCH_TYPES = [
  'web',
  'image',
  'video',
  'news',
  'discover',
  'googleNews',
  'webMultimodal',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** searchAnalytics `dimensions` values (plan §1.5-2). */
export const DIMENSIONS = [
  'date',
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
  'hour',
  'brandedClassification',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** `dataState` values (plan §1.5-1). HOUR requires HOURLY_ALL. */
export const DATA_STATES = ['final', 'all', 'hourlyAll'] as const;
export type DataStateParam = (typeof DATA_STATES)[number];

/** dimensionFilterGroups operators (plan §1.5-6). Regex dialect is RE2. */
export const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'includingRegex',
  'excludingRegex',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Filterable dimensions (no date/hour; plan §1.5-6). */
export const FILTER_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
  'brandedClassification',
] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

/**
 * Dimensions accepted on dimensionFilterGroups.filterLists.
 * The list schema enumerates more names; only country and device are supported.
 */
export const FILTER_LIST_DIMENSIONS = ['country', 'device'] as const;
export type FilterListDimension = (typeof FILTER_LIST_DIMENSIONS)[number];

/** Maximum expressions in one filterLists entry. */
export const FILTER_LIST_MAX_EXPRESSIONS = 1000;

/** brandedClassification filter/group values (equals only). */
export const BRANDED_CLASSIFICATION_VALUES = ['BRANDED', 'NON_BRANDED'] as const;
export type BrandedClassificationValue = (typeof BRANDED_CLASSIFICATION_VALUES)[number];

/** `aggregationType` values (plan §1.5-10). */
export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];

/** Map config-friendly dataState to the API wire value. */
export function dataStateToWire(state: DataStateParam): string {
  return state === 'hourlyAll' ? 'hourly_all' : state.toUpperCase();
}
