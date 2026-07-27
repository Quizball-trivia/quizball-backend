#!/usr/bin/env npx tsx
/**
 * Manual runner for the question_stats refresh job (persistent-bot roster).
 *
 * Recomputes question_stats + question_stats_backoff from the app DB's human
 * ranked answer history. Run by a human against staging first, then prod. This
 * is NOT the scheduler path (there is none in this PR); it bypasses the
 * QUESTION_STATS_REFRESH_ENABLED flag deliberately.
 *
 *   npm run bot:refresh-question-stats            # full REPLACE (uses DATABASE_URL)
 *   npm run bot:refresh-question-stats -- --limit 50000   # DRY RUN (computes, writes nothing)
 *
 * A full run does a complete latest-snapshot replace: upsert every current row
 * AND delete obsolete question_stats / backoff rows, atomically. A --limit run
 * is a DRY RUN — partial aggregates from a limited scan must never be written.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { refreshQuestionStats } from '../src/modules/bots/question-stats-refresh.job.js';
import { disconnectDb } from '../src/db/index.js';

function parseLimit(): number | undefined {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return undefined;
  const value = Number(process.argv[idx + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error('--limit must be a positive number');
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const limit = parseLimit();
  console.log(limit ? `DRY RUN question_stats (limit ${limit}, no writes)...` : 'Refreshing question_stats (full replace)...');
  const summary = await refreshQuestionStats({ limit });
  console.log('Done:', JSON.stringify(summary, null, 2));
}

main()
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('question_stats refresh failed:', err);
    await disconnectDb().catch(() => {});
    process.exit(1);
  });
