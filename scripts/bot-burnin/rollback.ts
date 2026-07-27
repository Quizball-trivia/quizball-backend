#!/usr/bin/env npx tsx
/**
 * Roll back a persistent-bot burn-in run.
 *
 * Consumes the append-only JSONL receipt + the pre-run snapshot. Verifies
 * receipt/snapshot/manifest mutual consistency and per-match identity, refuses
 * atomically (deleting nothing) on ANY inconsistency or post-snapshot live
 * activity, then deletes the burn-in matches and restores every captured field.
 *
 *   npm run bot:burnin:rollback -- --receipt run.jsonl --snapshot snap.json
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { rollback, RollbackRefusedError } from './snapshot.js';
import { parseReceipt, receiptFixtures } from './receipt.js';
import type { BurnInSnapshot } from './types.js';

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

  const parsed = parseReceipt(resolve(receiptPath));
  const snapshot = JSON.parse(readFileSync(resolve(snapshotPath), 'utf8')) as BurnInSnapshot;
  const fixtures = receiptFixtures(parsed);

  try {
    const result = await rollback(parsed.header, fixtures, snapshot);
    process.stdout.write(
      `Rollback complete:\n` +
        `  matches deleted:     ${result.matchesDeleted}\n` +
        `  profiles restored:   ${result.profilesRestored}\n`,
    );
  } catch (err) {
    if (err instanceof RollbackRefusedError) {
      process.stderr.write(`\nRollback REFUSED (nothing deleted, marker kept): ${err.message}\n`);
      process.exitCode = 2;
      await sql.end();
      return;
    }
    throw err;
  }
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(`\nrollback failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
  void sql.end();
});
