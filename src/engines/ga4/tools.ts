/**
 * Google Analytics 4 MCP tools (ga4_*). Registered only when GA4_ENABLED=true.
 * Read-only: Admin write (create annotation, streams, audiences) is not
 * exposed. The OAuth grant is analytics.readonly unless the operator later
 * adds a separate edit-scope gate.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { GOOGLE_SCOPE_ANALYTICS_READONLY } from '../../lib/config.js';
import { hasAnalyticsReadScope } from '../../lib/google-oauth/google.js';
import type { ServerServices } from '../../mcp/context.js';
import { toolAnnotations } from '../../mcp/tool-annotations.js';
import { errorResult, jsonError, jsonResult } from '../../tools/helpers.js';
import type { EngineToolInfo } from '../types.js';
import {
  GA4_ADMIN_BASE,
  GA4_DATA_BASE,
  Ga4ApiError,
  Ga4Client,
  namedFields,
  propertyResourceName,
  TokenRefreshError,
  toRestJson,
} from './client.js';

export const GA4_LABEL = 'Google Analytics 4';

export const GA4_TOOLS: readonly EngineToolInfo[] = [
  { name: 'ga4_get_account_summaries', tier: 'read', summary: 'GA4 accounts and properties the signed-in user can access (accountSummaries.list)' },
  { name: 'ga4_get_property_details', tier: 'read', summary: 'GA4 property configuration (properties.get)' },
  { name: 'ga4_list_google_ads_links', tier: 'read', summary: 'Google Ads links for a property (googleAdsLinks.list)' },
  { name: 'ga4_list_property_annotations', tier: 'read', summary: 'Reporting-data annotations for a property (reportingDataAnnotations.list)' },
  { name: 'ga4_get_custom_dimensions_and_metrics', tier: 'read', summary: 'Custom dimensions and metrics from Data API metadata (getMetadata)' },
  { name: 'ga4_run_report', tier: 'read', summary: 'Core GA4 report (properties.runReport)' },
  { name: 'ga4_run_realtime_report', tier: 'read', summary: 'Realtime GA4 report (properties.runRealtimeReport)' },
  { name: 'ga4_run_funnel_report', tier: 'read', summary: 'Funnel exploration report (Data API alpha runFunnelReport)' },
  { name: 'ga4_run_conversions_report', tier: 'read', summary: 'Conversions / attribution report (Data API alpha runReport + conversionSpec)' },
  { name: 'ga4_check_compatibility', tier: 'read', summary: 'Which dimensions and metrics can be queried together (checkCompatibility)' },
];

const propertyIdSchema = z
  .union([z.string().min(1), z.number()])
  .describe('GA4 property ID: a number, a digit string, or properties/<number>. Use ga4_get_account_summaries.');
const accountSchema = z
  .string()
  .min(1)
  .nullish()
  .describe('Optional Google account email when several accounts are connected. Default: try each account until one can access the property.');
const dateRangeSchema = z
  .object({
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
const filterSchema = z.unknown().nullish().describe(
  'Data API FilterExpression. snake_case (field_name, string_filter) or REST camelCase both work. See https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression',
);
const orderBysSchema = z
  .array(z.unknown())
  .nullish()
  .describe(
    'Data API OrderBy objects. snake_case or camelCase. Dimensions/metrics named here must also be in the report. See https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/OrderBy',
  );
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(250_000)
  .nullish()
  .describe('Maximum rows to return (1–250000). Used with offset for pagination.');
const offsetSchema = z.number().int().min(0).nullish().describe('0-based row offset for pagination.');
const quotaSchema = z.boolean().nullish().describe('If true, include propertyQuota (or realtime quota) in the response.');
const currencySchema = z
  .string()
  .min(1)
  .nullish()
  .describe('ISO 4217 currency code (USD, JPY, …). Empty uses the property default.');

const DATE_RANGE_HINT =
  'Each date range is {start_date, end_date, name?}. Dates are YYYY-MM-DD, or relative values today / yesterday / NdaysAgo. REST camelCase startDate/endDate is also accepted.';
const SCHEMA_HINT =
  'Standard dimensions and metrics: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema . Custom names come from ga4_get_custom_dimensions_and_metrics.';
const REALTIME_SCHEMA_HINT =
  'Realtime dimensions and metrics: https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema . Custom metrics are not valid in realtime reports; user-scoped custom dimensions (customUser:*) are.';

type ToolError = { isError: true; content: { type: 'text'; text: string }[] };

function fail(e: unknown, prefix: string): ToolError {
  if (e instanceof TokenRefreshError) return errorResult(`Error: ${e.message}`);
  if (e instanceof Ga4ApiError) {
    if (e.status === 429 || e.reason === 'quotaExceeded') {
      return errorResult('Error: Analytics API quota exceeded. Please try again later.');
    }
    if (e.status === 401 || e.status === 403) {
      const scopeHint = /insufficient.*(scope|authentication)/i.test(e.message)
        ? ' The access token may lack analytics.readonly — re-authorize so Google Analytics stays checked (Workers: /auth/google; Node: npm run auth -- --ga4).'
        : '';
      return errorResult(
        `Error: Permission denied (HTTP ${e.status}). You need at least Viewer on the GA4 property.${scopeHint} Details: ${e.message}`,
      );
    }
    return errorResult(`Error: ${prefix}: ${e.message} (HTTP ${e.status})`);
  }
  return errorResult(`Error: ${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

function resolveProperty(propertyId: string | number): { name: string } | ToolError {
  try {
    return { name: propertyResourceName(propertyId) };
  } catch (e) {
    return errorResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Refuse when we know the chosen account's grant lacks analytics.readonly.
 * Unknown granted scope (legacy KV records, env token) is allowed through.
 */
