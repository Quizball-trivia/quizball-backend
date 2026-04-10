import {
  createInitialPossessionState,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';
import type { DraftCategory, MatchPhaseKind, MatchQuestionKind, MatchStatePayload } from './socket.types.js';

// ── Constants ──

export const QUESTION_TIME_MS = 10000;
export const COUNTDOWN_QUESTION_TIME_MS = 15000;
export const CLUES_QUESTION_TIME_MS = 20000;
export const FRONTEND_REVEAL_MS = 3000; // Frontend shows question text before unlocking options
export const FRONTEND_TRANSITION_DELAY_MS = 1600; // Synced with frontend TRANSITION_DELAY_MS
export const FRONTEND_RESULT_HOLD_MS = 2500; // Synced with frontend ROUND_RESULT_HOLD_MS
export const FRONTEND_FIRST_QUESTION_INTRO_MS = 2000; // Synced with first-question intro overlay
export const ROUND_RESULT_DELAY_MS = 0;
export const PENALTY_INTRO_DELAY_MS = 1000;
export const TIMEOUT_RESOLVE_GRACE_MS = 250;
export const TIMEOUT_RESOLVE_BUFFER_MS = 50;
export const LAST_MATCH_REPLAY_TTL_SEC = 600;
export const TIMING_DISCREPANCY_WARN_MS = 500;

// ── Types ──

export type Seat = 1 | 2;

export type ResolutionDecision = {
  winnerId: string | null;
  method: 'goals' | 'penalty_goals' | 'total_points_fallback';
  totalPointsFallbackUsed: boolean;
};

export type ExpectedAnswerInfo = {
  expectedUserIds: string[];
  shooterSeat: Seat | null;
  attackerSeat: Seat | null;
};

// ── Phase validation ──

const VALID_PHASE_KINDS: ReadonlySet<MatchPhaseKind> = new Set(['normal', 'last_attack', 'penalty']);
const VALID_WINNER_DECISION_METHODS: ReadonlySet<NonNullable<PossessionStatePayload['winnerDecisionMethod']>> = new Set([
  'goals',
  'penalty_goals',
  'total_points_fallback',
]);

export function isMatchPhaseKind(value: unknown): value is MatchPhaseKind {
  return typeof value === 'string' && VALID_PHASE_KINDS.has(value as MatchPhaseKind);
}

function isValidWinnerDecisionMethod(
  value: unknown
): value is NonNullable<PossessionStatePayload['winnerDecisionMethod']> {
  return typeof value === 'string' && VALID_WINNER_DECISION_METHODS.has(value as NonNullable<PossessionStatePayload['winnerDecisionMethod']>);
}

// ── Seat helpers ──

export function asSeat(value: number | null | undefined): Seat | null {
  if (value === 1 || value === 2) return value;
  return null;
}

export function nextSeat(seat: Seat): Seat {
  return seat === 1 ? 2 : 1;
}

export function getSeatFromUserId(players: Array<{ user_id: string; seat: number }>, userId: string): Seat | null {
  const seat = players.find((player) => player.user_id === userId)?.seat;
  return asSeat(seat);
}

export function getUserIdBySeat(players: Array<{ user_id: string; seat: number }>, seat: Seat): string | null {
  return players.find((player) => player.seat === seat)?.user_id ?? null;
}

export function seatToBanKey(seat: Seat): 'seat1' | 'seat2' {
  return seat === 1 ? 'seat1' : 'seat2';
}

// ── Timing ──

export function getQuestionPreAnswerDelayMs(params: {
  qIndex: number;
  state: Pick<PossessionStatePayload, 'half' | 'normalQuestionsAnsweredInHalf'>;
}): number {
  const { qIndex, state } = params;
  // First question has a dedicated intro overlay before reveal.
  if (qIndex === 0) {
    return FRONTEND_FIRST_QUESTION_INTRO_MS + FRONTEND_REVEAL_MS;
  }
  // First question after halftime does not have round-result transition blockers.
  if (state.half === 2 && state.normalQuestionsAnsweredInHalf === 0) {
    return FRONTEND_REVEAL_MS;
  }
  // Subsequent questions are blocked by result hold + transition overlay + reveal.
  return FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS;
}

export function getQuestionDurationMs(questionKind: MatchQuestionKind): number {
  switch (questionKind) {
    case 'countdown':
      return COUNTDOWN_QUESTION_TIME_MS;
    case 'clues':
      return CLUES_QUESTION_TIME_MS;
    case 'multipleChoice':
    case 'putInOrder':
    default:
      return QUESTION_TIME_MS;
  }
}


export function buildPlayableQuestionTiming(params: {
  qIndex: number;
  state: Pick<PossessionStatePayload, 'half' | 'normalQuestionsAnsweredInHalf'>;
  questionKind?: MatchQuestionKind;
}): {
  playableAt: Date;
  deadlineAt: Date;
} {
  const preAnswerDelayMs = getQuestionPreAnswerDelayMs(params);
  const playableAt = new Date(Date.now() + preAnswerDelayMs);
  const deadlineAt = new Date(playableAt.getTime() + getQuestionDurationMs(params.questionKind ?? 'multipleChoice'));
  return { playableAt, deadlineAt };
}

// ── State parsing & serialization ──

export function parsePossessionState(raw: unknown): PossessionStatePayload {
  const fallbackVariant =
    raw && typeof raw === 'object' && (raw as Partial<PossessionStatePayload>).variant === 'ranked_sim'
      ? 'ranked_sim'
      : 'friendly_possession';
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return createInitialPossessionState(fallbackVariant); }
  }
  if (!raw || typeof raw !== 'object') {
    return createInitialPossessionState(fallbackVariant);
  }

  const candidate = raw as Partial<PossessionStatePayload>;
  const fallback = createInitialPossessionState(fallbackVariant);

  if (!candidate.phase || !candidate.half || !candidate.goals || !candidate.penaltyGoals) {
    return fallback;
  }

  return {
    ...fallback,
    ...candidate,
    goals: {
      seat1: Math.max(0, Number(candidate.goals.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals: {
      seat1: Math.max(0, Number(candidate.penaltyGoals.seat1 ?? fallback.penaltyGoals.seat1)),
      seat2: Math.max(0, Number(candidate.penaltyGoals.seat2 ?? fallback.penaltyGoals.seat2)),
    },
    possessionDiff: clamp(Number(candidate.possessionDiff ?? fallback.possessionDiff), -100, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      categoryOptions: Array.isArray(candidate.halftime?.categoryOptions)
        ? candidate.halftime.categoryOptions.reduce<DraftCategory[]>((acc, category) => {
          if (!category || typeof category !== 'object') return acc;
          if (typeof category.id !== 'string' || typeof category.name !== 'string') return acc;
          const legacyImageUrl = (category as { image_url?: unknown }).image_url;
          acc.push({
            id: category.id,
            name: category.name,
            icon: typeof category.icon === 'string' ? category.icon : null,
            imageUrl:
              typeof category.imageUrl === 'string'
                ? category.imageUrl
                : typeof legacyImageUrl === 'string'
                  ? legacyImageUrl
                  : null,
          });
          return acc;
        }, [])
        : [],
      firstHalfShownCategoryIds: Array.isArray(candidate.halftime?.firstHalfShownCategoryIds)
        ? candidate.halftime.firstHalfShownCategoryIds.filter((categoryId): categoryId is string => typeof categoryId === 'string')
        : [],
      firstBanSeat: asSeat(candidate.halftime?.firstBanSeat),
      bans: {
        seat1: typeof candidate.halftime?.bans?.seat1 === 'string' ? candidate.halftime.bans.seat1 : null,
        seat2: typeof candidate.halftime?.bans?.seat2 === 'string' ? candidate.halftime.bans.seat2 : null,
      },
    },
    lastAttack: {
      attackerSeat: asSeat(candidate.lastAttack?.attackerSeat),
    },
    penalty: {
      round: Math.max(0, Number(candidate.penalty?.round ?? 0)),
      shooterSeat: asSeat(candidate.penalty?.shooterSeat) ?? 1,
      suddenDeath: Boolean(candidate.penalty?.suddenDeath),
      kicksTaken: {
        seat1: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat1 ?? 0)),
        seat2: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat2 ?? 0)),
      },
    },
    currentQuestion: candidate.currentQuestion
      ? {
        qIndex: Number(candidate.currentQuestion.qIndex ?? 0),
        phaseKind: isMatchPhaseKind(candidate.currentQuestion.phaseKind) ? candidate.currentQuestion.phaseKind : 'normal',
        phaseRound: Number(candidate.currentQuestion.phaseRound ?? 0),
        shooterSeat: asSeat(candidate.currentQuestion.shooterSeat),
        attackerSeat: asSeat(candidate.currentQuestion.attackerSeat),
      }
      : null,
    winnerDecisionMethod:
      isValidWinnerDecisionMethod(candidate.winnerDecisionMethod) ? candidate.winnerDecisionMethod : null,
  };
}

