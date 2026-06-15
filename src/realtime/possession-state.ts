import {
  createInitialPossessionState,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
  type ReservedImageMcq,
} from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';
import { normalizeI18nName } from './match-utils.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import type { DraftCategory, MatchPhaseKind, MatchQuestionKind, MatchStatePayload } from './socket.types.js';

// ── Constants ──

export const QUESTION_TIME_MS = 10000;
export const PUT_IN_ORDER_QUESTION_TIME_MS = 30000;
export const COUNTDOWN_QUESTION_TIME_MS = 30000;
// Clues questions: 10 seconds per clue. Total duration scales with the number of
// clues in the question; CLUES_QUESTION_TIME_MS is used as a fallback / hard cap
// for callers that don't have the clue count available.
export const CLUES_PER_CLUE_MS = 10000;
export const CLUES_MAX_CLUES = 5;
export const CLUES_QUESTION_TIME_MS = CLUES_PER_CLUE_MS * CLUES_MAX_CLUES;
export const FRONTEND_REVEAL_MS = 3000; // Frontend shows question text before unlocking options
export const FRONTEND_TRANSITION_DELAY_MS = 1000; // Synced with frontend TRANSITION_DELAY_MS
export const FRONTEND_FIELD_RESULT_COMPARE_MS = 1500; // Synced with frontend FIELD_RESULT_COMPARE_MS
export const FRONTEND_RESULT_HOLD_MS = 2000; // Synced with frontend ROUND_RESULT_HOLD_MS
export const FRONTEND_GOAL_CELEBRATION_MS = 4000; // Synced with frontend GOAL_CELEBRATION_MS
export const FRONTEND_SPECIAL_RESULT_EXTRA_MS = 3000; // Extra hold for special question reveals (countdown, put-in-order, clues)
export const FRONTEND_FIRST_QUESTION_INTRO_MS = 2000; // Synced with first-question intro overlay
export const ROUND_RESULT_DELAY_MS = 0;
export const PENALTY_INTRO_DELAY_MS = FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS;
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

function normalizeReservedImageMcq(value: unknown): ReservedImageMcq | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ReservedImageMcq>;
  if (typeof candidate.questionId !== 'string' || candidate.questionId.length === 0) return undefined;
  if (typeof candidate.imageUrl !== 'string' || candidate.imageUrl.length === 0) return undefined;
  return { questionId: candidate.questionId, imageUrl: candidate.imageUrl };
}

function normalizeImageMcqReservations(value: unknown): NonNullable<PossessionStatePayload['imageMcq']> {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as { half1?: unknown; half2?: unknown };
  const normalized: NonNullable<PossessionStatePayload['imageMcq']> = {};
  const half1 = normalizeReservedImageMcq(candidate.half1);
  const half2 = normalizeReservedImageMcq(candidate.half2);
  if (half1 !== undefined) normalized.half1 = half1;
  if (half2 !== undefined) normalized.half2 = half2;
  return normalized;
}

/** The image-MCQ reservation for the half the state is currently in. */
export function reservedImageMcqForHalf(
  state: Pick<PossessionStatePayload, 'half' | 'imageMcq'>
): ReservedImageMcq | null | undefined {
  return state.half === 1 ? state.imageMcq?.half1 : state.imageMcq?.half2;
}

