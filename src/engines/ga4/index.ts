import type { Config } from '../../lib/config.js';
import type { EngineModule } from '../types.js';
import { Ga4Client } from './client.js';
import { GA4_LABEL, GA4_TOOLS, registerGa4Tools } from './tools.js';

/** Env flag that registers ga4_* tools and adds analytics.readonly to Google OAuth. */
export const GA4_ENABLED_VAR = 'GA4_ENABLED';

export const GA4_CAPABILITY_BOUNDARY: readonly string[] = [
  'Capability boundary (API vs UI):',
  'Available via Admin API (read): account summaries, property details, Google Ads links, reporting-data annotations.',
  'Available via Data API (read): runReport, runRealtimeReport, getMetadata (custom dimensions/metrics), checkCompatibility.',
  'Available via Data API alpha (read): runFunnelReport, conversions runReport (conversionSpec).',
  'Viewer on the GA4 property is enough for these reads.',
  'Not in this server / UI-only: Explorations other than funnel reports, DebugView, Admin write (create annotation, data streams, audiences, access management), advertising UI beyond the conversions report, User-ID / BigQuery export.',
  'Create-annotation and other Admin writes stay off: this server requests analytics.readonly only (not analytics.edit).',
];

export const ga4Engine: EngineModule = {
  id: 'ga4',
  label: GA4_LABEL,
  enableVar: GA4_ENABLED_VAR,
  enableHint: 'set GA4_ENABLED=true to register ga4_* tools and request the analytics.readonly Google scope',
  enabled: (config: Config) => config.ga4Enabled,
  statusLines(config) {
    const lines = [
      'Auth: same Google OAuth as Search Console. This deployment adds https://www.googleapis.com/auth/analytics.readonly to the consent request. Tokens minted before GA4_ENABLED need a fresh consent (Workers: /auth/google; Node: npm run auth -- --ga4).',
      'GCP: enable Google Analytics Admin API and Google Analytics Data API on the OAuth client\'s project. The Google user needs at least Viewer on each GA4 property.',
    ];
    if (config.ga4Enabled) lines.push(...GA4_CAPABILITY_BOUNDARY);
    return lines;
  },
  tools: GA4_TOOLS,
  register(server, svc, fetchImpl) {
    if (!svc.config.ga4Enabled) return;
    const client = new Ga4Client(
      fetchImpl
        ? { tokenProvider: svc.tokenProvider, fetchImpl }
        : { tokenProvider: svc.tokenProvider },
    );
    registerGa4Tools(server, svc, client);
  },
};