async function analyticsScopeGate(
  svc: ServerServices,
  tool: string,
  account?: string | null,
): Promise<ToolError | null> {
  const accounts = await svc.tokenProvider.accounts();
  if (accounts.length === 0) return null;
  const requested = account && account.trim() !== '' ? account.trim().toLowerCase() : null;
  const chosen = requested
    ? accounts.find((a) => a.id === requested || (a.email ?? '').toLowerCase() === requested)
    : accounts[0];
  if (!chosen) {
    return jsonError({
      error: 'unknown_account',
      tool,
      account: requested,
      resolution: `No connected Google account matches '${requested}'. See get_capabilities for connected accounts.`,
    });
  }
  const granted = chosen.stored?.grantedScope ?? null;
  if (granted === null) return null;
  if (hasAnalyticsReadScope(granted)) return null;
  const name = chosen.email ?? chosen.id;
  return jsonError({
    error: 'insufficient_granted_scope',
    tool,
    account: name,
    granted_scope: granted,
    required_scope: GOOGLE_SCOPE_ANALYTICS_READONLY,
    resolution:
      `Re-authorize ${name} so Google grants analytics.readonly. On Workers open /auth/google ` +
      '(with GA4_ENABLED=true so Analytics is requested). On Node/stdio run ' +
      'npm run auth -- --scopes readonly --ga4 (or --scopes full --ga4) and replace the refresh token. ' +
      'Existing Search Console-only tokens do not include Analytics until you re-consent.',
  });
}