function normalizePenaltyAttempts(params: {
  attempts: unknown;
  goals: { seat1: number; seat2: number };
  kicksTaken: { seat1: number; seat2: number };
}): { seat1: Array<'goal' | 'miss'>; seat2: Array<'goal' | 'miss'> } {
  const fromRaw = (value: unknown, goals: number, kicksTaken: number): Array<'goal' | 'miss'> => {
    if (Array.isArray(value)) {
      const sanitized = value.filter((entry): entry is 'goal' | 'miss' => entry === 'goal' || entry === 'miss');
      if (sanitized.length > 0 || kicksTaken === 0) return sanitized.slice(0, Math.max(kicksTaken, sanitized.length));
    }
    return [
      ...Array.from({ length: Math.max(0, goals) }, () => 'goal' as const),
      ...Array.from({ length: Math.max(0, kicksTaken - goals) }, () => 'miss' as const),
    ];
  };

  const raw = params.attempts && typeof params.attempts === 'object'
    ? params.attempts as { seat1?: unknown; seat2?: unknown }
    : {};
  return {
    seat1: fromRaw(raw.seat1, params.goals.seat1, params.kicksTaken.seat1),
    seat2: fromRaw(raw.seat2, params.goals.seat2, params.kicksTaken.seat2),
  };
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
  previousQuestionKind?: MatchQuestionKind;
  postReadyAck?: boolean;
}): number {
  const { qIndex, state, previousQuestionKind, postReadyAck } = params;
  // First question has a dedicated intro overlay before reveal.
  if (qIndex === 0) {
    return FRONTEND_FIRST_QUESTION_INTRO_MS + FRONTEND_REVEAL_MS;
  }
  // Client already completed its hold + celebration + transition before sending
  // the ready ack; only the pre-answer reveal window remains.
  if (postReadyAck) {
    return FRONTEND_REVEAL_MS;
  }
  // First question after halftime has no round result to promote from, but the
  // client still resets the field, shows the second-half transition, then reveals.
  if (state.half === 2 && state.normalQuestionsAnsweredInHalf === 0) {
    return FRONTEND_FIELD_RESULT_COMPARE_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS;
  }
  // Special question reveals (countdown, put-in-order, clues) need extra hold time
  // so players can read the correct answers before transitioning to the next round.
  const isSpecialPrevious = previousQuestionKind === 'countdown'
    || previousQuestionKind === 'putInOrder'
    || previousQuestionKind === 'clues';
  const specialExtra = isSpecialPrevious ? FRONTEND_SPECIAL_RESULT_EXTRA_MS : 0;
  // Subsequent questions are blocked by result hold + transition overlay + reveal.
  return FRONTEND_RESULT_HOLD_MS + specialExtra + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS;
}

export function getQuestionDurationMs(questionKind: MatchQuestionKind, clueCount?: number): number {
  switch (questionKind) {
    case 'putInOrder':
      return PUT_IN_ORDER_QUESTION_TIME_MS;
    case 'countdown':
      return COUNTDOWN_QUESTION_TIME_MS;
    case 'clues': {
      const count = typeof clueCount === 'number' && clueCount > 0
        ? Math.min(clueCount, CLUES_MAX_CLUES)
        : CLUES_MAX_CLUES;
      return CLUES_PER_CLUE_MS * count;
    }
    case 'multipleChoice':
    default:
      return QUESTION_TIME_MS;
  }
}


