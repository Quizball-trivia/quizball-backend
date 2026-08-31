import { afterEach, describe, expect, it } from 'vitest';
import type { LobbyAnswerPlanner } from '../../game-regression/src/runner.mjs';

// Penalty GAUNTLET — full-engine scenarios for the tie-break + deterministic
// reveal-window fixes (see penalty-tiebreak.test.ts for the unit level, and
// the prod incident they trace back to: 23% of shootouts past regulation,
// match 2e85cbbb at 18 rounds with the first 9 kicks all missed at 0-0).
//
// These run the REAL engine (dispatch → timers → resolution → persistence)
// against the local regression DB + Redis, so they cover the paths the unit
// tests cannot: question payload timing fields, per-round dispatch, and the
// attempts/kicksTaken/state arithmetic the client's pip UI renders from.

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

const bootOptions = {
  variant: 'friendly_possession' as const,
  startTimeoutMs: 25_000,
  friendlyCategoryCount: 6,
  mcqPerCategory: 14,
};

type PenaltyStateShape = {
  penalty?: {
    attempts?: { seat1?: unknown[]; seat2?: unknown[] };
    kicksTaken?: { seat1?: number; seat2?: number };
    suddenDeath?: boolean;
  };
  penaltyGoals?: { seat1?: number; seat2?: number };
};

async function loadPenaltyState(matchId: string): Promise<PenaltyStateShape> {
  const { sql } = await import('../../src/db/index.js');
  const [match] = await sql<Array<{ state_payload: unknown }>>`
    SELECT state_payload FROM matches WHERE id = ${matchId}
  `;
  if (!match) throw new Error(`missing match row for ${matchId}`);
  return (
    typeof match.state_payload === 'string'
      ? JSON.parse(match.state_payload)
      : match.state_payload
  ) as PenaltyStateShape;
}

/** Draw regulation (everyone wrong in normal play), then run the shootout
 *  with a FIXED per-seat answer speed — both always correct, so every duel is
 *  a same-bucket points tie and the outcome rides entirely on the time
 *  tie-break under test. */
function fixedSpeedDuelPlan(speedBySeat: [number, number]): LobbyAnswerPlanner {
  return ({ question, seatIndex }) => {
    if (question.phaseKind !== 'penalty') return { mode: 'wrong', timeMs: 700 };
    return { mode: 'correct', timeMs: speedBySeat[seatIndex] };
  };
}

