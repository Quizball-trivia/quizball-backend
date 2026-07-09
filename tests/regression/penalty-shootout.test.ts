import { afterEach, describe, expect, it } from 'vitest';
import type { ChaosPlan } from '../../game-regression/src/chaos.mjs';
import type { LobbyAnswerPlanner } from '../../game-regression/src/runner.mjs';

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

type MatchRow = {
  winner_user_id: string | null;
  state_payload: unknown;
};

type PlayerRow = {
  user_id: string;
  seat: number;
  goals: number;
  penalty_goals: number;
};

type AnswerRow = {
  q_index: number;
  phase_kind: string | null;
};

type MatchQuestionRow = {
  q_index: number;
  phase_kind: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scriptedPenaltyPlan(outcomes: Array<'goal' | 'miss'>): LobbyAnswerPlanner {
  const penaltyOutcomeByQIndex = new Map<number, 'goal' | 'miss'>();
  return ({ question, seatIndex }) => {
    if (question.phaseKind !== 'penalty') return { mode: 'wrong', timeMs: 700 };
    if (!penaltyOutcomeByQIndex.has(question.qIndex)) {
      penaltyOutcomeByQIndex.set(question.qIndex, outcomes[penaltyOutcomeByQIndex.size] ?? 'miss');
    }
    const outcome = penaltyOutcomeByQIndex.get(question.qIndex)!;
    const shooterSeat = question.shooterSeat ?? 1;
    const isShooter = seatIndex + 1 === shooterSeat;
    if (outcome === 'goal') {
      return { mode: isShooter ? 'correct' : 'wrong', timeMs: isShooter ? 300 : 800 };
    }
    return { mode: isShooter ? 'wrong' : 'correct', timeMs: isShooter ? 800 : 300 };
  };
}

async function loadFacts(matchId: string): Promise<{
  match: MatchRow;
  players: PlayerRow[];
  answers: AnswerRow[];
  questions: MatchQuestionRow[];
}> {
  const { sql } = await import('../../src/db/index.js');
  const [match] = await sql<MatchRow[]>`
    SELECT winner_user_id, state_payload
    FROM matches
    WHERE id = ${matchId}
  `;
  const players = await sql<PlayerRow[]>`
    SELECT user_id, seat, goals, penalty_goals
    FROM match_players
    WHERE match_id = ${matchId}
    ORDER BY seat
  `;
  const answers = await sql<AnswerRow[]>`
    SELECT q_index, phase_kind
    FROM match_answers
    WHERE match_id = ${matchId}
    ORDER BY q_index
  `;
  const questions = await sql<MatchQuestionRow[]>`
    SELECT q_index, phase_kind
    FROM match_questions
    WHERE match_id = ${matchId}
    ORDER BY q_index
  `;
  if (!match) throw new Error(`missing match row for ${matchId}`);
  return { match, players, answers, questions };
}

async function expectPenaltyState(
  matchId: string,
  expected: {
    winnerSeat: 1 | 2;
    penaltyGoals: { seat1: number; seat2: number };
    suddenDeath: boolean;
    decisionKickCount: number;
  },
): Promise<void> {
  const { computePenaltyShootout, penaltyWinnerUserId } = await import('../../game-regression/src/penalty-arithmetic.mjs');
  const facts = await loadFacts(matchId);
  const state = typeof facts.match.state_payload === 'string'
    ? JSON.parse(facts.match.state_payload) as Record<string, unknown>
    : asRecord(facts.match.state_payload);
  const penalty = asRecord(state.penalty);
  const arithmetic = computePenaltyShootout({
    attempts: penalty.attempts,
    kicksTaken: penalty.kicksTaken,
    round: penalty.round,
    suddenDeath: penalty.suddenDeath,
  });
  const penaltyGoals = asRecord(state.penaltyGoals);
  const goals = asRecord(state.goals);
  const penaltyQuestionIndexes = new Set(
    facts.questions
      .filter((question) => question.phase_kind === 'penalty')
      .map((question) => question.q_index),
  );
  const penaltyAnswers = facts.answers.filter((answer) => penaltyQuestionIndexes.has(answer.q_index));

  expect(arithmetic.errors).toEqual([]);
  expect(arithmetic.winnerSeat).toBe(expected.winnerSeat);
  expect(arithmetic.goals).toEqual(expected.penaltyGoals);
  expect(arithmetic.suddenDeathReached).toBe(expected.suddenDeath);
  expect(arithmetic.decisionKickCount).toBe(expected.decisionKickCount);
  expect(facts.match.winner_user_id).toBe(penaltyWinnerUserId(facts.players, arithmetic.winnerSeat));
  expect(Number(penaltyGoals.seat1)).toBe(arithmetic.goals.seat1);
  expect(Number(penaltyGoals.seat2)).toBe(arithmetic.goals.seat2);
  expect(Number(goals.seat1)).toBe(0);
  expect(Number(goals.seat2)).toBe(0);
  expect(facts.players.every((player) => player.goals === 0)).toBe(true);
  expect(facts.players.find((player) => player.seat === 1)?.penalty_goals).toBe(arithmetic.goals.seat1);
  expect(facts.players.find((player) => player.seat === 2)?.penalty_goals).toBe(arithmetic.goals.seat2);
  expect(penaltyQuestionIndexes.size).toBe(arithmetic.totalKicks);
  expect(penaltyAnswers.length).toBe(arithmetic.totalKicks * facts.players.length);
  expect(penaltyAnswers.every((answer) => answer.phase_kind === 'penalty')).toBe(true);
}

describeLocal('regression: deterministic penalty shootout', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('forces a full-time draw and decides a clean best-of-5 shootout', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    await playLobbyMatch(run, {
      maxMs: 120_000,
      answerPlan: scriptedPenaltyPlan(['goal', 'miss', 'goal', 'goal', 'goal', 'miss', 'miss', 'miss']),
    });

    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    const phases = run.trace.byEvent('match:state').map((event) => (event.payload as { phase?: string }).phase);
    expect(phases).toContain('PENALTY_SHOOTOUT');
    const inv = checkInvariants(run.trace);
    if (!inv.ok) console.error(inv.violations.map(formatViolation).join('\n'));
    expect(inv.ok).toBe(true);
    await expectPenaltyState(run.matchId!, {
      winnerSeat: 1,
      penaltyGoals: { seat1: 3, seat2: 1 },
      suddenDeath: false,
      decisionKickCount: 8,
    });
  }, 180_000);

  it('ties the first five kicks and resolves on the first uneven sudden-death pair', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');

    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    await playLobbyMatch(run, {
      maxMs: 140_000,
      answerPlan: scriptedPenaltyPlan([
        'goal', 'goal', 'goal', 'goal', 'goal',
        'goal', 'goal', 'goal', 'goal', 'goal',
        'goal', 'miss',
      ]),
    });

    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    await expectPenaltyState(run.matchId!, {
      winnerSeat: 1,
      penaltyGoals: { seat1: 6, seat2: 5 },
      suddenDeath: true,
      decisionKickCount: 12,
    });
  }, 180_000);

  it('flaps a reconnected player between penalty kicks without hanging or wrongful forfeit', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkLifecycleInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');

    const chaosPlan: ChaosPlan = {
      seed: 91017,
      actions: [
        { atPhase: 'penalty', kind: 'flap', params: { n: 1, afterPenaltyKicks: 2 } },
      ],
    };
    const run = await bootFriendlyLobbyMatch(bootOptions);
    expect(run.matchId).toBeTruthy();

    await playLobbyMatch(run, {
      maxMs: 140_000,
      answerPlan: scriptedPenaltyPlan(['goal', 'miss', 'goal', 'goal', 'goal', 'miss', 'miss', 'miss']),
      chaosPlan,
    });

    expect(run.trace.byEvent('chaos:action').some((event) => (event.payload as { kind?: string }).kind === 'flap')).toBe(true);
    expect(run.trace.byEvent('match:final_results').length).toBeGreaterThan(0);
    const lifecycle = await checkLifecycleInvariants(run.trace, {
      matchId: run.matchId!,
      botUserId: run.hostUserId,
      chaosPlan,
      runChaosLifecycleInvariants: true,
    });
    if (!lifecycle.ok) console.error(lifecycle.violations.map(formatViolation).join('\n'));
    expect(lifecycle.ok).toBe(true);
  }, 180_000);
});
