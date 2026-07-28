#!/usr/bin/env npx tsx
/**
 * One-time persistent-bot burn-in engine (PR6).
 *
 * Seeds each persistent roster bot from the Season-2 human ladder shape, then
 * adds a short backdated ranked bot-vs-bot history using the real RP formula.
 *
 * DRY-RUN IS THE DEFAULT — simulates the full plan, prints the distribution
 * report, and performs zero writes. --execute performs the backdated writes.
 *
 * Burn-in is a PRISTINE-STATE operation: it runs ONCE, immediately after roster
 * creation, BEFORE selection ever activates. --execute refuses unless every
 * roster bot is exactly pristine and the PERSISTENT_BOTS flag is OFF.
 *
 *   npm run bot:burnin -- --params /abs/params.json --limit 20
 *   npm run bot:burnin -- --params <p> --execute --season-end 2026-07-28
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
  claimRunning,
  assertRunClaim,
  completeRun,
  validatedExistingMatchIds,
  lockRosterGateRows,
} from './data.js';
import { buildManifest, manifestHash as computeManifestHash } from './manifest.js';
import { buildSchedule } from './scheduler.js';
import { buildReport, formatReport } from './report.js';
import { writeFixtureChunkInTx, writeSeededProfilesInTx } from './writer.js';
import { assertDbTarget } from './target-guard.js';
import { solveSeeds } from './seed-solver.js';

const DEFAULT_SEASON_START = new Date('2026-07-21T00:00:00Z');
const DEFAULT_SEED = 20260721;
export const RECENT_MATCHES = 12;
export const DEFAULT_MARGIN = 50;
export const DEFAULT_HUMAN_TOP10 = 2615;

interface Args {
  paramsPath: string;
  seed: number;
  recentMatches: number;
  marginRp: number;
  humanTop10RpOverride: number | null;
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
  // Require an explicit ISO-8601 date/datetime (e.g. 2026-07-28 or
  // 2026-07-28T00:00:00Z) — reject loose strings like "2026" or "next week"
  // that Date() would silently accept, so the season window is unambiguous.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    throw new Error(`Malformed date for ${flag}: '${raw}' — expected ISO-8601 (e.g. 2026-07-28 or 2026-07-28T00:00:00Z).`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Malformed date for ${flag}: '${raw}'.`);
  return d;
}

/** Switches that take NO value. */
const BOOLEAN_FLAGS = ['--execute', '--allow-remote'] as const;
/** Flags that REQUIRE a following value. */
const VALUE_FLAGS = [
  '--params',
  '--seed',
  '--recent-matches',
  '--margin-rp',
  '--human-top10-rp',
  '--limit',
  '--season-start',
  '--season-end',
  '--run-date',
] as const;
const KNOWN_FLAGS: readonly string[] = [...BOOLEAN_FLAGS, ...VALUE_FLAGS];

function knownFlagList(): string {
  return `Valid flags:\n  ${[...KNOWN_FLAGS].sort().join('\n  ')}`;
}

/**
 * Reject anything argv-shaped we do not recognise, BEFORE any planning or DB
 * work (#343).
 *
 * WHY: burn-in is a one-time, marker-guarded operation — on prod there is no
 * second attempt without a rollback. The parser used to look up only the flags
 * it knew and silently ignore everything else, so a typo'd flag
 * (`--margin` for `--margin-rp`) silently reverted to a DEFAULT while the
 * operator believed they had overridden the ladder. The staging run was in fact
 * launched with a `--snapshot-out` that does not exist and was accepted without
 * a word.
 */
