import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import type { CachedPlayer, MatchCache } from './match-cache.js';
import { HALFTIME_DURATION_MS } from './possession-halftime.js';
import { getUserIdByCachedSeat } from './possession-payload-mappers.js';
import { nextSeat, QUESTION_TIME_MS, type Seat } from './possession-state.js';
import { clamp } from './scoring.js';

export const SPEED_STREAK_TIE_TOLERANCE_MS = 150;

/** One seat's answer this round, for speed-streak resolution. */
export interface StreakAnswer {
  /** Did this seat answer correctly? (timeout / no-answer counts as false.) */
  correct: boolean;
  /** Authoritative elapsed time in ms. Lower = faster. */
  timeMs: number;
}

/**
 * Pure 2× speed-streak resolver.
 *
 * - `boostedSeat`: the seat whose points were doubled THIS round (the previous
 *   holder, if still present) — for the client "boost fired" flourish.
 * - `nextHolderSeat`: who holds the active streak going INTO the next round.
 * - `nextCandidateSeat` / `nextCandidateCount`: qualification progress toward
 *   the next active streak. A player needs two qualifying rounds in a row.
 *
 * Rules: a seat qualifies only by being correct and winning the answer race
 * this round (meaningfully faster when both are correct; a sole correct answer
 * beats a wrong/timeout opponent). Equal/near-equal time (tie), being slower,
 * or a wrong/timeout answer clears progress. A goal always clears it. Only one
 * holder.
 */
export function resolveSpeedStreak(params: {
  previousHolderSeat: Seat | null;
  previousCandidateSeat: Seat | null;
  previousCandidateCount: number;
  seat1: StreakAnswer;
  seat2: StreakAnswer;
  goalScoredBySeat: Seat | null;
}): {
  boostedSeat: Seat | null;
  nextHolderSeat: Seat | null;
  nextCandidateSeat: Seat | null;
  nextCandidateCount: number;
} {
  const {
    previousHolderSeat,
    previousCandidateSeat,
    previousCandidateCount,
    seat1,
    seat2,
    goalScoredBySeat,
  } = params;

  const boostedSeat = previousHolderSeat;

  if (goalScoredBySeat !== null) {
    return { boostedSeat, nextHolderSeat: null, nextCandidateSeat: null, nextCandidateCount: 0 };
  }

  // The qualifying seat is whichever seat is correct and meaningfully faster
  // than the other. If only one seat is correct, that seat wins the round.
  // If both are correct with equal/near-equal time, or both wrong, no one qualifies.
  let qualifyingSeat: Seat | null = null;
  if (seat1.correct && !seat2.correct) {
    qualifyingSeat = 1;
  } else if (seat2.correct && !seat1.correct) {
    qualifyingSeat = 2;
  } else if (seat1.correct && seat2.correct) {
    const diffMs = seat1.timeMs - seat2.timeMs;
    if (diffMs < -SPEED_STREAK_TIE_TOLERANCE_MS) qualifyingSeat = 1;
    else if (diffMs > SPEED_STREAK_TIE_TOLERANCE_MS) qualifyingSeat = 2;
    // equal/near-equal time -> tie -> null
  }

  if (qualifyingSeat === null) {
    return { boostedSeat, nextHolderSeat: null, nextCandidateSeat: null, nextCandidateCount: 0 };
  }

  const nextCandidateCount = qualifyingSeat === previousCandidateSeat
    ? Math.min(2, previousCandidateCount + 1)
    : 1;
  const nextHolderSeat =
    previousHolderSeat === qualifyingSeat || nextCandidateCount >= 2
      ? qualifyingSeat
      : null;

  return {
    boostedSeat,
    nextHolderSeat,
    nextCandidateSeat: qualifyingSeat,
    nextCandidateCount,
  };
}

export function applyDeltaAndGoalCheck(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number
): { delta: number; goalScoredBySeat: Seat | null } {
  const delta = seat1Points - seat2Points;
  const nextDiff = state.possessionDiff + delta;

  if (nextDiff >= 100) {
    state.possessionDiff = 0;
    state.goals.seat1 += 1;
    state.kickOffSeat = 2;
    return { delta, goalScoredBySeat: 1 };
  }

  if (nextDiff <= -100) {
    state.possessionDiff = 0;
    state.goals.seat2 += 1;
    state.kickOffSeat = 1;
    return { delta, goalScoredBySeat: 2 };
  }

  state.possessionDiff = clamp(nextDiff, -99, 99);
  return { delta, goalScoredBySeat: null };
}

export function beginSecondHalf(state: PossessionStatePayload): void {
  state.half = 2;
  state.phase = 'NORMAL_PLAY';
  state.possessionDiff = 0;
  state.speedStreakHolderSeat = null;
  state.speedStreakCandidateSeat = null;
  state.speedStreakCandidateCount = 0;
  state.kickOffSeat = nextSeat(state.kickOffSeat);
  state.lastAttack.attackerSeat = null;
  state.halftime.deadlineAt = null;
  state.halftime.categoryOptions = [];
  state.halftime.firstHalfShownCategoryIds = [];
  state.halftime.firstBanSeat = null;
  state.halftime.bans = { seat1: null, seat2: null };
  state.currentQuestion = null;
  state.normalQuestionsAnsweredInHalf = 0;
}

