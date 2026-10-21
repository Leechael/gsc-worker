/**
 * Compare the enum values in src/lib/enums.ts with the Search Console API
 * discovery document. Pure functions; scripts/discovery-check.ts does the
 * fetching and printing.
 */
import {
  AGGREGATION_TYPES,
  DATA_STATES,
  DIMENSIONS,
  FILTER_DIMENSIONS,
  FILTER_OPERATORS,
  SEARCH_TYPES,
} from '../src/lib/enums.js';

export const DISCOVERY_URL = 'https://searchconsole.googleapis.com/$discovery/rest?version=v1';

interface DiscoveryProperty {
  enum?: string[];
  items?: { enum?: string[] };
}

export interface DiscoveryDocument {
  revision?: string;
  schemas?: Record<string, { properties?: Record<string, DiscoveryProperty> }>;
}

interface EnumCheck {
  /** Name shown in the report, e.g. "DIMENSIONS". */
  label: string;
  schema: string;
  property: string;
  local: readonly string[];
}

const CHECKS: readonly EnumCheck[] = [
  { label: 'SEARCH_TYPES', schema: 'SearchAnalyticsQueryRequest', property: 'type', local: SEARCH_TYPES },
  { label: 'DIMENSIONS', schema: 'SearchAnalyticsQueryRequest', property: 'dimensions', local: DIMENSIONS },
  { label: 'DATA_STATES', schema: 'SearchAnalyticsQueryRequest', property: 'dataState', local: DATA_STATES },
  { label: 'AGGREGATION_TYPES', schema: 'SearchAnalyticsQueryRequest', property: 'aggregationType', local: AGGREGATION_TYPES },
  { label: 'FILTER_OPERATORS', schema: 'ApiDimensionFilter', property: 'operator', local: FILTER_OPERATORS },
  { label: 'FILTER_DIMENSIONS', schema: 'ApiDimensionFilter', property: 'dimension', local: FILTER_DIMENSIONS },
];

/** Placeholder values that are not real choices and are not mirrored locally. */
const IGNORED_REMOTE = new Set(['DATA_STATE_UNSPECIFIED']);

/** camelCase local value -> the API's SCREAMING_SNAKE form ("googleNews" -> "GOOGLE_NEWS"). */
export function toWireEnum(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

export interface EnumDrift {
  label: string;
  /** Present in the discovery document but not in enums.ts. */
  missingLocally: string[];
  /** Present in enums.ts but no longer in the discovery document. */
  unknownRemotely: string[];
  /** The schema/property could not be found in the document at all. */
  notFound?: boolean;
}

export interface DriftReport {
  revision: string | null;
  results: EnumDrift[];
  hasDrift: boolean;
}

export function checkDiscoveryDrift(doc: DiscoveryDocument): DriftReport {
  const results = CHECKS.map((check): EnumDrift => {
    const prop = doc.schemas?.[check.schema]?.properties?.[check.property];
    const remoteEnum = prop?.enum ?? prop?.items?.enum;
    if (!remoteEnum) return { label: check.label, missingLocally: [], unknownRemotely: [], notFound: true };
    const remote = new Set(remoteEnum.filter((v) => !IGNORED_REMOTE.has(v)));
    const local = new Set(check.local.map(toWireEnum));
    return {
      label: check.label,
      missingLocally: [...remote].filter((v) => !local.has(v)),
      unknownRemotely: [...local].filter((v) => !remote.has(v)),
    };
  });
  const hasDrift = results.some((r) => r.notFound || r.missingLocally.length > 0 || r.unknownRemotely.length > 0);
  return { revision: doc.revision ?? null, results, hasDrift };
}

export function formatDriftReport(report: DriftReport): string {
  const lines = [`Discovery document revision: ${report.revision ?? 'unknown'}`];
  for (const r of report.results) {
    if (r.notFound) {
      lines.push(`DRIFT ${r.label}: field not found in the discovery document`);
    } else if (r.missingLocally.length === 0 && r.unknownRemotely.length === 0) {
      lines.push(`ok    ${r.label}`);
    } else {
      const parts: string[] = [];
      if (r.missingLocally.length) parts.push(`new in API: ${r.missingLocally.join(', ')}`);
      if (r.unknownRemotely.length) parts.push(`gone from API: ${r.unknownRemotely.join(', ')}`);
      lines.push(`DRIFT ${r.label}: ${parts.join('; ')}`);
    }
  }
  lines.push(report.hasDrift ? 'Drift found: update src/lib/enums.ts.' : 'No drift.');
  return lines.join('\n');
}