export function phaseKindFromState(state: PossessionStatePayload): MatchPhaseKind {
  if (state.phase === 'LAST_ATTACK') return 'last_attack';
  if (state.phase === 'PENALTY_SHOOTOUT') return 'penalty';
  return 'normal';
}

export function getDifficultyForState(state: PossessionStatePayload): Array<'easy' | 'medium' | 'hard'> {
  const phaseKind = phaseKindFromState(state);
  if (phaseKind === 'penalty') return ['hard'];

  const p = Math.abs(state.possessionDiff);
  if (p <= 20) return ['easy'];
  if (p <= 45) return ['easy', 'medium'];
  if (p <= 70) return ['medium'];
  return ['medium', 'hard'];
}

export function toMatchStatePayload(matchId: string, state: PossessionStatePayload): MatchStatePayload {
  const phaseKind = state.currentQuestion?.phaseKind ?? phaseKindFromState(state);
  const phaseRound = state.currentQuestion?.phaseRound
    ?? (state.phase === 'PENALTY_SHOOTOUT' ? Math.ceil(state.penalty.round / 2) : 0);
  return {
    matchId,
    phase: state.phase,
    half: state.half,
    possessionDiff: state.possessionDiff,
    normalQuestionsAnsweredInHalf: state.normalQuestionsAnsweredInHalf,
    attackerSeat: state.lastAttack.attackerSeat,
    kickOffSeat: state.kickOffSeat,
    goals: {
      seat1: state.goals.seat1,
      seat2: state.goals.seat2,
    },
    penaltyGoals: {
      seat1: state.penaltyGoals.seat1,
      seat2: state.penaltyGoals.seat2,
    },
    phaseKind,
    phaseRound,
    shooterSeat: state.currentQuestion?.shooterSeat ?? (state.phase === 'PENALTY_SHOOTOUT' ? state.penalty.shooterSeat : null),
    halftime: {
      deadlineAt: state.halftime.deadlineAt,
      categoryOptions: state.halftime.categoryOptions,
      firstBanSeat: state.halftime.firstBanSeat,
      bans: {
        seat1: state.halftime.bans.seat1,
        seat2: state.halftime.bans.seat2,
      },
    },
    penaltySuddenDeath: state.penalty.suddenDeath,
    stateVersion: state.stateVersionCounter,
  };
}

// Re-exported from shared match-utils — single source of truth
export { bumpStateVersion } from './match-utils.js';
