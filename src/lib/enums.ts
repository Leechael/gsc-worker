/**
 * GSC API enums, centralized and aligned with the discovery document
 * (revision 20261017). When Google adds values, update here and the
 * discovery-drift CI check will flag the diff.
 */

/** searchAnalytics `type` values (searchType is deprecated — plan §1.5-8). */
export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** searchAnalytics `dimensions` values (7 total; plan §1.5-2). */
export const DIMENSIONS = ['date', 'query', 'page', 'country', 'device', 'searchAppearance', 'hour'] as const;
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
export const FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

/** `aggregationType` values (plan §1.5-10). */
export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];

/** Map config-friendly dataState to the API wire value. */
export function dataStateToWire(state: DataStateParam): string {
  return state === 'hourlyAll' ? 'hourly_all' : state.toUpperCase();
}