export function buildPlayableQuestionTiming(params: {
  qIndex: number;
  state: Pick<PossessionStatePayload, 'half' | 'normalQuestionsAnsweredInHalf'>;
  questionKind?: MatchQuestionKind;
  previousQuestionKind?: MatchQuestionKind;
  clueCount?: number;
  postReadyAck?: boolean;
}): {
  playableAt: Date;
  deadlineAt: Date;
} {
  const preAnswerDelayMs = harnessDelayMs(getQuestionPreAnswerDelayMs(params));
  const playableAt = new Date(Date.now() + preAnswerDelayMs);
  // Collapse the answer WINDOW (deadline) in harness mode so unanswered specials
  // time out quickly. Use a larger fast value (2s) so the bot still has room to
  // answer. Scoring is unaffected — it uses the actual answer timeMs, not this.
  const durationMs = harnessDelayMs(
    getQuestionDurationMs(params.questionKind ?? 'multipleChoice', params.clueCount),
    2000,
  );
  const deadlineAt = new Date(playableAt.getTime() + durationMs);
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

  const speedStreakCandidateSeat = asSeat(candidate.speedStreakCandidateSeat) ?? null;
  const speedStreakCandidateCount = Math.max(
    0,
    Math.min(2, Number(candidate.speedStreakCandidateCount ?? 0))
  );
  const parsedSpeedStreakHolderSeat = asSeat(candidate.speedStreakHolderSeat) ?? null;
  const speedStreakHolderSeat =
    parsedSpeedStreakHolderSeat !== null &&
    speedStreakCandidateSeat === parsedSpeedStreakHolderSeat &&
    speedStreakCandidateCount >= 2
      ? parsedSpeedStreakHolderSeat
      : null;

  const penaltyGoals = {
    seat1: Math.max(0, Number(candidate.penaltyGoals.seat1 ?? fallback.penaltyGoals.seat1)),
    seat2: Math.max(0, Number(candidate.penaltyGoals.seat2 ?? fallback.penaltyGoals.seat2)),
  };
  const penaltyKicksTaken = {
    seat1: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat1 ?? 0)),
    seat2: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat2 ?? 0)),
  };

  return {
    ...fallback,
    ...candidate,
    goals: {
      seat1: Math.max(0, Number(candidate.goals.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals,
    possessionDiff: clamp(Number(candidate.possessionDiff ?? fallback.possessionDiff), -100, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    speedStreakHolderSeat,
    speedStreakCandidateSeat,
    speedStreakCandidateCount,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      uiReadyAt: typeof candidate.halftime?.uiReadyAt === 'string' ? candidate.halftime.uiReadyAt : null,
      readyDeferCount: typeof candidate.halftime?.readyDeferCount === 'number'
        ? Math.max(0, Math.trunc(candidate.halftime.readyDeferCount))
        : 0,
      categoryOptions: Array.isArray(candidate.halftime?.categoryOptions)
        ? candidate.halftime.categoryOptions.reduce<DraftCategory[]>((acc, category) => {
          if (!category || typeof category !== 'object') return acc;
          // `name` is normally the full i18n object; tolerate the legacy string
          // shape persisted by matches drafted before the i18n change.
          const normalizedName = normalizeI18nName(category.name);
          if (typeof category.id !== 'string' || normalizedName === null) return acc;
          const legacyImageUrl = (category as { image_url?: unknown }).image_url;
          acc.push({
            id: category.id,
            name: normalizedName,
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
      // Preserve the ban purpose so a rehydrate mid penalty-ban doesn't default
      // to 'second_half' and finalize into normal play instead of penalties.
      purpose: candidate.halftime?.purpose === 'penalty' ? 'penalty' : 'second_half',
    },
    lastAttack: {
      attackerSeat: asSeat(candidate.lastAttack?.attackerSeat),
    },
    imageMcq: normalizeImageMcqReservations(candidate.imageMcq),
    penalty: {
      round: Math.max(0, Number(candidate.penalty?.round ?? 0)),
      shooterSeat: asSeat(candidate.penalty?.shooterSeat) ?? 1,
      suddenDeath: Boolean(candidate.penalty?.suddenDeath),
      kicksTaken: penaltyKicksTaken,
      attempts: normalizePenaltyAttempts({
        attempts: candidate.penalty?.attempts,
        goals: penaltyGoals,
        kicksTaken: penaltyKicksTaken,
      }),
    },
    penaltyCategoryId: typeof candidate.penaltyCategoryId === 'string' ? candidate.penaltyCategoryId : null,
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
  // Surface the current half's reserved image-MCQ picture so the client can
  // warm it from the very first match:state of the half — long before the
  // image slot (Q4) actually dispatches.
  const reservedImageMcq = reservedImageMcqForHalf(state);
  return {
    matchId,
    phase: state.phase,
    half: state.half,
    possessionDiff: state.possessionDiff,
    // 2× streak only applies during normal play — never surface a holder in
    // halftime / last-attack / penalty / completed phases.
    speedStreakHolderSeat: state.phase === 'NORMAL_PLAY' ? state.speedStreakHolderSeat : null,
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
    penaltyAttempts: {
      seat1: state.penalty.attempts?.seat1 ?? [],
      seat2: state.penalty.attempts?.seat2 ?? [],
    },
    phaseKind,
    phaseRound,
    shooterSeat: state.currentQuestion?.shooterSeat ?? (state.phase === 'PENALTY_SHOOTOUT' ? state.penalty.shooterSeat : null),
    halftime: {
      deadlineAt: state.halftime.deadlineAt,
      uiReadyAt: state.halftime.uiReadyAt,
      categoryOptions: state.halftime.categoryOptions,
      firstBanSeat: state.halftime.firstBanSeat,
      bans: {
        seat1: state.halftime.bans.seat1,
        seat2: state.halftime.bans.seat2,
      },
      purpose: state.halftime.purpose,
    },
    penaltySuddenDeath: state.penalty.suddenDeath,
    stateVersion: state.stateVersionCounter,
    preloadImageUrls: reservedImageMcq?.imageUrl ? [reservedImageMcq.imageUrl] : [],
  };
}

// Re-exported from shared match-utils — single source of truth
export { bumpStateVersion } from './match-utils.js';
