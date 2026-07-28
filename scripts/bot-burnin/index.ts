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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  loadRoster,
  loadHumanTop10Rp,
  loadActiveCategoryIds,
  findNonPristineBots,
  claimRun,
  heartbeatRun,
  markRunComplete,
} from './data.js';
import { buildManifest, manifestHash as computeManifestHash } from './manifest.js';
import { buildSchedule } from './scheduler.js';
import { buildReport, formatReport } from './report.js';
import { snapshotProfiles, writeSnapshotExclusive, readSnapshot } from './snapshot.js';
import { writeFixture, type RunOwner } from './writer.js';
import { ReceiptWriter, parseReceipt } from './receipt.js';
import { assertDbTarget } from './target-guard.js';
import type { BurnInSnapshot } from './types.js';

const DEFAULT_SEASON_START = new Date('2026-07-21T00:00:00Z');
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
  seasonStart: Date;
  /**
   * The end of the backfill window — the scheduler's timeline horizon. For
   * --execute it is a REQUIRED explicit arg (no wall-clock default) so the
   * manifest hash H is stable across resume. Dry-run defaults to now().
   */
  seasonEnd: Date;
}

function parseDate(raw: string | undefined, flag: string): Date | undefined {
  if (raw == null) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Malformed date for ${flag}: ${raw}`);
  return d;
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
  const execute = has('--execute');
  const seasonEndArg = parseDate(get('--season-end') ?? get('--run-date'), '--season-end');
  // For --execute the window end MUST be explicit so H is resume-stable.
  if (execute && seasonEndArg == null) {
    throw new Error('--execute requires an explicit --season-end <ISO date> (no wall-clock default, so the run hash is stable across resume).');
  }
  return {
    paramsPath,
    seed: num(get('--seed')) ?? DEFAULT_SEED,
    target: num(get('--target')) ?? DEFAULT_TARGET,
    marginRp: num(get('--margin-rp')) ?? DEFAULT_MARGIN,
    execute,
    snapshotOut: get('--snapshot-out') ?? null,
    receiptOut: get('--receipt-out') ?? null,
    limit: num(get('--limit')) ?? null,
    seasonStart: parseDate(get('--season-start'), '--season-start') ?? DEFAULT_SEASON_START,
    seasonEnd: seasonEndArg ?? new Date(),
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
  // --limit is DRY-RUN ONLY: a partial burn plus a global one-time marker is
  // incoherent (the marker would claim a full burn while only a subset ran).
  if (args.execute && args.limit != null) {
    throw new Error('--limit is dry-run-only; refusing --execute --limit (a partial burn + global marker is incoherent).');
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
  // conservative absolute cap so bots never dominate an empty ladder. The
  // concrete ceilingRp is derived live and is NOT part of H (it drifts); it is
  // enforced per-fixture pre-commit instead.
  const ceilingRp = humanTop10Rp != null ? Math.max(0, humanTop10Rp - args.marginRp) : 1500 - args.marginRp;
  const env = (process.env.NODE_ENV ?? 'unknown').toString();

  const manifest = buildManifest({
    seed: args.seed,
    seasonStart: args.seasonStart,
    seasonEnd: args.seasonEnd,
    targetMatches: args.target,
    ceilingMarginRp: args.marginRp,
    params,
    bots: roster,
    categoryIds,
  });
  const manifestHash = computeManifestHash(manifest);

  const schedule = buildSchedule({
    bots: roster,
    params,
    seed: args.seed,
    seasonStart: args.seasonStart,
    // The scheduler's timeline horizon is the season window END (explicit for
    // --execute), so the plan — and thus every fixture key — is resume-stable.
    runDate: args.seasonEnd,
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

  // ── Execute preconditions (config-only, pre-lock) ──────────────────────────
  if (!report.ceilingRespected) {
    throw new Error('ABORT: simulated distribution violates the hard ceiling. No writes performed.');
  }
  if (persistentBotsFlagOn()) {
    throw new Error('ABORT: PERSISTENT_BOTS flag is ON — burn-in must run before selection activates.');
  }

  const snapshotPath = resolve(args.snapshotOut!);
  const receiptPath = resolve(args.receiptOut ?? args.snapshotOut!.replace(/\.json$/, '') + '.receipt.jsonl');

  // ── Single run-identity model, pooler-safe fail-closed lock (P1-3) ─────────
  // claimRun atomically applies the decision table under an xact advisory lock
  // and writes a durable LOCK-ROW (the marker, carrying our owner token +
  // heartbeat). Every fixture write re-checks that token fail-closed, so a lost
  // lock (takeover/rollback) stops further writes rather than racing on.
  const decision = await claimRun(manifestHash, args.seed);
  if (decision.kind === 'refuse') {
    throw new Error(`ABORT: ${decision.reason}`);
  }
  const isResume = decision.kind === 'resume';
  const owner: RunOwner = { manifestHash, ownerToken: decision.ownerToken };

  let snapshot: BurnInSnapshot;
  if (isResume) {
    // RESUME: the receipt is the source of truth — the pristine gate is
    // DELIBERATELY SKIPPED (a half-done run is not pristine). Same H proves the
    // plan is identical (P1-1: H excludes mutable state + wall clock).
    if (!existsSync(snapshotPath)) throw new Error(`ABORT: resume marker present but snapshot ${snapshotPath} is missing.`);
    snapshot = readSnapshot(snapshotPath);
    if (snapshot.manifestHash !== manifestHash) throw new Error(`ABORT: snapshot manifest ${snapshot.manifestHash} != ${manifestHash}.`);
    if (!existsSync(receiptPath)) throw new Error(`ABORT: resume snapshot present but receipt ${receiptPath} is missing.`);
    const parsed = parseReceipt(receiptPath);
    if (parsed.header.manifestHash !== manifestHash) throw new Error(`ABORT: receipt header manifest ${parsed.header.manifestHash} != ${manifestHash}.`);
    process.stdout.write(`\nRESUME (same H ${manifestHash}): pristine gate SKIPPED, reconciling from snapshot+receipt.\n`);
  } else {
    // FRESH: run the FULL pristine gate, then write-once snapshot.
    const violations = await findNonPristineBots(roster.map((b) => b.userId));
    if (violations.length > 0) {
      const detail = violations.slice(0, 12).map((v) => `  ${v.nickname} (${v.userId}): ${v.reasons.join(', ')}`).join('\n');
      throw new Error(`ABORT: ${violations.length} roster bot(s) are not pristine:\n${detail}`);
    }
    if (existsSync(receiptPath)) throw new Error(`ABORT: fresh run but receipt ${receiptPath} exists — inconsistent, refusing.`);
    snapshot = await snapshotProfiles(roster, { manifestHash, seed: args.seed, env, ceilingRp, humanTop10Rp, marginRp: args.marginRp });
    writeSnapshotExclusive(snapshotPath, snapshot); // 'wx' — refuses if present
    process.stdout.write(`\nFRESH run: pristine gate passed; snapshot written (write-once): ${snapshotPath}\n`);
  }

  const receipt = new ReceiptWriter(receiptPath, isResume);
  if (!isResume) {
    receipt.writeHeader({
      kind: 'header', createdAt: new Date().toISOString(), manifestHash,
      seed: args.seed, env, rosterUserIds: roster.map((b) => b.userId),
    });
  }
  let written = 0;
  try {
    for (const fixture of schedule.fixtures) {
      // Durably record the PLANNED line BEFORE any DB write (finding 3).
      const line = {
        ordinal: fixture.ordinal, key: fixture.key, matchId: fixture.matchId,
        botAUserId: fixture.botAUserId, botBUserId: fixture.botBUserId,
        winnerUserId: fixture.winnerUserId,
        startedAt: fixture.startedAt.toISOString(), endedAt: fixture.endedAt.toISOString(),
      };
      receipt.writePlanned(line);
      await writeFixture(fixture, owner, ceilingRp);
      receipt.writeWritten(line);
      written++;
      if (written % 25 === 0) {
        await heartbeatRun(manifestHash, owner.ownerToken); // keep the lock alive
      }
      if (written % 100 === 0) {
        process.stdout.write(`  … ${written}/${schedule.fixtures.length} fixtures written\n`);
      }
    }
  } finally {
    receipt.close();
  }

  // Flip the marker to 'complete' (verifies our ownership under the xact lock).
  await markRunComplete(manifestHash, owner.ownerToken, schedule.fixtures.length);

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