function reportBody(args: {
  dimensions: string[];
  metrics: string[];
  date_ranges?: unknown[] | null | undefined;
  dimension_filter?: unknown;
  metric_filter?: unknown;
  order_bys?: unknown[] | null | undefined;
  limit?: number | null | undefined;
  offset?: number | null | undefined;
  currency_code?: string | null | undefined;
  return_property_quota?: boolean | null | undefined;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dimensions: namedFields(args.dimensions),
    metrics: namedFields(args.metrics),
  };
  if (args.date_ranges && args.date_ranges.length > 0) body.dateRanges = args.date_ranges;
  if (args.dimension_filter != null) body.dimensionFilter = args.dimension_filter;
  if (args.metric_filter != null) body.metricFilter = args.metric_filter;
  if (args.order_bys && args.order_bys.length > 0) body.orderBys = args.order_bys;
  if (args.limit != null) body.limit = args.limit;
  if (args.offset != null) body.offset = args.offset;
  if (args.currency_code) body.currencyCode = args.currency_code;
  if (args.return_property_quota) body.returnPropertyQuota = true;
  if (args.extra) Object.assign(body, args.extra);
  return body;
}

function funnelSteps(raw: unknown[]): Record<string, unknown>[] | ToolError {
  const steps: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; i++) {
    const step = raw[i];
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return errorResult(`Error: funnel_steps[${i}] must be an object.`);
    }
    const s = step as Record<string, unknown>;
    const name = typeof s.name === 'string' && s.name.trim() !== '' ? s.name.trim() : `Step ${i + 1}`;
    let filterExpression: unknown;
    if (s.filter_expression != null) filterExpression = s.filter_expression;
    else if (s.filterExpression != null) filterExpression = s.filterExpression;
    else if (typeof s.event === 'string' && s.event.trim() !== '') {
      filterExpression = { funnelEventFilter: { eventName: s.event.trim() } };
    } else {
      return errorResult(
        `Error: funnel_steps[${i}] must include filter_expression (or filterExpression) or event (event name).`,
      );
    }
    const out: Record<string, unknown> = { name, filterExpression };
    if (s.isDirectlyFollowedBy === true || s.is_directly_followed_by === true) {
      out.isDirectlyFollowedBy = true;
    }
    steps.push(out);
  }
  return steps;
}

