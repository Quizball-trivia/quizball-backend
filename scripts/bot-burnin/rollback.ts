#!/usr/bin/env npx tsx
/**
 * Roll back a persistent-bot burn-in run.
 *
 * Consumes the creation receipt (written match ids) + the pre-run snapshot.
 * Deletes ONLY burn-in matches whose participants are all roster bots, then
 * restores every bot's ranked_profiles + total_xp from the snapshot and clears
 * the one-time marker.
 *
 *   npm run bot:burnin:rollback -- --receipt receipt.json --snapshot snap.json
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { rollback } from './snapshot.js';
import type { BurnInReceipt, BurnInSnapshot } from './types.js';

function get(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const receiptPath = get(argv, '--receipt');
  const snapshotPath = get(argv, '--snapshot');
  if (!receiptPath || !snapshotPath) {
    throw new Error('Both --receipt <file> and --snapshot <file> are required.');
  }

  const receipt = JSON.parse(readFileSync(resolve(receiptPath), 'utf8')) as BurnInReceipt;
  const snapshot = JSON.parse(readFileSync(resolve(snapshotPath), 'utf8')) as BurnInSnapshot;

  const result = await rollback(receipt, snapshot);

  process.stdout.write(
    `Rollback complete:\n` +
      `  matches verified (roster-only): ${result.matchesVerified}\n` +
      `  matches deleted:                ${result.matchesDeleted}\n` +
      `  matches REFUSED (non-roster):   ${result.matchesRefused.length}\n` +
      `  profiles restored:              ${result.profilesRestored}\n`,
  );
  if (result.matchesRefused.length > 0) {
    process.stdout.write(`  refused ids: ${result.matchesRefused.join(', ')}\n`);
  }
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(`\nrollback failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
  void sql.end();
});
