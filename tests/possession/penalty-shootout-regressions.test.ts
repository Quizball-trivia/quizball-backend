import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution, penaltyWinnerSeat } from '../../src/realtime/possession-resolution.js';
import { getDifficultyForState, parsePossessionState, type Seat } from '../../src/realtime/possession-state.js';

function players(): CachedPlayer[] {
  return [
    {
      userId: 'seat-1',
      seat: 1,
      totalPoints: 0,
      correctAnswers: 0,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
    {
      userId: 'seat-2',
      seat: 2,
      totalPoints: 0,
      correctAnswers: 0,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
  ];
}

function penaltyState() {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  return state;
}

type AnswerDetail = { is_correct: boolean; time_ms: number; points_earned: number };

function detailedAnswers(seat1: AnswerDetail, seat2: AnswerDetail) {
  return new Map([
    ['seat-1', seat1],
    ['seat-2', seat2],
  ]);
}

describe('penalty goal semantics — correctness beats the points floor', () => {
  it.each([1, 2] as const)(
    'correct shooter with 0 points scores against a wrong keeper: shooter seat %s',
    (shooterSeat) => {
      const state = penaltyState();
      const shooter: AnswerDetail = { is_correct: true, time_ms: 10_000, points_earned: 0 };
      const keeper: AnswerDetail = { is_correct: false, time_ms: 500, points_earned: 0 };
      const result = applyPenaltyResolution(
        state,
        players(),
        shooterSeat === 1 ? detailedAnswers(shooter, keeper) : detailedAnswers(keeper, shooter),
        shooterSeat as Seat,
      );

      expect(result.goalScoredByUserId).toBe(`seat-${shooterSeat}`);
      expect(state.penaltyGoals[`seat${shooterSeat}`]).toBe(1);
      expect(state.penalty.attempts?.[`seat${shooterSeat}`]).toEqual(['goal']);
    },
  );

  it('keeps the keeper advantage when both are correct with equal points', () => {
    const state = penaltyState();
    const result = applyPenaltyResolution(
      state,
      players(),
      detailedAnswers(
        { is_correct: true, time_ms: 4_000, points_earned: 60 },
        { is_correct: true, time_ms: 4_000, points_earned: 60 },
      ),
      1,
    );

    expect(result.goalScoredByUserId).toBeNull();
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
  });

  it('never scores a wrong shooter, even against a slower wrong keeper', () => {
    const state = penaltyState();
    const result = applyPenaltyResolution(
      state,
      players(),
      detailedAnswers(
        { is_correct: false, time_ms: 1_000, points_earned: 0 },
        { is_correct: false, time_ms: 9_000, points_earned: 0 },
      ),
      1,
    );

    expect(result.goalScoredByUserId).toBeNull();
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
  });

  it('backfilled no-answer shooter (timeout) is a save against a correct keeper', () => {
    const state = penaltyState();
    const result = applyPenaltyResolution(
      state,
      players(),
      detailedAnswers(
        { is_correct: false, time_ms: 10_000, points_earned: 0 },
        { is_correct: true, time_ms: 2_000, points_earned: 80 },
      ),
      1,
    );

    expect(result.goalScoredByUserId).toBeNull();
  });
});

describe('sudden death termination', () => {
  function goalAnswersFor(shooterSeat: Seat) {
    const shooter: AnswerDetail = { is_correct: true, time_ms: 2_000, points_earned: 80 };
    const keeper: AnswerDetail = { is_correct: false, time_ms: 2_000, points_earned: 0 };
    return shooterSeat === 1 ? detailedAnswers(shooter, keeper) : detailedAnswers(keeper, shooter);
  }

  function missAnswersFor(shooterSeat: Seat) {
    const shooter: AnswerDetail = { is_correct: false, time_ms: 2_000, points_earned: 0 };
    const keeper: AnswerDetail = { is_correct: true, time_ms: 2_000, points_earned: 80 };
    return shooterSeat === 1 ? detailedAnswers(shooter, keeper) : detailedAnswers(keeper, shooter);
  }

  function playRegulationAllScored(state: ReturnType<typeof penaltyState>) {
    for (let kick = 0; kick < 10; kick += 1) {
      const shooterSeat = state.penalty.shooterSeat;
      const result = applyPenaltyResolution(state, players(), goalAnswersFor(shooterSeat), shooterSeat);
      expect(result.goalScoredByUserId).not.toBeNull();
    }
  }

  it('ends the match on the first decisive sudden-death pair (goal then miss)', () => {
    const state = penaltyState();
    playRegulationAllScored(state);

    expect(state.penalty.suddenDeath).toBe(true);
    expect(state.penalty.kicksTaken).toEqual({ seat1: 5, seat2: 5 });
    expect(state.penaltyGoals).toEqual({ seat1: 5, seat2: 5 });
    expect(state.phase).toBe('PENALTY_SHOOTOUT');

    const sdShooter = state.penalty.shooterSeat;
    applyPenaltyResolution(state, players(), goalAnswersFor(sdShooter), sdShooter);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');

    const sdSecondShooter = state.penalty.shooterSeat;
    expect(sdSecondShooter).not.toBe(sdShooter);
    applyPenaltyResolution(state, players(), missAnswersFor(sdSecondShooter), sdSecondShooter);

    expect(state.phase).toBe('COMPLETED');
    expect(penaltyWinnerSeat(state)).toBe(sdShooter);
  });

  it('continues after a scoreless sudden-death pair', () => {
    const state = penaltyState();
    playRegulationAllScored(state);

    const first = state.penalty.shooterSeat;
    applyPenaltyResolution(state, players(), missAnswersFor(first), first);
    const second = state.penalty.shooterSeat;
    applyPenaltyResolution(state, players(), missAnswersFor(second), second);

    expect(state.phase).toBe('PENALTY_SHOOTOUT');
    expect(penaltyWinnerSeat(state)).toBeNull();
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 6 });
  });
});

