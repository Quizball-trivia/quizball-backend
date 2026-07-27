#!/usr/bin/env npx tsx
/**
 * One-time persistent-bot burn-in engine (PR6).
 *
 * Gives each persistent roster bot a plausible season-to-date (3 placements +
 * backdated ranked bot-vs-bot fixtures) using the REAL Season-2026 RP formula,
 * capped below the live human top-10.
 *
 * DRY-RUN IS THE DEFAULT — simulates the full plan, prints the distribution
 * report, ZERO writes. --execute performs the backdated writes and REQUIRES
 * --snapshot-out <file> (write-once pre-run snapshot for rollback) + an
 * append-only JSONL receipt.
 *
 * Burn-in is a PRISTINE-STATE operation: it runs ONCE, immediately after roster
 * creation, BEFORE selection ever activates. --execute refuses unless every
 * roster bot is exactly pristine and the PERSISTENT_BOTS flag is OFF.
 *
 *   npm run bot:burnin -- --params /abs/params.json --limit 20
 *   npm run bot:burnin -- --params <p> --execute --snapshot-out snap.json --receipt-out run.jsonl
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  loadRoster,
  loadHumanTop10Rp,
  loadActiveCategoryIds,
  claimBurnInMarker,
  findNonPristineBots,
} from './data.js';
import { buildManifest, manifestHash as computeManifestHash } from './manifest.js';
import { buildSchedule } from './scheduler.js';
import { buildReport, formatReport } from './report.js';
import { snapshotProfiles } from './snapshot.js';
import { writeFixture } from './writer.js';
import { ReceiptWriter, parseReceipt } from './receipt.js';
import { assertDbTarget } from './target-guard.js';
import type { BurnInSnapshot } from './types.js';

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

/** PERSISTENT_BOTS flag must be OFF for a pristine-state burn-in. */
function persistentBotsFlagOn(): boolean {
  const raw = (process.env.PERSISTENT_BOTS ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertDbTarget(process.env.DATABASE_URL ?? '', { allowRemote: argv.includes('--allow-remote') });

  const args = parseArgs(argv);

  if (args.execute && !args.snapshotOut) {
    throw new Error('--execute requires --snapshot-out <file> (write-once pre-run snapshot for rollback).');
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
  const ceilingRp = humanTop10Rp != null ? Math.max(0, humanTop10Rp - args.marginRp) : 1500 - args.marginRp;
  const env = (process.env.NODE_ENV ?? 'unknown').toString();
  const runDate = args.runDate;

  const manifest = buildManifest({
    seed: args.seed,
    env,
    seasonStart: SEASON_START,
    runDate,
    targetMatches: args.target,
    ceilingMarginRp: args.marginRp,
    ceilingRp,
    humanTop10Rp,
    paramsGeneratedAt: params.generatedAt,
    paramsBatchId: params.source.batchId,
    bots: roster,
    categoryIds,
  });
  const manifestHash = computeManifestHash(manifest);

  const schedule = buildSchedule({
    bots: roster,
    params,
    seed: args.seed,
    seasonStart: SEASON_START,
    runDate,
    targetMatches: args.target,
    ceilingRp,
    categoryIds,
    manifestHash,
  });

  const report = buildReport({
    finalBots: schedule.finalBots,
    fixtures: schedule.fixtures,
    ceilingRp,
    humanTop10Rp,
  });
  process.stdout.write(formatReport(report));
  process.stdout.write(`\nRun manifest hash: ${manifestHash}\n`);

  if (!args.execute) {
    process.stdout.write('\nDRY-RUN — no writes performed. Re-run with --execute --snapshot-out <file>.\n');
    await sql.end();
    return;
  }

  // ── Execute preconditions ──────────────────────────────────────────────────
  if (!report.ceilingRespected) {
    throw new Error('ABORT: simulated distribution violates the hard ceiling. No writes performed.');
  }
  if (persistentBotsFlagOn()) {
    throw new Error('ABORT: PERSISTENT_BOTS flag is ON — burn-in must run before selection activates.');
  }
  const violations = await findNonPristineBots(roster.map((b) => b.userId));
  if (violations.length > 0) {
    const detail = violations.slice(0, 10).map((v) => `  ${v.nickname} (${v.userId}): ${v.reasons.join(', ')}`).join('\n');
    throw new Error(
      `ABORT: ${violations.length} roster bot(s) are not pristine — burn-in refuses to touch dirty state:\n${detail}`,
    );
  }

  const snapshotPath = resolve(args.snapshotOut!);
  const receiptPath = resolve(args.receiptOut ?? args.snapshotOut!.replace(/\.json$/, '') + '.receipt.jsonl');

  // ── Write-once snapshot + resume detection ─────────────────────────────────
  const isResume = existsSync(snapshotPath);
  let snapshot: BurnInSnapshot;
  if (isResume) {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as BurnInSnapshot;
    if (snapshot.manifestHash !== manifestHash) {
      throw new Error(
        `ABORT: existing snapshot is for a DIFFERENT run (manifest ${snapshot.manifestHash} != ${manifestHash}). ` +
          'Refusing to overwrite. Roll back the prior run or point --snapshot-out at a fresh file.',
      );
    }
    if (!existsSync(receiptPath)) {
      throw new Error(`ABORT: resume snapshot present but receipt ${receiptPath} is missing — cannot reconcile.`);
    }
    const parsed = parseReceipt(receiptPath);
    if (parsed.header.manifestHash !== manifestHash) {
      throw new Error(`ABORT: receipt header manifest ${parsed.header.manifestHash} != ${manifestHash}.`);
    }
    process.stdout.write(`\nRESUME: reusing snapshot + receipt for manifest ${manifestHash}.\n`);
  } else {
    if (existsSync(receiptPath)) {
      throw new Error(`ABORT: receipt ${receiptPath} exists but snapshot does not — inconsistent state, refusing.`);
    }
    snapshot = await snapshotProfiles(roster, {
      manifestHash,
      seed: args.seed,
      env,
      ceilingRp,
      humanTop10Rp,
      marginRp: args.marginRp,
    });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    process.stdout.write(`\nSnapshot written (write-once): ${snapshotPath}\n`);
  }

  // ── Append-only JSONL receipt ──────────────────────────────────────────────
  const receipt = new ReceiptWriter(receiptPath, isResume);
  if (!isResume) {
    receipt.writeHeader({
      kind: 'header',
      createdAt: new Date().toISOString(),
      manifestHash,
      seed: args.seed,
      env,
      rosterUserIds: roster.map((b) => b.userId),
    });
  }

  let written = 0;
  try {
    for (const fixture of schedule.fixtures) {
      // Durably record the PLANNED line BEFORE any DB write for this fixture, so
      // a crash mid-fixture still enumerates it on resume (finding 3).
      const line = {
        ordinal: fixture.ordinal,
        key: fixture.key,
        matchId: fixture.matchId,
        botAUserId: fixture.botAUserId,
        botBUserId: fixture.botBUserId,
        winnerUserId: fixture.winnerUserId,
        startedAt: fixture.startedAt.toISOString(),
        endedAt: fixture.endedAt.toISOString(),
      };
      receipt.writePlanned(line);
      await writeFixture(fixture, ceilingRp);
      receipt.writeWritten(line);
      written++;
      if (written % 100 === 0) {
        process.stdout.write(`  … ${written}/${schedule.fixtures.length} fixtures written\n`);
      }
    }
  } finally {
    receipt.close();
  }

  // Atomic one-time marker keyed by the run manifest (finding 9).
  await claimBurnInMarker(manifestHash, args.seed, schedule.fixtures.length);

  process.stdout.write(
    `\nEXECUTE complete: ${written} fixtures written.\nReceipt: ${receiptPath}\nSnapshot: ${snapshotPath}\n`,
  );
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(`\nburn-in failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
  void sql.end();
});