export function transitionAfterHalfBoundary(
  state: PossessionStatePayload,
  options?: { presetSecondHalfCategoryId?: string | null }
): void {
  // The 2× streak does not carry across a half boundary or into penalties.
  state.speedStreakHolderSeat = null;
  state.speedStreakCandidateSeat = null;
  state.speedStreakCandidateCount = 0;
  if (state.half === 1) {
    if (options?.presetSecondHalfCategoryId) {
      beginSecondHalf(state);
      return;
    }

    state.phase = 'HALFTIME';
    state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
    return;
  }

  if (state.goals.seat1 === state.goals.seat2) {
    state.phase = 'PENALTY_SHOOTOUT';
    state.penalty.round = 1;
    state.penalty.shooterSeat = 1;
    state.penalty.suddenDeath = false;
    state.penalty.kicksTaken = { seat1: 0, seat2: 0 };
    return;
  }

  state.phase = 'COMPLETED';
}

export function applyNormalResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number,
  seat1Correct: boolean,
  seat2Correct: boolean,
  presetSecondHalfCategoryId?: string | null
): { delta: number; goalScoredBySeat: Seat | null } {
  const result = applyDeltaAndGoalCheck(state, seat1Points, seat2Points);
  state.normalQuestionsAnsweredInHalf += 1;
  state.normalQuestionsAnsweredTotal += 1;

  if (state.normalQuestionsAnsweredInHalf >= state.normalQuestionsPerHalf) {
    if (state.possessionDiff >= 50) {
      if (seat1Correct && !seat2Correct) {
        state.phase = 'LAST_ATTACK';
        state.lastAttack.attackerSeat = 1;
        return result;
      }
    } else if (state.possessionDiff <= -50) {
      if (seat2Correct && !seat1Correct) {
        state.phase = 'LAST_ATTACK';
        state.lastAttack.attackerSeat = 2;
        return result;
      }
    }
    state.lastAttack.attackerSeat = null;
    transitionAfterHalfBoundary(state, { presetSecondHalfCategoryId });
    return result;
  }

  state.phase = 'NORMAL_PLAY';
  state.lastAttack.attackerSeat = null;
  return result;
}

export function applyLastAttackResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number,
  presetSecondHalfCategoryId?: string | null
): { delta: number; goalScoredBySeat: Seat | null } {
  const result = applyDeltaAndGoalCheck(state, seat1Points, seat2Points);
  state.lastAttack.attackerSeat = null;
  transitionAfterHalfBoundary(state, { presetSecondHalfCategoryId });
  return result;
}

export function penaltyWinnerSeat(state: PossessionStatePayload): Seat | null {
  const p1 = state.penaltyGoals.seat1;
  const p2 = state.penaltyGoals.seat2;
  const k1 = state.penalty.kicksTaken.seat1;
  const k2 = state.penalty.kicksTaken.seat2;

  if (state.penalty.suddenDeath) {
    if (k1 === k2 && p1 !== p2) {
      return p1 > p2 ? 1 : 2;
    }
    return null;
  }

  const rem1 = Math.max(0, 5 - k1);
  const rem2 = Math.max(0, 5 - k2);

  if (p1 > p2 + rem2) return 1;
  if (p2 > p1 + rem1) return 2;

  if (k1 >= 5 && k2 >= 5 && p1 !== p2) {
    return p1 > p2 ? 1 : 2;
  }

  return null;
}

export function applyPenaltyResolution(
  state: PossessionStatePayload,
  players: CachedPlayer[],
  answerByUserId: Map<string, { is_correct: boolean; time_ms: number }>,
  shooterSeat: Seat
): { goalScoredByUserId: string | null } {
  const keeperSeat = nextSeat(shooterSeat);
  const shooterUserId = getUserIdByCachedSeat(players, shooterSeat);
  const keeperUserId = getUserIdByCachedSeat(players, keeperSeat);
  if (!shooterUserId) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return { goalScoredByUserId: null };
  }

  const shooterAnswer = answerByUserId.get(shooterUserId);
  const keeperAnswer = answerByUserId.get(keeperUserId ?? '');
  const shooterCorrect = shooterAnswer?.is_correct ?? false;
  const keeperCorrect = keeperAnswer?.is_correct ?? false;
  const shooterTimeMs = shooterAnswer?.time_ms ?? QUESTION_TIME_MS;
  const keeperTimeMs = keeperAnswer?.time_ms ?? QUESTION_TIME_MS;

  let isGoal = false;
  if (shooterCorrect && !keeperCorrect) {
    isGoal = true;
  } else if (shooterCorrect && keeperCorrect) {
    isGoal = shooterTimeMs < keeperTimeMs;
  }

  let goalScoredByUserId: string | null = null;
  if (isGoal) {
    if (shooterSeat === 1) state.penaltyGoals.seat1 += 1;
    else state.penaltyGoals.seat2 += 1;
    const shooter = players.find((player) => player.userId === shooterUserId);
    if (shooter) shooter.penaltyGoals += 1;
    goalScoredByUserId = shooterUserId;
  }

  if (shooterSeat === 1) state.penalty.kicksTaken.seat1 += 1;
  else state.penalty.kicksTaken.seat2 += 1;

  const winnerSeat = penaltyWinnerSeat(state);
  if (winnerSeat) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return { goalScoredByUserId };
  }

  state.phase = 'PENALTY_SHOOTOUT';
  state.penalty.round += 1;
  state.penalty.shooterSeat = nextSeat(shooterSeat);
  if (
    state.penalty.kicksTaken.seat1 >= 5 &&
    state.penalty.kicksTaken.seat2 >= 5 &&
    state.penaltyGoals.seat1 === state.penaltyGoals.seat2
  ) {
    state.penalty.suddenDeath = true;
  }
  state.currentQuestion = null;
  return { goalScoredByUserId };
}

export function categoryIdsForCurrentHalf(
  state: Pick<PossessionStatePayload, 'half'>,
  cache: Pick<MatchCache, 'categoryAId' | 'categoryBId'>
): string[] {
  if (state.half === 1) return [cache.categoryAId];
  return cache.categoryBId ? [cache.categoryBId] : [cache.categoryAId];
}