function validateArgv(argv: string[]): void {
  const errors: string[] = [];
  const valueFlags = new Set<string>(VALUE_FLAGS);
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue; // a value consumed by its flag

    // `--flag=value` is not supported by the `--flag value` parser; naming it
    // explicitly beats "unknown flag --seed=7".
    if (token.includes('=')) {
      const [name] = token.split('=', 1);
      errors.push(
        KNOWN_FLAGS.includes(name)
          ? `${name} must be passed as '${name} <value>', not '${token}'.`
          : `Unknown flag: ${token}`,
      );
      continue;
    }

    if (!KNOWN_FLAGS.includes(token)) {
      errors.push(`Unknown flag: ${token}`);
      continue;
    }
    if (seen.has(token)) errors.push(`Flag passed more than once: ${token}`);
    seen.add(token);

    if (valueFlags.has(token)) {
      const value = argv[i + 1];
      // A missing value, or ANY `--`-prefixed next token, means the flag was
      // passed without its value. Checking only for KNOWN flags here would let
      // `--params --snapshot-out` bind the unknown flag as the params path —
      // the exact silent-acceptance failure this validation exists to stop.
      // The unknown token is still reported on its own iteration.
      if (value == null || value.startsWith('--')) {
        errors.push(`${token} requires a value.`);
      } else {
        i++; // consume the value so it is never mistaken for a flag
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid arguments:\n  ${errors.join('\n  ')}\n\n${knownFlagList()}`);
  }
}

function parseArgs(argv: string[]): Args {
  validateArgv(argv);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (flag: string) => argv.includes(flag);
  const num = (v: string | undefined, flag: string): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    // Must ERROR, never fall through to the default: a typo'd numeric value
    // silently reverting to DEFAULT_MARGIN / DEFAULT_HUMAN_TOP10 changes the
    // planned ladder while the operator believes they overrode it.
    if (v.trim() === '' || !Number.isFinite(n)) {
      throw new Error(`Malformed numeric value for ${flag}: '${v}' — expected a finite number.`);
    }
    return n;
  };
  const paramsPath = get('--params');
  if (!paramsPath) throw new Error('--params <file> is required (zod-validated calibration params).');
  const execute = has('--execute');
  // --run-date is a legacy alias for --season-end; validate under whichever flag
  // the user actually passed so the error names the right flag.
  const seasonEndRaw = get('--season-end');
  const seasonEndArg = seasonEndRaw != null
    ? parseDate(seasonEndRaw, '--season-end')
    : parseDate(get('--run-date'), '--run-date');
  // For --execute the window end MUST be explicit so H is resume-stable.
  if (execute && seasonEndArg == null) {
    throw new Error('--execute requires an explicit --season-end <ISO date> (no wall-clock default, so the run hash is stable across resume).');
  }
  const limit = num(get('--limit'), '--limit') ?? null;
  // --limit is DRY-RUN ONLY: a partial burn plus a global one-time marker is
  // incoherent (the marker would claim a full burn while only a subset ran).
  if (execute && limit != null) {
    throw new Error('--limit is dry-run-only; refusing --execute --limit (a partial burn + global marker is incoherent).');
  }
  return {
    paramsPath,
    seed: num(get('--seed'), '--seed') ?? DEFAULT_SEED,
    recentMatches: num(get('--recent-matches'), '--recent-matches') ?? RECENT_MATCHES,
    marginRp: num(get('--margin-rp'), '--margin-rp') ?? DEFAULT_MARGIN,
    humanTop10RpOverride: num(get('--human-top10-rp'), '--human-top10-rp') ?? DEFAULT_HUMAN_TOP10,
    execute,
    limit,
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
  // Arg validation FIRST: every argv error (unknown flag, missing value,
  // malformed number/date, --execute --limit) surfaces before the tool looks at
  // a database at all.
  const args = parseArgs(argv);
  assertDbTarget(process.env.DATABASE_URL ?? '', { allowRemote: argv.includes('--allow-remote') });

  const params = parseBotModelParams(JSON.parse(readFileSync(resolve(args.paramsPath), 'utf8')));

  // --human-top10-rp lets a staging burn-in use the PROD human frontier for the
  // ceiling (staging has almost no ranked humans, which would compress every bot
  // into the bottom tier). The bots still WRITE to the connected DB; only the
  // ceiling reference comes from the override.
  const [roster, liveHumanTop10Rp, categoryIds] = await Promise.all([
    loadRoster(args.limit),
    args.humanTop10RpOverride != null ? Promise.resolve<number | null>(args.humanTop10RpOverride) : loadHumanTop10Rp(),
    loadActiveCategoryIds(),
  ]);
  const humanTop10Rp = liveHumanTop10Rp;

  if (roster.length < 2) throw new Error(`Roster too small to pair (${roster.length} bots).`);
  if (categoryIds.length === 0) throw new Error('No active categories to draw from.');

  // Ceiling: human #10 − margin. If fewer than 10 placed humans, fall back to a
  // conservative absolute cap so bots never dominate an empty ladder. The
  // concrete ceilingRp is derived live and is NOT part of H (it drifts); it is
  // enforced per-fixture pre-commit instead.
  const ceilingRp = humanTop10Rp != null ? Math.max(0, humanTop10Rp - args.marginRp) : 1500 - args.marginRp;
  const manifest = buildManifest({
    seed: args.seed,
    seasonStart: args.seasonStart,
    seasonEnd: args.seasonEnd,
    targetMatches: args.recentMatches,
    ceilingMarginRp: args.marginRp,
    params,
    bots: roster,
    categoryIds,
  });
  const manifestHash = computeManifestHash(manifest);

  const planWith = (seedOverrides?: ReadonlyMap<string, number>) =>
    buildSchedule({
      bots: roster,
      params,
      seed: args.seed,
      seasonStart: args.seasonStart,
      // The scheduler's timeline horizon is the season window END (explicit for
      // --execute), so the plan — and thus every fixture key — is resume-stable.
      runDate: args.seasonEnd,
      targetMatches: args.recentMatches,
      ceilingRp,
      categoryIds,
      manifestHash,
      seedOverrides,
    });

  const solved = solveSeeds({
    bots: roster,
    ceilingRp,
    seed: args.seed,
    planFinalRp: (seedByUserId) =>
      new Map(planWith(seedByUserId).finalBots.map((bot) => [bot.userId, bot.rp])),
  });

  const schedule = planWith(solved.seedByUserId);

  const report = buildReport({
    bots: roster,
    seed: args.seed,
    finalBots: schedule.finalBots,
    fixtures: schedule.fixtures,
    ceilingRp,
    humanTop10Rp,
    seededBots: schedule.seededBots,
    seedSolver: {
      iterations: solved.iterations,
      maxResidual: solved.maxResidual,
      converged: solved.converged,
    },
  });
  process.stdout.write(formatReport(report));
  process.stdout.write(`\nRun manifest hash: ${manifestHash}\n`);

  if (!args.execute) {
    process.stdout.write('\nDRY-RUN — no writes performed. Re-run with --execute --season-end <ISO>.\n');
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
  // The Stage-A write MUST use the SOLVED seeds the plan was projected from —
  // re-deriving the raw S2 seeds here would desync the profile from the
  // scheduler's projection and trip the writer's settled-equals-projected belt.
  const seededBots = schedule.seededBots;

  const CHUNK = 250;
  let written = 0;
  // Our durable run claim — set in the first tx, re-checked in every later tx,
  // flipped to 'complete' in the last. This blocks concurrent --execute runs
  // that interleave between chunks (the per-chunk advisory lock alone does not,
  // since it releases on each commit).
  let runId: string | null = null;

  const chunks: (typeof remaining)[] = [];
  for (let i = 0; i < remaining.length; i += CHUNK) chunks.push(remaining.slice(i, i + CHUNK));
  // A fully-resumed run (nothing remaining) still needs a finalize tx to claim
  // (take over the stale prior claim) + complete. Represent it as one empty tx.
  const passes = chunks.length > 0 ? chunks : [[]];

  for (let ci = 0; ci < passes.length; ci++) {
    const chunk = passes[ci];
    const isFirst = ci === 0;
    const isLast = ci === passes.length - 1;
    await sql.begin(async (tx) => {
      await lockBurnIn(tx); // serialize this tx vs concurrent runs

      if (isFirst) {
        // Claim the run (insert/takeover 'running') — refuses on a concurrent
        // live run or a completed run.
        runId = await claimRunning(tx, manifestHash, args.seed, ceilingRp);
        if (alreadyWritten.size === 0) {
          await lockRosterGateRows(tx, rosterIds);
          const violations = await findNonPristineBots(tx, rosterIds);
          if (violations.length > 0) {
            const detail = violations.slice(0, 12).map((v) => `  ${v.nickname} (${v.userId}): ${v.reasons.join(', ')}`).join('\n');
            throw new Error(`ABORT: ${violations.length} roster bot(s) are not pristine:\n${detail}`);
          }
          await writeSeededProfilesInTx(tx, seededBots);
        }
      } else {
        // Every later chunk re-asserts our claim fail-closed (a takeover aborts).
        await assertRunClaim(tx, manifestHash, runId!);
      }

      // Batched: the whole chunk in a handful of statements instead of ~7 per
      // fixture (#343). Identical final state — the per-fixture writer never
      // reads its own writes through SQL, so the row states it would re-SELECT
      // are folded in memory instead.
      await writeFixtureChunkInTx(tx, chunk);

      // 'complete' lands in the SAME tx as the last chunk, so a crash before the
      // final chunk never leaves a 'complete' marker (only 'running').
      if (isLast) {
        await completeRun(tx, manifestHash, runId!, fixtures.length);
      }
    });
    written += chunk.length;
    if (chunk.length > 0) process.stdout.write(`  … ${written}/${remaining.length} fixtures written (chunk committed)\n`);
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