describeLocal('regression: penalty gauntlet (tie-break + timing)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('same-bucket duels resolve on answer time: the faster player sweeps in regulation', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { computePenaltyShootout } = await import('../../game-regression/src/penalty-arithmetic.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    // Seat 1 answers every penalty in 600ms, seat 2 in 900ms — both inside the
    // full-points grace bucket, so every duel is 100 vs 100. Pre-fix: nine+
    // saves and a 0-0 marathon. Post-fix: seat 1 scores when shooting AND
    // saves when keeping → sweeps, and the mercy rule ends it inside
    // regulation.
    await playLobbyMatch(run, {
      maxMs: 140_000,
      answerPlan: fixedSpeedDuelPlan([600, 900]),
    });

    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    const inv = checkInvariants(run.trace);
    if (!inv.ok) console.error(inv.violations.map(formatViolation).join('\n'));
    expect(inv.ok).toBe(true);

    const state = await loadPenaltyState(run.matchId!);
    const arithmetic = computePenaltyShootout({
      attempts: state.penalty?.attempts,
      kicksTaken: state.penalty?.kicksTaken,
      round: undefined,
      suddenDeath: state.penalty?.suddenDeath,
    });
    expect(arithmetic.errors).toEqual([]);
    expect(arithmetic.winnerSeat).toBe(1);
    expect(arithmetic.suddenDeathReached).toBe(false);
    // Seat 1 scores every shot, seat 2 none → mercy rule fires by kick 6
    // (3-0 with seat 2 holding 2 remaining kicks) — nowhere near the pre-fix
    // 18-40 kick marathons.
    expect(arithmetic.totalKicks).toBeLessThanOrEqual(6);
    expect(arithmetic.goals.seat2).toBe(0);
  }, 180_000);

  it('every penalty round ships an identical answer window (playableAt/deadlineAt)', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    await playLobbyMatch(run, {
      maxMs: 140_000,
      answerPlan: fixedSpeedDuelPlan([600, 900]),
    });

    const penaltyQuestions = run.trace
      .byEvent('match:question')
      .map((event) => event.payload as {
        phaseKind?: string;
        qIndex?: number;
        playableAt?: string;
        deadlineAt?: string;
      })
      .filter((payload) => payload.phaseKind === 'penalty');
    expect(penaltyQuestions.length).toBeGreaterThan(0);

    const windows = new Set<number>();
    for (const question of penaltyQuestions) {
      const playableAt = new Date(question.playableAt ?? '').getTime();
      const deadlineAt = new Date(question.deadlineAt ?? '').getTime();
      expect(Number.isFinite(playableAt)).toBe(true);
      expect(Number.isFinite(deadlineAt)).toBe(true);
      expect(deadlineAt).toBeGreaterThan(playableAt);
      windows.add(deadlineAt - playableAt);
    }
    // One fixed answer window across ALL penalty rounds — the erratic
    // per-round reveal ("1st instant, 2nd late") came from path-dependent
    // timing; any divergence here is a regression. (byEvent returns every
    // per-socket delivery of each round, so duplicates collapse via the Set.)
    expect(windows.size).toBe(1);
  }, 180_000);

  it('a shooter who never answers times out as a miss and the shootout advances', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { computePenaltyShootout } = await import('../../game-regression/src/penalty-arithmetic.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    // Seat 1 answers instantly and correctly; seat 2 stalls past every
    // deadline (answerAtMs far beyond the collapsed fast-timer window), so
    // seat 2 contributes only timeouts. Seat 1 must score every shot (correct
    // vs no answer), save every kick, and win without the match hanging on
    // the unanswered rounds.
    await playLobbyMatch(run, {
      maxMs: 140_000,
      answerPlan: ({ question, seatIndex }) => {
        if (question.phaseKind !== 'penalty') return { mode: 'wrong', timeMs: 700 };
        if (seatIndex === 0) return { mode: 'correct', timeMs: 400 };
        return { mode: 'wrong', timeMs: 400, answerAtMs: 600_000 };
      },
    });

    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    const state = await loadPenaltyState(run.matchId!);
    const arithmetic = computePenaltyShootout({
      attempts: state.penalty?.attempts,
      kicksTaken: state.penalty?.kicksTaken,
      round: undefined,
      suddenDeath: state.penalty?.suddenDeath,
    });
    expect(arithmetic.errors).toEqual([]);
    expect(arithmetic.winnerSeat).toBe(1);
    expect(arithmetic.goals.seat2).toBe(0);
  }, 180_000);
});

describeLocal('regression: penalty ready-ack gate', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('silent clients (no ready acks at all) still get every penalty round via the ceiling and the shootout completes', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { computePenaltyShootout } = await import('../../game-regression/src/penalty-arithmetic.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    // Penalty rounds now dispatch through the client ready-ack gate. A client
    // that NEVER acks (backgrounded tab, dead socket) must not stall the
    // shootout: the gate's ceiling has to advance every round on its own.
    await playLobbyMatch(run, {
      maxMs: 160_000,
      skipReadyAcks: true,
      answerPlan: fixedSpeedDuelPlan([600, 900]),
    });

    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    const state = await loadPenaltyState(run.matchId!);
    const arithmetic = computePenaltyShootout({
      attempts: state.penalty?.attempts,
      kicksTaken: state.penalty?.kicksTaken,
      round: undefined,
      suddenDeath: state.penalty?.suddenDeath,
    });
    expect(arithmetic.errors).toEqual([]);
    expect(arithmetic.winnerSeat).toBe(1);
    // Every penalty question the server dispatched must carry a full timing
    // window — the ceiling fallback path builds the same shape as the ack path.
    const penaltyQuestions = run.trace
      .byEvent('match:question')
      .map((event) => event.payload as { phaseKind?: string; playableAt?: string; deadlineAt?: string })
      .filter((payload) => payload.phaseKind === 'penalty');
    expect(penaltyQuestions.length).toBeGreaterThan(0);
    for (const question of penaltyQuestions) {
      expect(Number.isFinite(new Date(question.playableAt ?? '').getTime())).toBe(true);
      expect(Number.isFinite(new Date(question.deadlineAt ?? '').getTime())).toBe(true);
    }
  }, 200_000);
});
