/**
 * Refuses to deploy while wrangler.jsonc still holds template placeholders.
 * Usage: tsx scripts/check-wrangler-config.ts [path]   (default wrangler.jsonc)
 */
import { readFileSync } from 'node:fs';
import { findPlaceholders } from './wrangler-placeholders.js';

const path = process.argv[2] ?? 'wrangler.jsonc';
const found = findPlaceholders(readFileSync(path, 'utf8'));
if (found.length > 0) {
  console.error(`${path} still contains template placeholders; replace them before deploying:`);
  for (const p of found) console.error(`  ${p.path} = ${JSON.stringify(p.value)}`);
  process.exit(1);
}
console.log(`${path}: no template placeholders.`);
