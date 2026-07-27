#!/usr/bin/env npx tsx
/**
 * One-time persistent-bot burn-in engine (PR6).
 *
 * Gives each persistent roster bot a plausible season-to-date (3 placements +
 * backdated ranked bot-vs-bot fixtures) using the REAL Season-2026 RP formula,
 * capped below the live human top-10.
 *
 * DRY-RUN IS THE DEFAULT — it simulates the full plan and prints the
 * distribution report with ZERO writes. --execute performs the backdated writes
 * and REQUIRES --snapshot-out <file> (pre-run state for rollback). A creation
 * receipt of written match ids is emitted for schema-free rollback.
 *
 *   npm run bot:burnin -- --params ../calibration-s1final/params.json --limit 20
 *   npm run bot:burnin -- --params <p> --execute --snapshot-out snap.json --receipt-out receipt.json
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  loadRoster,
  loadHumanTop10Rp,
  loadActiveCategoryIds,
  burnInAlreadyRan,
  markBurnInComplete,
} from './data.js';
import { buildSchedule } from './scheduler.js';
import { buildReport, formatReport } from './report.js';
import { snapshotProfiles } from './snapshot.js';
import { writeFixture } from './writer.js';
import type { BurnInReceipt } from './types.js';

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const DEFAULT_SEED = 20260721;
const DEFAULT_TARGET = 22; // population median inside the 15-40 band
const DEFAULT_MARGIN = 200;

interface Args {
  paramsPath: string;
  seed: number;
  target: number;
  marginRp: number;
  execute: boolean;
  snapshotOut: string | null;
  receiptOut: string | null;
  limit: number | null;
  runDate: Date;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (flag: string) => argv.includes(flag);
  const num = (v: string | undefined): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Malformed numeric flag value: ${v}`);
    return n;
  };
  const paramsPath = get('--params');
  if (!paramsPath) throw new Error('--params <file> is required (zod-validated calibration params).');
  const runDateRaw = get('--run-date');
  return {
    paramsPath,
    seed: num(get('--seed')) ?? DEFAULT_SEED,
    target: num(get('--target')) ?? DEFAULT_TARGET,
    marginRp: num(get('--margin-rp')) ?? DEFAULT_MARGIN,
    execute: has('--execute'),
    snapshotOut: get('--snapshot-out') ?? null,
    receiptOut: get('--receipt-out') ?? null,
    limit: num(get('--limit')) ?? null,
    runDate: runDateRaw ? new Date(runDateRaw) : new Date(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.execute && !args.snapshotOut) {
    throw new Error('--execute requires --snapshot-out <file> (pre-run snapshot for rollback).');
  }

  const params = parseBotModelParams(JSON.parse(readFileSync(resolve(args.paramsPath), 'utf8')));

  const [roster, humanTop10Rp, categoryIds] = await Promise.all([
    loadRoster(args.limit),
    loadHumanTop10Rp(),
    loadActiveCategoryIds(),
  ]);

  if (roster.length < 2) throw new Error(`Roster too small to pair (${roster.length} bots).`);
  if (categoryIds.length === 0) throw new Error('No active categories to draw from.');

  // Ceiling: human #10 − margin. If fewer than 10 placed humans, fall back to a
  // conservative absolute cap so bots never dominate an empty ladder.
  const ceilingRp =
    humanTop10Rp != null
      ? Math.max(0, humanTop10Rp - args.marginRp)
      : 1500 - args.marginRp;

  const runDate = args.runDate;
  const schedule = buildSchedule({
    bots: roster,
    params,
    seed: args.seed,
    seasonStart: SEASON_START,
    runDate,
    targetMatches: args.target,
    ceilingRp,
    categoryIds,
  });

  const report = buildReport({
    finalBots: schedule.finalBots,
    fixtures: schedule.fixtures,
    ceilingRp,
    humanTop10Rp,
  });

  process.stdout.write(formatReport(report));

  if (!args.execute) {
    process.stdout.write('\nDRY-RUN — no writes performed. Re-run with --execute --snapshot-out <file>.\n');
    await sql.end();
    return;
  }

  if (!report.ceilingRespected) {
    throw new Error('ABORT: simulated distribution violates the hard ceiling. No writes performed.');
  }
  if (await burnInAlreadyRan()) {
    throw new Error('ABORT: burn-in marker present — this env has already been burned in.');
  }

  const env = (process.env.NODE_ENV ?? 'unknown').toString();

  // Snapshot BEFORE any write.
  const snapshot = await snapshotProfiles(roster, {
    seed: args.seed,
    env,
    ceilingRp,
    humanTop10Rp,
    marginRp: args.marginRp,
  });
  writeFileSync(resolve(args.snapshotOut!), JSON.stringify(snapshot, null, 2));
  process.stdout.write(`\nSnapshot written: ${args.snapshotOut}\n`);

  // Write fixtures with per-fixture receipt flushing so a crash is resumable.
  const receipt: BurnInReceipt = {
    createdAt: new Date().toISOString(),
    seed: args.seed,
    env,
    rosterUserIds: roster.map((b) => b.userId),
    matchIds: [],
    fixtureKeys: [],
  };
  const receiptPath = args.receiptOut ?? args.snapshotOut!.replace(/\.json$/, '') + '.receipt.json';

  let written = 0;
  for (const fixture of schedule.fixtures) {
    const res = await writeFixture(fixture);
    receipt.matchIds.push(res.matchId);
    receipt.fixtureKeys.push(fixture.key);
    written++;
    if (written % 50 === 0) {
      writeFileSync(resolve(receiptPath), JSON.stringify(receipt, null, 2));
      process.stdout.write(`  … ${written}/${schedule.fixtures.length} fixtures written\n`);
    }
  }
  writeFileSync(resolve(receiptPath), JSON.stringify(receipt, null, 2));
  await markBurnInComplete(args.seed, schedule.fixtures.length);

  process.stdout.write(
    `\nEXECUTE complete: ${written} fixtures written.\n` +
      `Receipt: ${receiptPath}\nSnapshot: ${args.snapshotOut}\n`,
  );
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(`\nburn-in failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
  void sql.end();
});
