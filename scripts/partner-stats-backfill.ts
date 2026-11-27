/**
 * One-off backfill of Table Derby's daily counts into partner_daily_stats for
 * days older than the sync's 35-day window (after a long outage, or a
 * correction of old matches). Integers per Tbilisi day only, as the sync.
 * Uses this environment's TD_STATS_DATABASE_URL / _CA / _PROJECT_REF and
 * DATABASE_URL (run it where the backend's variables are set).
 *
 *   npx tsx scripts/partner-stats-backfill.ts --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]
 *
 * Prints only the number of days read and written; errors print a stage and
 * a code, never the connection string.
 */

import 'dotenv/config';
import { disconnectDb } from '../src/db/index.js';
import {
  TableDerbyStatsError,
  backfillTableDerbyDays,
  configuredTableDerbyClient,
} from '../src/modules/partner-stats/table-derby-stats.js';

function parseArgs(argv: string[]): { from: string; to: string; dryRun: boolean } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = value('--from');
  const to = value('--to');
  if (!from || !to) {
    console.error('usage: partner-stats-backfill.ts --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]');
    process.exit(2);
  }
  return { from, to, dryRun: argv.includes('--dry-run') };
}

const { from, to, dryRun } = parseArgs(process.argv.slice(2));
let code = 0;
try {
  const td = configuredTableDerbyClient();
  try {
    const result = await backfillTableDerbyDays(td, from, to, { dryRun });
    console.log(JSON.stringify({ from, to, dryRun, ...result }));
  } finally {
    await td.end({ timeout: 5 });
  }
} catch (error) {
  const e = error instanceof TableDerbyStatsError ? error : null;
  console.error(JSON.stringify({ failed: e?.stage ?? 'unknown', code: e?.code ?? 'unknown' }));
  code = 1;
} finally {
  await disconnectDb().catch(() => undefined);
}
process.exit(code);
