import type { EngineModule } from '../types.js';
import { Ga4Client } from './client.js';
import { GA4_LABEL, GA4_TOOLS, registerGa4Tools } from './tools.js';

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
  // Always on: the tools are read-only and each one checks the account's
  // granted scope, answering with how to add Analytics when it is missing.
  enabled: () => true,
  statusLines() {
    return [
      'Auth: same Google OAuth as Search Console, plus https://www.googleapis.com/auth/analytics.readonly. Grant it per account: Workers /auth/google?ga4=1; Node npm run auth -- --ga4. Accounts without it get a resolution from each ga4_* tool.',
      'GCP: enable Google Analytics Admin API and Google Analytics Data API on the OAuth client\'s project. The Google user needs at least Viewer on each GA4 property.',
      ...GA4_CAPABILITY_BOUNDARY,
    ];
  },
  tools: GA4_TOOLS,
  register(server, svc, fetchImpl) {
    const client = new Ga4Client(
      fetchImpl
        ? { tokenProvider: svc.tokenProvider, fetchImpl }
        : { tokenProvider: svc.tokenProvider },
    );
    registerGa4Tools(server, svc, client);
  },
};