describe('penalty state rehydration parity', () => {
  it('truncates attempts arrays to the authoritative kicksTaken on parse', () => {
    const state = penaltyState();
    state.penalty.kicksTaken = { seat1: 3, seat2: 3 };
    state.penaltyGoals = { seat1: 2, seat2: 1 };
    state.penalty.round = 7;
    state.penalty.attempts = {
      seat1: ['goal', 'goal', 'miss', 'goal', 'miss'],
      seat2: ['miss', 'goal', 'miss'],
    };

    const parsed = parsePossessionState(JSON.parse(JSON.stringify(state)));

    expect(parsed.penalty.attempts?.seat1).toEqual(['goal', 'goal', 'miss']);
    expect(parsed.penalty.attempts?.seat2).toEqual(['miss', 'goal', 'miss']);
  });

  it('pads a partial attempts array to exactly kicksTaken using the canonical tail', () => {
    const state = penaltyState();
    state.penalty.kicksTaken = { seat1: 3, seat2: 2 };
    state.penaltyGoals = { seat1: 1, seat2: 2 };
    state.penalty.attempts = {
      seat1: ['miss'],
      seat2: [],
    };

    const parsed = parsePossessionState(JSON.parse(JSON.stringify(state)));

    expect(parsed.penalty.attempts?.seat1).toHaveLength(3);
    expect(parsed.penalty.attempts?.seat1?.[0]).toBe('miss');
    expect(parsed.penalty.attempts?.seat2).toEqual(['goal', 'goal']);
  });

  it('reconstructs attempts from goals and kicks when the array is absent', () => {
    const state = penaltyState();
    state.penalty.kicksTaken = { seat1: 2, seat2: 1 };
    state.penaltyGoals = { seat1: 1, seat2: 0 };
    const raw = JSON.parse(JSON.stringify(state));
    delete raw.penalty.attempts;

    const parsed = parsePossessionState(raw);

    expect(parsed.penalty.attempts?.seat1).toEqual(['goal', 'miss']);
    expect(parsed.penalty.attempts?.seat2).toEqual(['miss']);
  });
});

describe('penalty question difficulty pool', () => {
  it('draws penalties from medium+hard', () => {
    const state = penaltyState();
    expect(getDifficultyForState(state)).toEqual(['medium', 'hard']);
  });
});
