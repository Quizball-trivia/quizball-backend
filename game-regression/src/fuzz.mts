/**
 * The fuzzer — "play a lot of games automatically and catch issues".
 *
 * Loops N full ranked-AI matches; each one is booted + played to completion, then
 * the referee runs EVERY check (trace invariants + post-match DB state). On the
 * first match that violates anything, it persists a failure ARTIFACT (the full
 * event trace, the violations, and a DB snapshot) and — by default — stops, so the
 * failing case is preserved for analysis. Clean matches just increment the counter.
 *
 * Reproducibility note: the harness AI answers from Math.random() (the durable
 * timer callback runs outside any seeded scope), so matches are NOT bit-for-bit
 * replayable by index. That's fine for fuzzing — variety is the point — and the
 * persisted full trace makes any failure analyzable without a replay.
 *
 * Run:
 *   FUZZ_COUNT=1000 \
 *   REGRESSION_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_regression \
 *   REGRESSION_REDIS_URL=redis://:changeme@127.0.0.1:6379 \
 *     npx tsx game-regression/src/fuzz.mts
 *
 * Env:
 *   FUZZ_COUNT            how many matches to play (default 50)
 *   FUZZ_STOP_ON_FAIL     '1' (default) stop at first failure; '0' keep going + tally
 *   FUZZ_PLAY_MAX_MS      per-match play budget (default 90000)
 *   FUZZ_ARTIFACT_DIR     where to write failure artifacts (default game-regression/artifacts)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.NODE_ENV = 'local';
process.env.DATABASE_URL = process.env.REGRESSION_DB_URL!;
process.env.REDIS_URL = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379';
process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
process.env.REGRESSION_DETERMINISTIC = '1';
process.env.REGRESSION_FAST_TIMERS = '1';
process.env.LOG_LEVEL = 'silent';

const { bootMatch, playMatch, teardownRun } = await import('./runner.mjs');
const { checkInvariants, formatViolation } = await import('./invariants.mjs');
const { checkPostMatchState, formatPostMatchViolation } = await import('./post-match.mjs');
const { reviewTrace, formatLlmFinding } = await import('./llm-reviewer.mjs');
const { sql } = await import('../../src/db/index.js');

const COUNT = Number(process.env.FUZZ_COUNT ?? 50);
const STOP_ON_FAIL = (process.env.FUZZ_STOP_ON_FAIL ?? '1') === '1';
const PLAY_MAX_MS = Number(process.env.FUZZ_PLAY_MAX_MS ?? 90_000);
const ARTIFACT_DIR = resolve(process.env.FUZZ_ARTIFACT_DIR ?? 'game-regression/artifacts');
// LLM judge: 0 = off (default, fast), N = review every Nth match (1 = every match).
// On a coded-invariant FAILURE the judge always runs to explain it.
const LLM_EVERY = Number(process.env.FUZZ_LLM_EVERY ?? 0);
// new Date() is unavailable in workflow scripts but fine in a plain tsx run; still,
// keep the run id index-based + a coarse epoch passed via env for stable artifact names.
const RUN_TAG = process.env.FUZZ_RUN_TAG ?? String(process.env.FUZZ_EPOCH ?? Math.floor(Date.now() / 1000));

interface MatchOutcome {
  index: number;
  matchId: string | null;
  booted: boolean;
  completed: boolean;
  ok: boolean;
  traceViolations: string[];
  postViolations: string[];
}

async function dbSnapshot(matchId: string): Promise<unknown> {
  // A compact snapshot of the rows that prove (or disprove) a clean settlement.
  const [match] = await sql`SELECT id, status, mode, winner_user_id, total_questions, state_payload FROM matches WHERE id = ${matchId}`;
  const players = await sql`SELECT user_id, seat, total_points, correct_answers, goals, penalty_goals FROM match_players WHERE match_id = ${matchId}`;
  const rp = await sql`SELECT user_id, old_rp, delta_rp, new_rp, result, is_placement FROM ranked_rp_changes WHERE match_id = ${matchId}`;
  const xp = await sql`SELECT user_id, source_type, xp_delta FROM user_xp_events WHERE source_key = ${matchId}`;
  return { match, players, rp, xp };
}

async function writeArtifact(outcome: MatchOutcome, trace: unknown, snapshot: unknown): Promise<string> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const path = resolve(ARTIFACT_DIR, `fail-${RUN_TAG}-m${outcome.index}.json`);
  await writeFile(path, JSON.stringify({
    runTag: RUN_TAG,
    index: outcome.index,
    matchId: outcome.matchId,
    booted: outcome.booted,
    completed: outcome.completed,
    traceViolations: outcome.traceViolations,
    postViolations: outcome.postViolations,
    dbSnapshot: snapshot,
    trace,
  }, null, 2));
  return path;
}

let passed = 0;
let failed = 0;
let bootFailures = 0;
const failures: Array<{ index: number; path: string; summary: string[] }> = [];
const llmFlaggedMatches: Array<{ index: number; ok: boolean; findings: string[] }> = [];

console.log(`[fuzz] running ${COUNT} matches | stopOnFail=${STOP_ON_FAIL} | llmEvery=${LLM_EVERY} | artifacts=${ARTIFACT_DIR}`);

for (let i = 1; i <= COUNT; i++) {
  let outcome: MatchOutcome = {
    index: i, matchId: null, booted: false, completed: false, ok: false,
    traceViolations: [], postViolations: [],
  };
  try {
    const run = await bootMatch({ startTimeoutMs: 25_000 });
    outcome.matchId = run.matchId;
    outcome.booted = !!run.matchId;

    if (!run.matchId) {
      bootFailures++;
      console.log(`[fuzz] #${i} BOOT FAILED`);
      await teardownRun();
      // A boot failure is environmental, not a game bug — don't stop the run.
      continue;
    }

    await playMatch(run, { maxMs: PLAY_MAX_MS });
    outcome.completed = run.trace.byEvent('match:final_results').length > 0;

    const inv = checkInvariants(run.trace);
    outcome.traceViolations = inv.violations.map(formatViolation);

    // Post-match settlement (RP/XP) is fire-and-forget; poll until it lands (or a
    // short ceiling) instead of a fixed sleep — faster on the common case.
    let post = await checkPostMatchState(run.matchId);
    const settleDeadline = Date.now() + 2_000;
    while (!post.ok && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      post = await checkPostMatchState(run.matchId);
    }
    outcome.postViolations = post.violations.map(formatPostMatchViolation);

    outcome.ok = outcome.completed && inv.ok && post.ok;

    // LLM judge: on every Nth match (FUZZ_LLM_EVERY) and ALWAYS on a failure (to
    // explain it). The judge is advisory — it logs findings but does NOT change
    // pass/fail (the coded invariants are the gate). It catches "looks wrong but
    // passed the rules" cases the invariants don't encode.
    const judgeThis = (LLM_EVERY > 0 && i % LLM_EVERY === 0) || !outcome.ok;
    if (judgeThis) {
      const variant = (run.trace.byEvent('match:start')[0]?.payload as { variant?: string } | undefined)?.variant;
      const review = await reviewTrace(run.trace, { variant, note: outcome.ok ? undefined : 'This match FAILED a coded invariant; explain what went wrong.' });
      if (review.findings.length > 0) {
        llmFlaggedMatches.push({ index: i, ok: outcome.ok, findings: review.findings.map(formatLlmFinding) });
        console.log(`[fuzz] #${i} 🔎 LLM flagged ${review.findings.length} (match invariants ${outcome.ok ? 'PASSED' : 'FAILED'}):`);
        for (const f of review.findings) console.log(`        ${formatLlmFinding(f)}`);
      } else if (LLM_EVERY > 0) {
        console.log(`[fuzz] #${i} 🔎 LLM: clean`);
      }
    }

    if (outcome.ok) {
      passed++;
      if (i % 25 === 0) console.log(`[fuzz] #${i} ok (passed=${passed})`);
    } else {
      failed++;
      const snapshot = await dbSnapshot(run.matchId);
      const path = await writeArtifact(outcome, run.trace.events, snapshot);
      const summary = [
        !outcome.completed ? 'did NOT complete (no final_results)' : null,
        ...outcome.traceViolations,
        ...outcome.postViolations,
      ].filter((x): x is string => !!x);
      failures.push({ index: i, path, summary });
      console.log(`\n[fuzz] #${i} ✗ FAIL — artifact: ${path}`);
      for (const s of summary) console.log(`        ${s}`);
      await teardownRun();
      if (STOP_ON_FAIL) break;
      continue;
    }
  } catch (err) {
    failed++;
    console.log(`[fuzz] #${i} ✗ THREW: ${(err as Error).message}`);
    failures.push({ index: i, path: '(threw, no artifact)', summary: [(err as Error).message] });
    try { await teardownRun(); } catch { /* ignore */ }
    if (STOP_ON_FAIL) break;
    continue;
  }
  await teardownRun();
}

console.log(`\n[fuzz] DONE: passed=${passed} failed=${failed} bootFailures=${bootFailures} (of ${COUNT})`);
if (llmFlaggedMatches.length > 0) {
  console.log(`\n[fuzz] LLM JUDGE flagged ${llmFlaggedMatches.length} match(es) (advisory — review these):`);
  for (const m of llmFlaggedMatches) {
    console.log(`  #${m.index} (invariants ${m.ok ? 'PASSED' : 'FAILED'}):`);
    for (const f of m.findings) console.log(`     ${f}`);
  }
} else if (LLM_EVERY > 0) {
  console.log('[fuzz] LLM JUDGE: no findings on any reviewed match.');
}
if (failures.length > 0) {
  console.log('[fuzz] failures:');
  for (const f of failures) console.log(`  #${f.index}: ${f.summary[0]} -> ${f.path}`);
  process.exit(1);
}
process.exit(0);
