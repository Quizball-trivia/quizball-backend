#!/usr/bin/env npx tsx
/**
 * Roll back a persistent-bot burn-in run.
 *
 * Recomputes the plan from the SAME immutable inputs the run used (params, seed,
 * season window, target, margin), derives the plan's deterministic match ids,
 * then deletes exactly those matches and resets every roster bot to the pristine
 * baseline — all in one transaction. Refuses (deleting nothing) if any roster
 * bot has a match NOT in the plan (real post-burn-in activity). No snapshot or
 * receipt is needed: the plan + the pristine baseline are pure functions of the
 * inputs.
 *
 *   npm run bot:burnin:rollback -- --params <p> --season-start <ISO> --season-end <ISO> [--seed N] [--recent-matches N] [--margin-rp N]
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { loadRoster, loadActiveCategoryIds, readBurnInMarker } from './data.js';
import { buildManifest, manifestHash as computeManifestHash } from './manifest.js';
import { buildSchedule } from './scheduler.js';
import { rollbackBurnIn, RollbackRefusedError } from './rollback-core.js';
import { assertDbTarget } from './target-guard.js';

const DEFAULT_SEASON_START = new Date('2026-07-21T00:00:00Z');
const DEFAULT_SEED = 20260721;
export const RECENT_MATCHES = 12;
export const DEFAULT_MARGIN = 50;

function get(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}
function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Malformed numeric flag: ${v}`);
  return n;
}
function date(v: string | undefined): Date | undefined {
  if (v == null) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Malformed date: ${v}`);
  return d;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertDbTarget(process.env.DATABASE_URL ?? '', { allowRemote: argv.includes('--allow-remote') });

  const paramsPath = get(argv, '--params');
  if (!paramsPath) throw new Error('--params <file> is required (to recompute the plan).');
  const seasonEnd = date(get(argv, '--season-end'));
  if (!seasonEnd) throw new Error('--season-end <ISO date> is required (to recompute the exact plan).');
  const seasonStart = date(get(argv, '--season-start')) ?? DEFAULT_SEASON_START;
  const seed = num(get(argv, '--seed')) ?? DEFAULT_SEED;
  const recentMatches = num(get(argv, '--recent-matches')) ?? RECENT_MATCHES;
  const marginRp = num(get(argv, '--margin-rp')) ?? DEFAULT_MARGIN;

  const params = parseBotModelParams(JSON.parse(readFileSync(resolve(paramsPath), 'utf8')));
  const [roster, categoryIds] = await Promise.all([loadRoster(null), loadActiveCategoryIds()]);
  if (roster.length < 2) throw new Error(`Roster too small (${roster.length}).`);

  const manifest = buildManifest({ seed, seasonStart, seasonEnd, targetMatches: recentMatches, ceilingMarginRp: marginRp, params, bots: roster, categoryIds });
  const manifestHash = computeManifestHash(manifest);

  // The run's ceiling is derived from LIVE human RP (which drifts) and pairing
  // depends on it, so the exact plan is only reproducible with the SAME ceiling.
  // Read it from the marker the run stored. Also verify the recomputed H matches
  // the marker's H — the recompute args must be the run's args.
  const marker = await readBurnInMarker();
  if (!marker) throw new Error('No burn-in marker present — nothing to roll back.');
  if (marker.manifestHash !== manifestHash) {
    throw new Error(`Recomputed manifest ${manifestHash} != marker ${marker.manifestHash}. Pass the SAME --params/--seed/--season-*/--recent-matches/--margin-rp the run used.`);
  }

  const schedule = buildSchedule({ bots: roster, params, seed, seasonStart, runDate: seasonEnd, targetMatches: recentMatches, ceilingRp: marker.ceilingRp, categoryIds, manifestHash });
  const planMatchIds = schedule.fixtures.map((f) => f.matchId);
  const rosterUserIds = roster.map((b) => b.userId);

  try {
    const result = await rollbackBurnIn(planMatchIds, rosterUserIds);
    process.stdout.write(
      `Rollback complete (manifest ${manifestHash}):\n` +
        `  matches deleted: ${result.matchesDeleted}\n` +
        `  bots reset:      ${result.botsReset}\n`,
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
