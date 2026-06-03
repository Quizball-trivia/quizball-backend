import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import type { CachedPlayer, MatchCache } from './match-cache.js';
import { HALFTIME_DURATION_MS } from './possession-halftime.js';
import { getUserIdByCachedSeat } from './possession-payload-mappers.js';
import { nextSeat, QUESTION_TIME_MS, type Seat } from './possession-state.js';
import { clamp } from './scoring.js';

/** One seat's answer this round, for speed-streak resolution. */
export interface StreakAnswer {
  /** Displayed/base points before any 2x possession boost. */
  basePoints: number;
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
 * Rules: a seat qualifies only by earning more displayed/base points than the
 * opponent this round. Displayed ties (80-80, 0-0, etc.) clear progress, even
 * when raw answer times differed. A goal always clears it. Only one holder.
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

  // The qualifying seat is whichever seat earned more displayed/base points.
  // The current-round 2x possession boost does not help a holder keep the
  // streak; this comparison intentionally uses pre-boost points.
  let qualifyingSeat: Seat | null = null;
  if (seat1.basePoints > seat2.basePoints && seat1.basePoints > 0) {
    qualifyingSeat = 1;
  } else if (seat2.basePoints > seat1.basePoints && seat2.basePoints > 0) {
    qualifyingSeat = 2;
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
    state.halftime.deadlineAt = new Date(Date.now() + harnessDelayMs(HALFTIME_DURATION_MS)).toISOString();
    return;
  }

  if (state.goals.seat1 === state.goals.seat2) {
    // Draw → run a category-ban interlude (reusing the HALFTIME ban machinery)
    // before the shootout. finalizeHalftime sees purpose==='penalty' and exits
    // into PENALTY_SHOOTOUT with the chosen category. Categories are populated
    // lazily by the HALFTIME question-dispatch branch (ensureHalftimeCategories).
    // state.penalty is initialised at finalize, not here.
    state.phase = 'HALFTIME';
    state.halftime.purpose = 'penalty';
    state.halftime.deadlineAt = new Date(Date.now() + harnessDelayMs(HALFTIME_DURATION_MS)).toISOString();
    state.halftime.uiReadyAt = null;
    state.halftime.categoryOptions = [];
    state.halftime.firstBanSeat = null;
    state.halftime.bans = { seat1: null, seat2: null };
    state.currentQuestion = null;
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

  state.penalty.attempts ??= { seat1: [], seat2: [] };
  if (shooterSeat === 1) state.penalty.attempts.seat1.push(isGoal ? 'goal' : 'miss');
  else state.penalty.attempts.seat2.push(isGoal ? 'goal' : 'miss');

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
  state: Pick<PossessionStatePayload, 'half' | 'phase' | 'penaltyCategoryId'>,
  cache: Pick<MatchCache, 'categoryAId' | 'categoryBId'>
): string[] {
  // Penalty questions use the category chosen in the penalty ban phase. Gate
  // strictly on PENALTY_SHOOTOUT so a stale penaltyCategoryId can never leak
  // into normal second-half questions.
  if (state.phase === 'PENALTY_SHOOTOUT') {
    return [state.penaltyCategoryId ?? cache.categoryBId ?? cache.categoryAId];
  }
  if (state.half === 1) return [cache.categoryAId];
  return cache.categoryBId ? [cache.categoryBId] : [cache.categoryAId];
}
