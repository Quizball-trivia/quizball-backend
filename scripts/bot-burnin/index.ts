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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from '../../src/db/index.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  loadRoster,
  loadHumanTop10Rp,
  loadActiveCategoryIds,
  findNonPristineBots,
  lockBurnIn,
  assertNotBurnedIn,
  insertBurnInMarker,
  validatedExistingMatchIds,
  lockRosterGateRows,
} from './data.js';
import { buildManifest, manifestHash as computeManifestHash } from './manifest.js';
import { buildSchedule } from './scheduler.js';
import { buildReport, formatReport } from './report.js';
import { writeFixtureInTx } from './writer.js';
import { assertDbTarget } from './target-guard.js';

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
  limit: number | null;
  seasonStart: Date;
  /**
   * The end of the backfill window — the scheduler's timeline horizon. For
   * --execute it is a REQUIRED explicit arg (no wall-clock default) so the run
   * is fully determined by its immutable inputs. Dry-run defaults to now().
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

  // ── Execute preconditions (config-only) ────────────────────────────────────
  if (!report.ceilingRespected) {
    // Defensive: planning enforces the ceiling by construction, so this should
    // never fire. If it does, the plan is buggy — abort before any write.
    throw new Error('ABORT: simulated distribution violates the hard ceiling. No writes performed.');
  }
  if (persistentBotsFlagOn()) {
    throw new Error('ABORT: PERSISTENT_BOTS flag is ON — burn-in must run before selection activates.');
  }

  // ── EXECUTE: chronological CHUNK batches ───────────────────────────────────
  // The plan (deterministic from H's immutable inputs) is written in CHUNKS,
  // each chunk in its OWN committed transaction, in the scheduler's chronological
  // order. A crash leaves a committed chronological PREFIX (every bot's history
  // up to that point is self-consistent) and rolls back only the in-flight chunk
  // — corruption-free. A rerun re-plans identically and SKIPS already-written
  // fixtures (idempotent by deterministic match id), so it resumes from the
  // first unwritten fixture. Each chunk-tx takes the xact advisory lock (serialize
  // vs concurrent runs) and re-asserts the one-time marker; the marker is only
  // inserted after the FINAL chunk. The write-time RP-equality belt guarantees
  // each fixture settles to exactly its projected RP regardless of chunk seams.
  const rosterIds = roster.map((b) => b.userId);
  const fixtures = schedule.fixtures;

  // Idempotent resume: skip fixtures already written by a prior (crashed) run.
  const alreadyWritten = await validatedExistingMatchIds(fixtures);
  const remaining = fixtures.filter((f) => !alreadyWritten.has(f.matchId));

  // Pristine gate applies ONLY to bots not yet touched by a prior partial run
  // (a bot with a committed burn-in fixture is legitimately non-pristine now).
  const writtenBots = new Set<string>();
  for (const f of fixtures) {
    if (alreadyWritten.has(f.matchId)) { writtenBots.add(f.botAUserId); writtenBots.add(f.botBUserId); }
  }
  const untouchedBotIds = rosterIds.filter((id) => !writtenBots.has(id));

  const CHUNK = 250;
  let written = 0;
  let gateChecked = false;
  for (let i = 0; i < remaining.length; i += CHUNK) {
    const chunk = remaining.slice(i, i + CHUNK);
    const isLastChunk = i + CHUNK >= remaining.length;
    await sql.begin(async (tx) => {
      await lockBurnIn(tx); // serialize vs concurrent runs (released on commit)
      await assertNotBurnedIn(tx); // one-time guard (marker inserted only at the end)

      // Pristine gate under FOR UPDATE row locks across EVERY table the gate
      // reads (P2/P3-pristine-race), once, in the first chunk — UNTOUCHED bots.
      if (!gateChecked) {
        if (untouchedBotIds.length > 0) {
          await lockRosterGateRows(tx, untouchedBotIds);
          const violations = await findNonPristineBots(tx, untouchedBotIds);
          if (violations.length > 0) {
            const detail = violations.slice(0, 12).map((v) => `  ${v.nickname} (${v.userId}): ${v.reasons.join(', ')}`).join('\n');
            throw new Error(`ABORT: ${violations.length} roster bot(s) are not pristine:\n${detail}`);
          }
        }
        gateChecked = true;
      }

      for (const fixture of chunk) {
        await writeFixtureInTx(tx, fixture);
      }

      // The completion marker lands in the SAME tx as the last chunk, so a crash
      // before the final chunk never leaves a 'complete' marker.
      if (isLastChunk) {
        await insertBurnInMarker(tx, manifestHash, args.seed, fixtures.length, ceilingRp);
      }
    });
    written += chunk.length;
    process.stdout.write(`  … ${written}/${remaining.length} fixtures written (chunk committed)\n`);
  }

  // No remaining fixtures (a fully-resumed run) but no marker yet → finalize.
  if (remaining.length === 0) {
    await sql.begin(async (tx) => {
      await lockBurnIn(tx);
      await assertNotBurnedIn(tx);
      await insertBurnInMarker(tx, manifestHash, args.seed, fixtures.length, ceilingRp);
    });
  }

  process.stdout.write(
    `\nEXECUTE complete: ${fixtures.length} fixtures (${written} newly written, ${alreadyWritten.size} pre-existing) for manifest ${manifestHash}.\n`,
  );
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(`\nburn-in failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
  void sql.end();
});