export function registerGa4Tools(server: McpServer, svc: ServerServices, client: Ga4Client): void {
  const req = (account?: string | null): { account?: string } => {
    const id = account?.trim();
    return id ? { account: id } : {};
  };

  server.registerTool(
    'ga4_get_account_summaries',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_get_account_summaries'),
      title: 'GA4: list accounts and properties',
      description:
        'List Google Analytics accounts and GA4 properties the connected Google user(s) can access ' +
        '(Admin API accountSummaries.list). Start here to get property IDs for the other ga4_* tools. ' +
        'With several Google accounts, summaries from each account are merged. Viewer on a property is enough.',
      inputSchema: z.object({ account: accountSchema }),
    },
    async ({ account }) => {
      const gate = await analyticsScopeGate(svc, 'ga4_get_account_summaries', account);
      if (gate) return gate;
      try {
        const ids = account?.trim()
          ? [account.trim()]
          : await client.accountIds();
        const accounts = await svc.tokenProvider.accounts();
        const byAccount = [];
        for (const id of ids) {
          const summaries = await client.listAll<unknown>(
            GA4_ADMIN_BASE,
            '/v1beta/accountSummaries',
            'accountSummaries',
            { ...req(id), query: { pageSize: '200' } },
          );
          const meta = accounts.find((a) => a.id === id);
          byAccount.push({
            account: meta?.email ?? id,
            count: summaries.length,
            account_summaries: summaries,
          });
        }
        return jsonResult({
          accounts: byAccount.length,
          results: byAccount,
          note: 'property IDs are the numeric suffix of propertySummaries[].property (properties/123 → 123).',
        });
      } catch (e) {
        return fail(e, 'ga4_get_account_summaries');
      }
    },
  );

  server.registerTool(
    'ga4_get_property_details',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_get_property_details'),
      title: 'GA4: property details',
      description:
        'Return configuration for one GA4 property (Admin API properties.get): display name, time zone, currency, industry, service level. ' +
        'Does not include UI-only settings such as Explorations or DebugView.',
      inputSchema: z.object({ property_id: propertyIdSchema, account: accountSchema }),
    },
    async ({ property_id, account }) => {
      const gate = await analyticsScopeGate(svc, 'ga4_get_property_details', account);
      if (gate) return gate;
      const resolved = resolveProperty(property_id);
      if ('isError' in resolved) return resolved;
      try {
        const property = await client.request<unknown>(
          GA4_ADMIN_BASE,
          `/v1beta/${resolved.name}`,
          req(account),
        );
        return jsonResult(property);
      } catch (e) {
        return fail(e, 'ga4_get_property_details');
      }
    },
  );

  server.registerTool(
    'ga4_list_google_ads_links',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_list_google_ads_links'),
      title: 'GA4: Google Ads links',
      description:
        'List Google Ads accounts linked to a GA4 property (Admin API properties.googleAdsLinks.list). ' +
        'Does not create or delete links.',
      inputSchema: z.object({ property_id: propertyIdSchema, account: accountSchema }),
    },
    async ({ property_id, account }) => {
      const gate = await analyticsScopeGate(svc, 'ga4_list_google_ads_links', account);
      if (gate) return gate;
      const resolved = resolveProperty(property_id);
      if ('isError' in resolved) return resolved;
      try {
        const links = await client.listAll<unknown>(
          GA4_ADMIN_BASE,
          `/v1beta/${resolved.name}/googleAdsLinks`,
          'googleAdsLinks',
          { ...req(account), query: { pageSize: '200' } },
        );
        return jsonResult({ property: resolved.name, count: links.length, google_ads_links: links });
      } catch (e) {
        return fail(e, 'ga4_list_google_ads_links');
      }
    },
  );

  server.registerTool(
    'ga4_list_property_annotations',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_list_property_annotations'),
      title: 'GA4: list annotations',
      description:
        'List reporting-data annotations on a GA4 property (Admin API alpha reportingDataAnnotations.list): ' +
        'notes operators attach to dates or ranges (releases, campaigns, traffic spikes). Read-only; creating annotations is not enabled.',
      inputSchema: z.object({ property_id: propertyIdSchema, account: accountSchema }),
    },
    async ({ property_id, account }) => {
      const gate = await analyticsScopeGate(svc, 'ga4_list_property_annotations', account);
      if (gate) return gate;
      const resolved = resolveProperty(property_id);
      if ('isError' in resolved) return resolved;
      try {
        const annotations = await client.listAll<unknown>(
          GA4_ADMIN_BASE,
          `/v1alpha/${resolved.name}/reportingDataAnnotations`,
          'reportingDataAnnotations',
          { ...req(account), query: { pageSize: '200' } },
        );
        return jsonResult({
          property: resolved.name,
          count: annotations.length,
          reporting_data_annotations: annotations,
        });
      } catch (e) {
        return fail(e, 'ga4_list_property_annotations');
      }
    },
  );

  server.registerTool(
    'ga4_get_custom_dimensions_and_metrics',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_get_custom_dimensions_and_metrics'),
      title: 'GA4: custom dimensions and metrics',
      description:
        'Return the property\'s custom dimensions and custom metrics from Data API getMetadata (customDefinition=true). ' +
        'Use the apiName values in ga4_run_report. Standard schema is documented at the Data API schema page, not listed here.',
      inputSchema: z.object({ property_id: propertyIdSchema, account: accountSchema }),
    },
    async ({ property_id, account }) => {
      const gate = await analyticsScopeGate(svc, 'ga4_get_custom_dimensions_and_metrics', account);
      if (gate) return gate;
      const resolved = resolveProperty(property_id);
      if ('isError' in resolved) return resolved;
      try {
        const metadata = await client.request<{
          dimensions?: { customDefinition?: boolean; [k: string]: unknown }[];
          metrics?: { customDefinition?: boolean; [k: string]: unknown }[];
        }>(GA4_DATA_BASE, `/v1beta/${resolved.name}/metadata`, req(account));
        const custom_dimensions = (metadata.dimensions ?? []).filter((d) => d.customDefinition);
        const custom_metrics = (metadata.metrics ?? []).filter((m) => m.customDefinition);
        return jsonResult({
          property: resolved.name,
          custom_dimensions,
          custom_metrics,
        });
      } catch (e) {
        return fail(e, 'ga4_get_custom_dimensions_and_metrics');
      }
    },
  );

  server.registerTool(
    'ga4_run_report',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_run_report'),
      title: 'GA4: run report',
      description:
        'Run a core Google Analytics Data API report (properties.runReport). ' +
        `${DATE_RANGE_HINT} ${SCHEMA_HINT} ` +
        'Request bodies use REST camelCase; snake_case argument names are converted. ' +
        'For conversions / ROAS / attribution use ga4_run_conversions_report instead. ' +
        'For realtime use ga4_run_realtime_report. Incompatible dimension/metric mixes: ga4_check_compatibility.',
      inputSchema: z.object({
        property_id: propertyIdSchema,
        date_ranges: z.array(dateRangeSchema).min(1).describe('At least one date range.'),
        dimensions: z.array(z.string().min(1)).min(1).describe('Dimension names (date, sessionDefaultChannelGroup, customUser:…, …).'),
        metrics: z.array(z.string().min(1)).min(1).describe('Metric names (sessions, activeUsers, eventCount, customEvent:…, …).'),
        dimension_filter: filterSchema,
        metric_filter: filterSchema,
        order_bys: orderBysSchema,
        limit: limitSchema,
        offset: offsetSchema,
        currency_code: currencySchema,
        return_property_quota: quotaSchema,
        account: accountSchema,
      }),
    },
    async (args) => {
      const gate = await analyticsScopeGate(svc, 'ga4_run_report', args.account);
      if (gate) return gate;
      const resolved = resolveProperty(args.property_id);
      if ('isError' in resolved) return resolved;
      try {
        const report = await client.request<unknown>(
          GA4_DATA_BASE,
          `/v1beta/${resolved.name}:runReport`,
          {
            method: 'POST',
            body: reportBody(args),
            ...req(args.account),
          },
        );
        return jsonResult(report);
      } catch (e) {
        return fail(e, 'ga4_run_report');
      }
    },
  );

  server.registerTool(
    'ga4_run_realtime_report',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_run_realtime_report'),
      title: 'GA4: run realtime report',
      description:
        'Run a Google Analytics realtime report (properties.runRealtimeReport) for the last ~30 minutes. ' +
        `${REALTIME_SCHEMA_HINT} No date_ranges; custom metrics are not allowed.`,
      inputSchema: z.object({
        property_id: propertyIdSchema,
        dimensions: z.array(z.string().min(1)).min(1).describe('Realtime dimension names (country, unifiedScreenName, customUser:…, …).'),
        metrics: z.array(z.string().min(1)).min(1).describe('Realtime metric names (activeUsers, eventCount, …).'),
        dimension_filter: filterSchema,
        metric_filter: filterSchema,
        order_bys: orderBysSchema,
        limit: limitSchema,
        offset: offsetSchema,
        return_property_quota: quotaSchema,
        account: accountSchema,
      }),
    },
    async (args) => {
      const gate = await analyticsScopeGate(svc, 'ga4_run_realtime_report', args.account);
      if (gate) return gate;
      const resolved = resolveProperty(args.property_id);
      if ('isError' in resolved) return resolved;
      try {
        const report = await client.request<unknown>(
          GA4_DATA_BASE,
          `/v1beta/${resolved.name}:runRealtimeReport`,
          {
            method: 'POST',
            body: reportBody(args),
            ...req(args.account),
          },
        );
        return jsonResult(report);
      } catch (e) {
        return fail(e, 'ga4_run_realtime_report');
      }
    },
  );

  server.registerTool(
    'ga4_run_funnel_report',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_run_funnel_report'),
      title: 'GA4: run funnel report',
      description:
        'Run a funnel exploration report (Data API alpha properties.runFunnelReport). ' +
        'This is the API equivalent of a Funnel exploration; other Exploration types stay UI-only. ' +
        'Each funnel_steps entry is either {name, event} for a simple event step or {name, filter_expression} for a full FunnelFilterExpression. ' +
        'See https://developers.google.com/analytics/devguides/reporting/data/v1/funnels . ' +
        DATE_RANGE_HINT,
      inputSchema: z.object({
        property_id: propertyIdSchema,
        funnel_steps: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('Funnel steps: {name, event} or {name, filter_expression}.'),
        date_ranges: z.array(dateRangeSchema).nullish(),
        funnel_breakdown: z
          .unknown()
          .nullish()
          .describe('Optional. {breakdown_dimension: "deviceCategory"} or a full FunnelBreakdown object.'),
        funnel_next_action: z
          .unknown()
          .nullish()
          .describe('Optional. {next_action_dimension: "eventName", limit?: 5} or a full FunnelNextAction object.'),
        is_open_funnel: z.boolean().nullish().describe('If true, users may enter at any step (open funnel). Default closed.'),
        return_property_quota: quotaSchema,
        account: accountSchema,
      }),
    },
    async (args) => {
      const gate = await analyticsScopeGate(svc, 'ga4_run_funnel_report', args.account);
      if (gate) return gate;
      const resolved = resolveProperty(args.property_id);
      if ('isError' in resolved) return resolved;
      const steps = funnelSteps(args.funnel_steps);
      if ('isError' in steps) return steps;
      const funnel: Record<string, unknown> = { steps };
      if (args.is_open_funnel) funnel.isOpenFunnel = true;
      const body: Record<string, unknown> = { funnel };
      if (args.date_ranges && args.date_ranges.length > 0) body.dateRanges = args.date_ranges;
      if (args.return_property_quota) body.returnPropertyQuota = true;
      if (args.funnel_breakdown != null) {
        const bd = args.funnel_breakdown;
        if (bd && typeof bd === 'object' && !Array.isArray(bd) && 'breakdown_dimension' in bd) {
          const name = (bd as { breakdown_dimension?: unknown }).breakdown_dimension;
          if (typeof name === 'string') body.funnelBreakdown = { breakdownDimension: { name } };
          else body.funnelBreakdown = bd;
        } else {
          body.funnelBreakdown = bd;
        }
      }
      if (args.funnel_next_action != null) {
        const na = args.funnel_next_action;
        if (na && typeof na === 'object' && !Array.isArray(na) && 'next_action_dimension' in na) {
          const obj = na as { next_action_dimension?: unknown; limit?: unknown };
          const next: Record<string, unknown> = {};
          if (typeof obj.next_action_dimension === 'string') {
            next.nextActionDimension = { name: obj.next_action_dimension };
          }
          if (typeof obj.limit === 'number') next.limit = obj.limit;
          body.funnelNextAction = next;
        } else {
          body.funnelNextAction = na;
        }
      }
      try {
        const report = await client.request<unknown>(
          GA4_DATA_BASE,
          `/v1alpha/${resolved.name}:runFunnelReport`,
          { method: 'POST', body, ...req(args.account) },
        );
        return jsonResult(report);
      } catch (e) {
        return fail(e, 'ga4_run_funnel_report');
      }
    },
  );

  server.registerTool(
    'ga4_run_conversions_report',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_run_conversions_report'),
      title: 'GA4: run conversions report',
      description:
        'Run a conversions / ad-performance / ROAS report (Data API alpha runReport with conversionSpec). ' +
        'Use this instead of ga4_run_report when the question is conversions, attribution, ad cost, or return on ad spend. ' +
        'conversion_spec: {conversion_actions: ["conversionActions/123"] or [], attribution_model: "DATA_DRIVEN"|"LAST_CLICK"}. ' +
        'Allowed dimensions and metrics are the conversions-report set (campaignName, defaultChannelGroup, advertiserAdCost, allConversionsByConversionDate, …). ' +
        'See https://developers.google.com/analytics/devguides/reporting/data/v1/conversions-api-basics . ' +
        DATE_RANGE_HINT,
      inputSchema: z.object({
        property_id: propertyIdSchema,
        date_ranges: z.array(dateRangeSchema).min(1),
        dimensions: z.array(z.string().min(1)).min(1),
        metrics: z.array(z.string().min(1)).min(1),
        conversion_spec: z
          .record(z.string(), z.unknown())
          .describe('{conversion_actions: string[], attribution_model: "DATA_DRIVEN"|"LAST_CLICK"}'),
        dimension_filter: filterSchema,
        metric_filter: filterSchema,
        order_bys: orderBysSchema,
        limit: limitSchema,
        offset: offsetSchema,
        currency_code: currencySchema,
        return_property_quota: quotaSchema,
        account: accountSchema,
      }),
    },
    async (args) => {
      const gate = await analyticsScopeGate(svc, 'ga4_run_conversions_report', args.account);
      if (gate) return gate;
      const resolved = resolveProperty(args.property_id);
      if ('isError' in resolved) return resolved;
      try {
        const report = await client.request<unknown>(
          GA4_DATA_BASE,
          `/v1alpha/${resolved.name}:runReport`,
          {
            method: 'POST',
            body: reportBody({ ...args, extra: { conversionSpec: args.conversion_spec } }),
            ...req(args.account),
          },
        );
        return jsonResult(report);
      } catch (e) {
        return fail(e, 'ga4_run_conversions_report');
      }
    },
  );

  server.registerTool(
    'ga4_check_compatibility',
    {
      annotations: toolAnnotations(GA4_TOOLS, 'ga4_check_compatibility'),
      title: 'GA4: check dimension/metric compatibility',
      description:
        'Ask the Data API whether a set of dimensions and metrics (and optional filters) can be queried together ' +
        '(properties.checkCompatibility). Use before a failing ga4_run_report, or to list compatible fields. ' +
        'compatibility_filter COMPATIBLE returns only compatible entries.',
      inputSchema: z.object({
        property_id: propertyIdSchema,
        dimensions: z.array(z.string().min(1)).nullish(),
        metrics: z.array(z.string().min(1)).nullish(),
        dimension_filter: filterSchema,
        metric_filter: filterSchema,
        compatibility_filter: z
          .enum(['COMPATIBILITY_UNSPECIFIED', 'COMPATIBLE', 'INCOMPATIBLE'])
          .nullish()
          .describe('Optional. COMPATIBLE returns only compatible dimensions/metrics.'),
        account: accountSchema,
      }),
    },
    async (args) => {
      const gate = await analyticsScopeGate(svc, 'ga4_check_compatibility', args.account);
      if (gate) return gate;
      const resolved = resolveProperty(args.property_id);
      if ('isError' in resolved) return resolved;
      const body: Record<string, unknown> = {};
      if (args.dimensions && args.dimensions.length > 0) body.dimensions = namedFields(args.dimensions);
      if (args.metrics && args.metrics.length > 0) body.metrics = namedFields(args.metrics);
      if (args.dimension_filter != null) body.dimensionFilter = args.dimension_filter;
      if (args.metric_filter != null) body.metricFilter = args.metric_filter;
      if (args.compatibility_filter) body.compatibilityFilter = args.compatibility_filter;
      try {
        const result = await client.request<unknown>(
          GA4_DATA_BASE,
          `/v1beta/${resolved.name}:checkCompatibility`,
          { method: 'POST', body, ...req(args.account) },
        );
        return jsonResult(result);
      } catch (e) {
        return fail(e, 'ga4_check_compatibility');
      }
    },
  );
}

/** Used by tests: convert a nested filter the same way the client does. */
export { toRestJson };
