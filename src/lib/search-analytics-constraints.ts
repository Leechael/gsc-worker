/**
 * Request-side Search Analytics constraints that the query method documents
 * beyond simple enum membership. Tools call these before posting so a bad
 * combination is refused with the limit named, instead of being clamped or
 * sent to Google.
 */
import {
  BRANDED_CLASSIFICATION_VALUES,
  DIMENSIONS,
  FILTER_DIMENSIONS,
  FILTER_LIST_DIMENSIONS,
  FILTER_LIST_MAX_EXPRESSIONS,
  FILTER_OPERATORS,
  SEARCH_TYPES,
  type Dimension,
  type FilterOperator,
  type SearchType,
} from './enums.js';

export interface DimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

export interface FilterList {
  dimension: string;
  expressions: string[];
}

export const BRANDED_EMPTY_NOTE =
  'Empty brandedClassification rows do not mean the property had no traffic. ' +
  'That breakdown is available from 2026-02-21 and only for eligible top-level ' +
  'properties with enough query and impression volume; ineligible properties return no rows.';

export function resolveSearchType(raw: string): { ok: true; type: SearchType } | { ok: false; error: string } {
  const resolved = SEARCH_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase().trim());
  if (resolved === undefined) {
    return { ok: false, error: `Invalid search_type '${raw}'. Allowed: ${SEARCH_TYPES.join(', ')}` };
  }
  return { ok: true, type: resolved };
}

export function parseDimensionList(raw: string): { ok: true; dimensions: Dimension[] } | { ok: false; error: string } {
  const dimensions = raw.split(',').map((d) => d.trim()).filter(Boolean) as Dimension[];
  const invalid = dimensions.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
  if (invalid.length > 0) {
    return { ok: false, error: `Invalid dimensions: ${invalid.join(', ')}. Allowed: ${DIMENSIONS.join(', ')}` };
  }
  if (dimensions.length === 0) {
    return { ok: false, error: 'At least one dimension is required.' };
  }
  return { ok: true, dimensions };
}

/** Canonical BRANDED / NON_BRANDED, or null if the value is not one of those. */
export function canonicalBrandedValue(raw: string): string | null {
  const match = BRANDED_CLASSIFICATION_VALUES.find((v) => v === raw.toUpperCase());
  return match ?? null;
}

export function validateOrdinaryFilter(
  dimension: unknown,
  operator: unknown,
  expression: unknown,
): { ok: true; filter: DimensionFilter } | { ok: false; error: string } {
  if (typeof dimension !== 'string' || !(FILTER_DIMENSIONS as readonly string[]).includes(dimension)) {
    return { ok: false, error: `Invalid filter dimension '${String(dimension)}'. Allowed: ${FILTER_DIMENSIONS.join(', ')}` };
  }
  if (typeof operator !== 'string' || !(FILTER_OPERATORS as readonly string[]).includes(operator)) {
    return { ok: false, error: `Invalid filter operator '${String(operator)}'. Allowed: ${FILTER_OPERATORS.join(', ')}` };
  }
  if (typeof expression !== 'string') {
    return { ok: false, error: 'Filter expression must be a string.' };
  }
  if (dimension === 'brandedClassification') {
    if (operator !== 'equals') {
      return {
        ok: false,
        error: 'brandedClassification filters support only the equals operator (BRANDED or NON_BRANDED).',
      };
    }
    const branded = canonicalBrandedValue(expression);
    if (branded == null) {
      return {
        ok: false,
        error: `Invalid brandedClassification value '${expression}'. Allowed: ${BRANDED_CLASSIFICATION_VALUES.join(', ')}.`,
      };
    }
    return { ok: true, filter: { dimension, operator: operator as FilterOperator, expression: branded } };
  }
  return { ok: true, filter: { dimension, operator, expression } };
}

/**
 * Parse filterLists JSON. Expressions are kept as given (no clamp, no case fold).
 * Empty / omitted input is not handled here — callers skip the field.
 */
