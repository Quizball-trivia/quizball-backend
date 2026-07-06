/**
 * The fuzzer — "play a lot of games automatically and catch issues".
 *
 * Run:
 *   FUZZ_COUNT=1000 \
 *   FUZZ_CHAOS=1 \
 *   REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *   REGRESSION_REDIS_URL=redis://localhost:6379/15 \
 *     npx tsx game-regression/src/fuzz.mts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventTrace } from './adapter.mjs';
import type { ChaosPlan } from './chaos.mjs';

process.env.NODE_ENV = 'local';
process.env.DATABASE_URL = process.env.REGRESSION_DB_URL!;
process.env.REDIS_URL = process.env.REGRESSION_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
process.env.REGRESSION_DETERMINISTIC = '1';
process.env.REGRESSION_FAST_TIMERS = '1';
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const {
  bootMatch,
  playMatch,
  bootFriendlyLobbyMatch,
  playLobbyMatch,
  teardownRun,
} = await import('./runner.mjs');
const {
  checkInvariants,
  checkLifecycleInvariants,
  formatViolation,
} = await import('./invariants.mjs');
const { checkPartyInvariants } = await import('./party-invariants.mjs');
const { checkPostMatchState, formatPostMatchViolation } = await import('./post-match.mjs');
const {
  answerPlanFromChaosPlan,
  chaosActionsSummary,
  deriveChaosSeed,
  generateChaosPlan,
  planAllowsEarlyTerminal,
  planUsesWithheldReadyAcks,
} = await import('./chaos.mjs');
const { sql } = await import('../../src/db/index.js');

const COUNT = Number(process.env.FUZZ_COUNT ?? 50);
const STOP_ON_FAIL = (process.env.FUZZ_STOP_ON_FAIL ?? '1') === '1';
const PLAY_MAX_MS = Number(process.env.FUZZ_PLAY_MAX_MS ?? 90_000);
const ARTIFACT_DIR = resolve(process.env.FUZZ_ARTIFACT_DIR ?? 'game-regression/artifacts');
const MODE = (process.env.FUZZ_MODE ?? 'ranked') as FuzzMode | 'mix';
const RUN_TAG = process.env.FUZZ_RUN_TAG ?? String(process.env.FUZZ_EPOCH ?? Math.floor(Date.now() / 1000));
const CHAOS_ENABLED =
  process.env.FUZZ_CHAOS !== undefined &&
  !['0', 'false', 'off'].includes(process.env.FUZZ_CHAOS.toLowerCase());
const CHAOS_BASE_SEED = process.env.FUZZ_CHAOS_SEED;
const MIX_ROTATION = ['ranked', 'possession', 'party'] as const;

export type FuzzMode = 'ranked' | 'possession' | 'party';

export interface MatchOutcome {
  index: number;
  mode: FuzzMode;
  matchId: string | null;
  booted: boolean;
  completed: boolean;
  ok: boolean;
  chaosPlan: ChaosPlan | null;
  traceViolations: string[];
  lifecycleViolations: string[];
  postViolations: string[];
  violations: string[];
  artifactPath?: string;
  error?: string;
}

export interface RunFuzzMatchOptions {
  index: number;
  mode?: FuzzMode;
  playMaxMs?: number;
  chaosEnabled?: boolean;
  chaosPlan?: ChaosPlan | null;
  runTag?: string;
  artifactDir?: string;
  writeArtifactOnFailure?: boolean;
}

function modeFor(i: number): FuzzMode {
  if (MODE === 'mix') return MIX_ROTATION[(i - 1) % MIX_ROTATION.length];
  return MODE;
}

function planForMatch(options: RunFuzzMatchOptions, mode: FuzzMode): ChaosPlan | null {
  if (options.chaosPlan !== undefined) return options.chaosPlan;
  const enabled = options.chaosEnabled ?? CHAOS_ENABLED;
  if (!enabled || mode !== 'ranked') return null;
  const seed = deriveChaosSeed(options.runTag ?? RUN_TAG, options.index, CHAOS_BASE_SEED);
  return generateChaosPlan(seed);
}

async function dbSnapshot(matchId: string, chaosPlan: ChaosPlan | null): Promise<unknown> {
  const [match] = await sql`SELECT id, status, mode, winner_user_id, total_questions, state_payload FROM matches WHERE id = ${matchId}`;
  const players = await sql`SELECT user_id, seat, total_points, correct_answers, goals, penalty_goals FROM match_players WHERE match_id = ${matchId}`;
  const answers = await sql`SELECT q_index, user_id, time_ms, points_earned, phase_kind FROM match_answers WHERE match_id = ${matchId} ORDER BY q_index, user_id`;
  const rp = await sql`SELECT user_id, old_rp, delta_rp, new_rp, result, is_placement FROM ranked_rp_changes WHERE match_id = ${matchId}`;
  const xp = await sql`SELECT user_id, source_type, xp_delta FROM user_xp_events WHERE source_key = ${matchId}`;
  return { match, players, answers, rp, xp, chaosPlan };
}

async function writeArtifact(
  outcome: MatchOutcome,
  trace: unknown,
  snapshot: unknown,
  artifactDir = ARTIFACT_DIR,
  runTag = RUN_TAG,
): Promise<string> {
  await mkdir(artifactDir, { recursive: true });
  const path = resolve(artifactDir, `fail-${runTag}-m${outcome.index}.json`);
  await writeFile(path, JSON.stringify({
    runTag,
    index: outcome.index,
    mode: outcome.mode,
    matchId: outcome.matchId,
    booted: outcome.booted,
    completed: outcome.completed,
    chaosPlan: outcome.chaosPlan,
    traceViolations: outcome.traceViolations,
    lifecycleViolations: outcome.lifecycleViolations,
    postViolations: outcome.postViolations,
    error: outcome.error,
    dbSnapshot: snapshot,
    trace,
  }, null, 2));
  return path;
}

async function waitForPostMatch(matchId: string, options: { allowAbandoned?: boolean } = {}) {
  let post = await checkPostMatchState(matchId, options);
  const settleDeadline = Date.now() + 2_000;
  while (!post.ok && Date.now() < settleDeadline) {
    await new Promise((r) => setTimeout(r, 100));
    post = await checkPostMatchState(matchId, options);
  }
  return post;
}

export async function runFuzzMatch(options: RunFuzzMatchOptions): Promise<MatchOutcome> {
  const mode = options.mode ?? modeFor(options.index);
  const chaosPlan = planForMatch(options, mode);
  const outcome: MatchOutcome = {
    index: options.index,
    mode,
    matchId: null,
    booted: false,
    completed: false,
    ok: false,
    chaosPlan,
    traceViolations: [],
    lifecycleViolations: [],
    postViolations: [],
    violations: [],
  };

  let trace: EventTrace | null = null;
  let matchId: string | null = null;
  let terminalAccepted = false;

  try {
    if (mode === 'ranked') {
      const run = await bootMatch({
        startTimeoutMs: 25_000,
        autoClientReadyAcks: !planUsesWithheldReadyAcks(chaosPlan),
      });
      trace = run.trace;
      matchId = run.matchId;
      outcome.matchId = matchId;
      outcome.booted = Boolean(matchId);
      if (matchId) {
        await playMatch(run, {
          maxMs: options.playMaxMs ?? PLAY_MAX_MS,
          chaosPlan: chaosPlan ?? undefined,
          answerPlan: answerPlanFromChaosPlan(chaosPlan),
        });
      }
      if (!matchId) {
        outcome.violations = ['BOOT_FAILED'];
        return outcome;
      }
      const allowEarlyTerminal = planAllowsEarlyTerminal(chaosPlan);
      outcome.completed = trace.byEvent('match:final_results').length > 0;
      const inv = checkInvariants(trace);
      const post = await waitForPostMatch(matchId, { allowAbandoned: allowEarlyTerminal });
      terminalAccepted = outcome.completed || (allowEarlyTerminal && post.facts.status === 'abandoned');
      const traceViolations = terminalAccepted && post.facts.status === 'abandoned'
        ? inv.violations.filter((violation) => violation.invariant !== 'terminalStateReached')
        : inv.violations;
      outcome.traceViolations = traceViolations.map(formatViolation);
      outcome.postViolations = post.violations.map(formatPostMatchViolation);
      const lifecycle = await checkLifecycleInvariants(trace, {
        matchId,
        botUserId: run.botUserId,
        chaosPlan,
        runChaosLifecycleInvariants: Boolean(chaosPlan?.actions.length),
      });
      outcome.lifecycleViolations = lifecycle.violations.map(formatViolation);
      outcome.ok = terminalAccepted && traceViolations.length === 0 && post.ok && lifecycle.ok;
    } else {
      const variant = mode === 'party' ? 'friendly_party_quiz' : 'friendly_possession';
      const run = await bootFriendlyLobbyMatch({ variant, startTimeoutMs: 25_000 });
      trace = run.trace;
      matchId = run.matchId;
      outcome.matchId = matchId;
      outcome.booted = Boolean(matchId);
      if (matchId) await playLobbyMatch(run, { maxMs: options.playMaxMs ?? PLAY_MAX_MS });
      if (!matchId) {
        outcome.violations = ['BOOT_FAILED'];
        return outcome;
      }
      outcome.completed = trace.byEvent('match:final_results').length > 0;
      terminalAccepted = outcome.completed;
      const inv = mode === 'party' ? checkPartyInvariants(trace) : checkInvariants(trace);
      outcome.traceViolations = inv.violations.map(formatViolation);
      const post = await waitForPostMatch(matchId);
      outcome.postViolations = post.violations.map(formatPostMatchViolation);
      if (mode === 'possession') {
        const lifecycle = await checkLifecycleInvariants(trace, {
          matchId,
          botUserId: run.hostUserId,
          chaosPlan: null,
          runChaosLifecycleInvariants: false,
        });
        outcome.lifecycleViolations = lifecycle.violations.map(formatViolation);
      }
      outcome.ok = outcome.completed && inv.ok && post.ok && outcome.lifecycleViolations.length === 0;
    }

    outcome.violations = [
      !terminalAccepted ? 'did NOT complete (no final_results)' : null,
      ...outcome.traceViolations,
      ...outcome.lifecycleViolations,
      ...outcome.postViolations,
    ].filter((value): value is string => Boolean(value));

    if (!outcome.ok && options.writeArtifactOnFailure !== false && trace && matchId) {
      const snapshot = await dbSnapshot(matchId, chaosPlan);
      outcome.artifactPath = await writeArtifact(
        outcome,
        trace.events,
        snapshot,
        options.artifactDir,
        options.runTag,
      );
    }
  } catch (err) {
    outcome.error = (err as Error).message;
    outcome.violations = [outcome.error];
    if (options.writeArtifactOnFailure !== false && trace && matchId) {
      const snapshot = await dbSnapshot(matchId, chaosPlan).catch((snapshotErr) => ({
        snapshotError: (snapshotErr as Error).message,
      }));
      outcome.artifactPath = await writeArtifact(
        outcome,
        trace.events,
        snapshot,
        options.artifactDir,
        options.runTag,
      );
    }
  }

  return outcome;
}

export async function runFuzz(): Promise<{ passed: number; failed: number; bootFailures: number; failures: MatchOutcome[] }> {
  let passed = 0;
  let failed = 0;
  let bootFailures = 0;
  const failures: MatchOutcome[] = [];

  if (process.env.FUZZ_LLM_EVERY) {
    console.log('[fuzz] FUZZ_LLM_EVERY is ignored: the LLM judge was removed; coded trace invariants are the gate.');
  }

  console.log(
    `[fuzz] running ${COUNT} matches | stopOnFail=${STOP_ON_FAIL} | chaos=${CHAOS_ENABLED} | artifacts=${ARTIFACT_DIR}`,
  );

  for (let i = 1; i <= COUNT; i += 1) {
    const mode = modeFor(i);
    const outcome = await runFuzzMatch({ index: i, mode, writeArtifactOnFailure: true });
    const seed = outcome.chaosPlan ? String(outcome.chaosPlan.seed) : 'none';
    const actions = chaosActionsSummary(outcome.chaosPlan);
    const status = outcome.ok ? 'PASS' : outcome.booted ? 'FAIL' : 'BOOT_FAILED';
    console.log(`[fuzz] #${i} mode=${mode} seed=${seed} actions=${actions} ${status}`);

    if (!outcome.booted) {
      bootFailures += 1;
      await teardownRun();
      continue;
    }

    if (outcome.ok) {
      passed += 1;
    } else {
      failed += 1;
      failures.push(outcome);
      if (outcome.artifactPath) console.log(`        artifact: ${outcome.artifactPath}`);
      for (const violation of outcome.violations) console.log(`        ${violation}`);
      await teardownRun();
      if (STOP_ON_FAIL) break;
      continue;
    }
    await teardownRun();
  }

  return { passed, failed, bootFailures, failures };
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
}

if (isMainModule()) {
  const result = await runFuzz();
  console.log(`\n[fuzz] DONE: passed=${result.passed} failed=${result.failed} bootFailures=${result.bootFailures} (of ${COUNT})`);
  if (result.failures.length > 0) {
    console.log('[fuzz] failures:');
    for (const failure of result.failures) {
      console.log(`  #${failure.index}: ${failure.violations[0] ?? failure.error ?? 'failed'} -> ${failure.artifactPath ?? '(no artifact)'}`);
    }
    process.exit(1);
  }
  process.exit(0);
}
