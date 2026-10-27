/**
 * npm run discovery-check [-- --file discovery.json]
 *
 * Fetches the public Search Console API discovery document (no credentials)
 * and compares its enum values with src/lib/enums.ts.
 * Exit codes: 0 no drift, 1 drift, 2 the document could not be loaded.
 */
import { readFile } from 'node:fs/promises';
import { DISCOVERY_URL, checkDiscoveryDrift, formatDriftReport, type DiscoveryDocument } from './discovery-drift.js';

const TIMEOUT_MS = 20_000;

async function loadDocument(file: string | undefined): Promise<DiscoveryDocument> {
  if (file) return JSON.parse(await readFile(file, 'utf8')) as DiscoveryDocument;
  const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${DISCOVERY_URL} returned HTTP ${res.status}`);
  return (await res.json()) as DiscoveryDocument;
}

async function main(): Promise<void> {
  const fileFlag = process.argv.indexOf('--file');
  const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : undefined;
  let doc: DiscoveryDocument;
  try {
    doc = await loadDocument(file);
  } catch (e) {
    console.error(`Could not load the discovery document: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const report = checkDiscoveryDrift(doc);
  console.log(formatDriftReport(report));
  process.exit(report.hasDrift ? 1 : 0);
}

await main();