export function parseFilterLists(raw: unknown): { ok: true; lists: FilterList[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Invalid filter_lists value. Expected a non-empty JSON array of {dimension, expressions} objects.' };
  }
  const lists: FilterList[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || !('dimension' in entry) || !('expressions' in entry)) {
      return {
        ok: false,
        error: `Each filter list must have 'dimension' and 'expressions' keys. Invalid entry: ${JSON.stringify(entry)}`,
      };
    }
    const { dimension, expressions } = entry as Record<string, unknown>;
    if (typeof dimension !== 'string' || !(FILTER_LIST_DIMENSIONS as readonly string[]).includes(dimension)) {
      return {
        ok: false,
        error: `Invalid filter_lists dimension '${String(dimension)}'. Allowed: ${FILTER_LIST_DIMENSIONS.join(', ')}.`,
      };
    }
    if (!Array.isArray(expressions)) {
      return { ok: false, error: `filter_lists expressions for '${dimension}' must be an array of strings.` };
    }
    if (expressions.length === 0) {
      return { ok: false, error: `filter_lists for '${dimension}' must include at least one expression.` };
    }
    if (expressions.length > FILTER_LIST_MAX_EXPRESSIONS) {
      return {
        ok: false,
        error:
          `filter_lists for '${dimension}' has ${expressions.length} expressions; ` +
          `the maximum is ${FILTER_LIST_MAX_EXPRESSIONS} per list.`,
      };
    }
    const copied: string[] = [];
    for (const value of expressions) {
      if (typeof value !== 'string') {
        return { ok: false, error: `filter_lists expressions for '${dimension}' must all be strings.` };
      }
      copied.push(value);
    }
    lists.push({ dimension, expressions: copied });
  }
  return { ok: true, lists };
}

export function usesBrandedClassification(
  dimensions: readonly string[],
  filters: readonly DimensionFilter[],
): boolean {
  return dimensions.includes('brandedClassification') || filters.some((f) => f.dimension === 'brandedClassification');
}

/**
 * Documented cross-field rules for one Search Analytics query.
 * Eligibility of brandedClassification for a property is not checked here.
 */
export function crossFieldError(input: {
  searchType?: string;
  dimensions: readonly string[];
  filters: readonly DimensionFilter[];
  filterLists?: readonly FilterList[];
}): string | null {
  const filters = input.filters;
  const filterLists = input.filterLists ?? [];
  const queryFilter = filters.some((f) => f.dimension === 'query');

  if (input.searchType === 'webMultimodal') {
    if (input.dimensions.includes('query')) {
      return (
        'search_type webMultimodal cannot group by the query dimension: text queries are not ' +
        'available for Google Lens, Circle to Search, and image-upload traffic. Group by page, ' +
        'country, device, or date instead.'
      );
    }
    if (queryFilter) {
      return (
        'search_type webMultimodal cannot filter by query: text queries are not available for ' +
        'Google Lens, Circle to Search, and image-upload traffic.'
      );
    }
  }

  if (queryFilter && usesBrandedClassification(input.dimensions, filters)) {
    return (
      'brandedClassification cannot be combined with a query filter in the same request ' +
      '(including filters in a different group). Remove the query filter or the brandedClassification ' +
      'dimension/filter.'
    );
  }

  if (filterLists.length > 0) {
    const ordinaryDims = new Set(filters.map((f) => f.dimension));
    for (const list of filterLists) {
      if (ordinaryDims.has(list.dimension)) {
        return (
          `Dimension '${list.dimension}' cannot appear in both filters and filter_lists in the same request.`
        );
      }
    }
  }

  return null;
}

/** dimensionFilterGroups payload: omit empty arrays so the wire shape stays lossless. */
export function dimensionFilterGroupsPayload(
  filters: readonly DimensionFilter[],
  filterLists: readonly FilterList[],
): { groupType: 'AND'; filters?: DimensionFilter[]; filterLists?: FilterList[] }[] | undefined {
  if (filters.length === 0 && filterLists.length === 0) return undefined;
  const group: { groupType: 'AND'; filters?: DimensionFilter[]; filterLists?: FilterList[] } = {
    groupType: 'AND',
  };
  if (filters.length > 0) group.filters = [...filters];
  if (filterLists.length > 0) group.filterLists = filterLists.map((list) => ({
    dimension: list.dimension,
    expressions: [...list.expressions],
  }));
  return [group];
}
