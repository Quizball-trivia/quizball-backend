import { getRandom, seededShuffle } from '../../core/rng.js';
import { matchesRepo } from './matches.repo.js';
import { matchAnswersRepo } from './match-answers.repo.js';
import { matchEventsRepo } from './match-events.repo.js';
import { matchPlayersRepo } from './match-players.repo.js';
import { matchQuestionsRepo } from './match-questions.repo.js';
import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  MatchAnswerRow,
  MatchGoalEventRow,
  MatchPlayerRow,
  MatchQuestionPhaseKind,
} from './matches.types.js';
import { lobbiesRepo } from '../lobbies/lobbies.repo.js';
import { rankedService } from '../ranked/ranked.service.js';
import { usersRepo } from '../users/users.repo.js';
import { logger } from '../../core/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import type {
  ClueItemDTO,
  CountdownQuestionDTO,
  DraftCategory,
  GameQuestionDTO,
  MatchRoundReveal,
  MatchVariant,
  MultipleChoiceQuestionDTO,
  PutInOrderQuestionDTO,
} from '../../realtime/socket.types.js';
import type {
  MatchRow,
  MatchQuestionWithCategory,
} from './matches.types.js';
import type { RankedLobbyContext } from '../lobbies/lobbies.types.js';

/**
 * Ensure a JSONB field is a proper object (handles double-encoded strings from DB).
 */
function ensureI18nObject(field: unknown): Record<string, string> {
  if (!field) return {};
  if (typeof field === 'object' && !Array.isArray(field)) return field as Record<string, string>;
  if (typeof field === 'string') {
    try {
      const parsed = JSON.parse(field);
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    return { en: field };
  }
  return {};
}

const PUT_IN_ORDER_INSTRUCTION_I18N = {
  desc: {
    en: 'highest to lowest',
    ka: 'მაღლიდან დაბლისკენ',
  },
  asc: {
    en: 'lowest to highest',
    ka: 'დაბლიდან მაღლისკენ',
  },
} as const satisfies Record<'asc' | 'desc', Record<string, string>>;

function getPutInOrderInstruction(direction: 'asc' | 'desc'): Record<string, string> {
  return { ...PUT_IN_ORDER_INSTRUCTION_I18N[direction] };
}

function shuffleArray<T>(input: readonly T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(getRandom() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// Shuffle until the result is not already the correct order — otherwise the
// player sees the answer pre-arranged and wins for free.
function shuffleDifferentlyFromCorrect<T>(
  itemsInCorrectOrder: readonly T[],
  idOf: (item: T) => string,
): T[] {
  if (itemsInCorrectOrder.length <= 1) return [...itemsInCorrectOrder];
  const correctIds = itemsInCorrectOrder.map(idOf);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = shuffleArray(itemsInCorrectOrder);
    const sameAsCorrect = candidate.every((item, index) => idOf(item) === correctIds[index]);
    if (!sameAsCorrect) return candidate;
  }
  // Defensive fallback: swap first two to guarantee a different order.
  const fallback = [...itemsInCorrectOrder];
  [fallback[0], fallback[1]] = [fallback[1]!, fallback[0]!];
  return fallback;
}

interface CountdownAnswerGroupEvaluation {
  id: string;
  display: Record<string, string>;
  acceptedAnswers: string[];
}

interface PutInOrderEvaluationItem {
  id: string;
  label: Record<string, string>;
  details?: Record<string, string> | null;
  emoji?: string | null;
  sortValue: number;
}

export type MatchQuestionEvaluation =
  | {
      kind: 'multipleChoice';
      correctIndex: number;
    }
  | {
      kind: 'countdown';
      answerGroups: CountdownAnswerGroupEvaluation[];
    }
  | {
      kind: 'putInOrder';
      direction: 'asc' | 'desc';
      items: PutInOrderEvaluationItem[];
    }
  | {
      kind: 'clues';
      acceptedAnswers: string[];
      displayAnswer: Record<string, string>;
      clues: ClueItemDTO[];
    };

export interface BuiltMatchQuestionPayload {
  question: GameQuestionDTO;
  evaluation: MatchQuestionEvaluation;
  reveal: MatchRoundReveal;
  categoryId: string;
  phaseKind: 'normal' | 'shot' | 'last_attack' | 'penalty';
  phaseRound: number | null;
  shooterSeat: 1 | 2 | null;
  attackerSeat: 1 | 2 | null;
}

function buildQuestionAssets(row: MatchQuestionWithCategory, matchId: string): {
  question: GameQuestionDTO;
  evaluation: MatchQuestionEvaluation;
  reveal: MatchRoundReveal;
} | null {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    logger.warn({ questionId: row.question_id, errors: parsed.error.flatten() }, 'Malformed question payload');
    return null;
  }

  const common = {
    id: row.question_id,
    categoryId: row.category_id,
    categoryName: ensureI18nObject(row.category_name),
    difficulty: row.difficulty,
  };

  switch (parsed.data.type) {
    case 'mcq_single': {
      if (!parsed.data.options.some((option) => option.is_correct)) {
        logger.warn({ questionId: row.question_id }, 'MCQ question has no correct option');
        return null;
      }

      // Shuffle the answer options so a given question doesn't always show them
      // in the same order / with the correct answer in the same slot. The order
      // is deterministic per (match, question): both players — and any cache
      // rebuild after reconnect — derive the IDENTICAL order from the same seed,
      // while it differs across matches. correctIndex is recomputed for the
      // shuffled order.
      const shuffledOptions = seededShuffle(parsed.data.options, `${matchId}:${row.q_index}`);
      const correctIndex = shuffledOptions.findIndex((option) => option.is_correct);

      const question: MultipleChoiceQuestionDTO = {
        kind: 'multipleChoice',
        ...common,
        prompt: ensureI18nObject(row.prompt),
        options: shuffledOptions.map((option) => ensureI18nObject(option.text)),
        image: parsed.data.image
          ? {
            url: parsed.data.image.url,
            width: parsed.data.image.width,
            height: parsed.data.image.height,
            aspectRatio: parsed.data.image.aspect_ratio,
          }
          : undefined,
        explanation: null,
      };

      return {
        question,
        evaluation: {
          kind: 'multipleChoice',
          correctIndex,
        },
        reveal: {
          kind: 'multipleChoice',
          correctIndex,
        },
      };
    }

    case 'countdown_list': {
      const answerGroups = parsed.data.answer_groups.map((group) => ({
        id: group.id,
        display: ensureI18nObject(group.display),
        acceptedAnswers: group.accepted_answers,
      }));

      const question: CountdownQuestionDTO = {
        kind: 'countdown',
        ...common,
        prompt: ensureI18nObject(parsed.data.prompt),
        answerSlotCount: answerGroups.length,
      };

      return {
        question,
        evaluation: {
          kind: 'countdown',
          answerGroups,
        },
        reveal: {
          kind: 'countdown',
          answerGroups: answerGroups.map((group) => ({
            id: group.id,
            display: group.display,
          })),
        },
      };
    }

    case 'put_in_order': {
      const direction = parsed.data.direction;
      const items = parsed.data.items.map((item) => ({
        id: item.id,
        label: ensureI18nObject(item.label),
        details: item.details ? ensureI18nObject(item.details) : null,
        emoji: item.emoji ?? null,
        sortValue: item.sort_value,
      }));

      // sort_value represents rank/position (1 = first in correct order).
      // The direction field is a display hint for the player, not a sort modifier.
      const correctOrder = [...items].sort((left, right) =>
        left.sortValue - right.sortValue
      );

      // Shuffle items before sending to client so the player isn't handed the
      // answer pre-arranged. DB rows often arrive in their correct rank order
      // because admins enter them sequentially, which let players submit the
      // default order and win for free.
      const shuffledForClient = shuffleDifferentlyFromCorrect(correctOrder, (item) => item.id);

      const question: PutInOrderQuestionDTO = {
        kind: 'putInOrder',
        ...common,
        prompt: ensureI18nObject(parsed.data.prompt),
        instruction: getPutInOrderInstruction(direction),
        direction,
        items: shuffledForClient.map((item) => ({
          id: item.id,
          label: item.label,
          details: item.details,
          emoji: item.emoji,
        })),
      };

      return {
        question,
        evaluation: {
          kind: 'putInOrder',
          direction,
          items,
        },
        reveal: {
          kind: 'putInOrder',
          correctOrder,
        },
      };
    }

    case 'clue_chain': {
      const clues = parsed.data.clues.map((clue) => ({
        type: clue.type,
        content: ensureI18nObject(clue.content),
      }));

      return {
        question: {
          kind: 'clues',
          ...common,
          prompt: ensureI18nObject(row.prompt),
          clues,
        },
        evaluation: {
          kind: 'clues',
          acceptedAnswers: parsed.data.accepted_answers,
          displayAnswer: ensureI18nObject(parsed.data.display_answer),
          clues,
        },
        reveal: {
          kind: 'clues',
          displayAnswer: ensureI18nObject(parsed.data.display_answer),
        },
      };
    }

    default:
      logger.warn({ questionId: row.question_id, type: (parsed.data as { type: string }).type }, 'Unknown question type');
      return null;
  }
}

export const POSSESSION_QUESTIONS_PER_HALF = 6;
export const POSSESSION_TOTAL_NORMAL_QUESTIONS = POSSESSION_QUESTIONS_PER_HALF * 2;
export const PARTY_QUIZ_TOTAL_QUESTIONS = 10;

export type MatchWinnerDecisionMethod =
  | 'goals'
  | 'penalty_goals'
  | 'total_points'
  | 'total_points_fallback'
  | 'forfeit';

/**
 * Image MCQ pre-picked for a half's image slot. `imageUrl` is the raw stored
 * URL — the client applies its own optimization transform and preloads it as
 * soon as it appears in match:state, so the picture is warm before the slot.
 */
export interface ReservedImageMcq {
  questionId: string;
  imageUrl: string;
}

export interface PossessionStatePayload {
  version: 1;
  variant: 'friendly_possession' | 'ranked_sim';
  phase: 'NORMAL_PLAY' | 'LAST_ATTACK' | 'HALFTIME' | 'PENALTY_SHOOTOUT' | 'COMPLETED';
  half: 1 | 2;
  possessionDiff: number;
  kickOffSeat: 1 | 2;
  /**
   * Seat currently holding the 2× speed streak. It only becomes active after a
   * player wins two qualifying normal rounds in a row. While set, that seat's
   * possession gain is doubled on the NEXT round. Cleared on wrong/slower/tie
   * or a goal. null = no active streak.
   */
  speedStreakHolderSeat: 1 | 2 | null;
  /**
   * Internal qualification progress for the next 2× streak. Not sent to the
   * client; used so the first faster-correct round starts the streak setup but
   * does not show/apply 2× yet.
   */
  speedStreakCandidateSeat: 1 | 2 | null;
  speedStreakCandidateCount: number;
  goals: { seat1: number; seat2: number };
  penaltyGoals: { seat1: number; seat2: number };
  normalQuestionsPerHalf: number;
  normalQuestionsAnsweredInHalf: number;
  normalQuestionsAnsweredTotal: number;
  lastAttack: {
    attackerSeat: 1 | 2 | null;
  };
  halftime: {
    deadlineAt: string | null;
    uiReadyAt: string | null;
    /**
     * How many times finalizeHalftime has extended the deadline waiting for a
     * client to signal `match:halftime_ui_ready`. Bounded — once the cap is
     * reached the ban window force-opens so broken clients can't stall.
     */
    readyDeferCount: number;
    categoryOptions: DraftCategory[];
    firstHalfShownCategoryIds: string[];
    firstBanSeat: 1 | 2 | null;
    bans: {
      seat1: string | null;
      seat2: string | null;
    };
    /**
     * What this ban interlude is for. The penalty shootout reuses the entire
     * HALFTIME ban machinery via this discriminator: 'penalty' makes finalize
     * exit into PENALTY_SHOOTOUT (with the chosen category as penaltyCategoryId)
     * instead of the second half.
     */
    purpose: 'second_half' | 'penalty';
  };
  penalty: {
    round: number;
    shooterSeat: 1 | 2;
    suddenDeath: boolean;
    kicksTaken: { seat1: number; seat2: number };
    attempts?: { seat1: Array<'goal' | 'miss'>; seat2: Array<'goal' | 'miss'> };
  };
  /** Category chosen in the penalty ban phase; read only during PENALTY_SHOOTOUT. */
  penaltyCategoryId: string | null;
  /**
   * Image MCQ reserved for each half's image slot (Q4). Reserved up-front at
   * the half's first normal question so the client can preload the image well
   * before the slot starts. Per half key: undefined = not attempted yet,
   * null = attempted but the drafted category has no image MCQ available
   * (slot falls back to a normal MCQ).
   */
  imageMcq?: {
    half1?: ReservedImageMcq | null;
    half2?: ReservedImageMcq | null;
  };
  currentQuestion: {
    qIndex: number;
    phaseKind: 'normal' | 'last_attack' | 'penalty';
    phaseRound: number;
    shooterSeat: 1 | 2 | null;
    attackerSeat: 1 | 2 | null;
  } | null;
  winnerDecisionMethod: MatchWinnerDecisionMethod | null;
  stateVersionCounter: number;
}

export interface PartyQuizStatePayload {
  version: 1;
  variant: 'friendly_party_quiz';
  totalQuestions: number;
  currentQuestion: {
    qIndex: number;
    correctIndex?: number;
  } | null;
  answeredUserIds: string[];
  droppedUserIds: string[];
  winnerDecisionMethod: MatchWinnerDecisionMethod | null;
  stateVersionCounter: number;
}

export interface MatchCreationResult {
  match: MatchRow;
  playerIds: string[];
  variant: MatchVariant;
}

export type MatchStatePayload = PossessionStatePayload | PartyQuizStatePayload;

export function createInitialPossessionState(
  variant: 'friendly_possession' | 'ranked_sim'
): PossessionStatePayload {
  return {
    version: 1,
    variant,
    phase: 'NORMAL_PLAY',
    half: 1,
    possessionDiff: 0,
    kickOffSeat: 1,
    speedStreakHolderSeat: null,
    speedStreakCandidateSeat: null,
    speedStreakCandidateCount: 0,
    goals: { seat1: 0, seat2: 0 },
    penaltyGoals: { seat1: 0, seat2: 0 },
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: 0,
    normalQuestionsAnsweredTotal: 0,
    lastAttack: {
      attackerSeat: null,
    },
    imageMcq: {},
    halftime: {
      deadlineAt: null,
      uiReadyAt: null,
      readyDeferCount: 0,
      categoryOptions: [],
      firstHalfShownCategoryIds: [],
      firstBanSeat: null,
      bans: {
        seat1: null,
        seat2: null,
      },
      purpose: 'second_half',
    },
    penalty: {
      round: 0,
      shooterSeat: 1,
      suddenDeath: false,
      kicksTaken: {
        seat1: 0,
        seat2: 0,
      },
      attempts: {
        seat1: [],
        seat2: [],
      },
    },
    penaltyCategoryId: null,
    currentQuestion: null,
    winnerDecisionMethod: null,
    stateVersionCounter: 0,
  };
}

export function createInitialPartyQuizState(
  totalQuestions = PARTY_QUIZ_TOTAL_QUESTIONS
): PartyQuizStatePayload {
  return {
    version: 1,
    variant: 'friendly_party_quiz',
    totalQuestions,
    currentQuestion: null,
    answeredUserIds: [],
    droppedUserIds: [],
    winnerDecisionMethod: null,
    stateVersionCounter: 0,
  };
}

export function resolveMatchVariant(
  statePayload: unknown,
  mode: 'friendly' | 'ranked'
): MatchVariant {
  const candidate = statePayload as Partial<{ variant: MatchVariant }> | null;
  if (
    candidate?.variant === 'friendly_possession' ||
    candidate?.variant === 'friendly_party_quiz' ||
    candidate?.variant === 'ranked_sim'
  ) {
    return candidate.variant;
  }

  return mode === 'ranked' ? 'ranked_sim' : 'friendly_possession';
}

export const matchesService = {
  async createMatchFromLobby(params: {
    lobbyId: string;
    mode: 'friendly' | 'ranked';
    variant: MatchVariant;
    hostUserId: string;
    categoryAId: string;
    categoryBId: string | null;
    isDev?: boolean;
    totalQuestions?: number;
  }): Promise<MatchCreationResult> {
    const members = await lobbiesRepo.listMembersWithUser(params.lobbyId);
    const memberIds = members.map((m) => m.user_id);
    let playerIds: string[];

    if (params.variant === 'friendly_party_quiz') {
      if (memberIds.length < 2 || memberIds.length > 6) {
        throw new AppError(
          'Party quiz requires between 2 and 6 members',
          400,
          ErrorCode.BAD_REQUEST
        );
      }

      const hostIndex = memberIds.indexOf(params.hostUserId);
      if (hostIndex <= 0) {
        playerIds = [...memberIds];
      } else {
        playerIds = [params.hostUserId, ...memberIds.filter((id) => id !== params.hostUserId)];
      }
    } else {
      if (memberIds.length !== 2) {
        throw new AppError(
          'Lobby must have exactly 2 members to create a match',
          400,
          ErrorCode.BAD_REQUEST
        );
      }

      const hostIndex = memberIds.indexOf(params.hostUserId);
      let seat1: string;
      let seat2: string;

      if (hostIndex !== -1) {
        seat1 = params.hostUserId;
        const candidateSeat2 = memberIds.find((id) => id !== seat1);

        if (!candidateSeat2 || candidateSeat2 === seat1) {
          logger.error(
            { lobbyId: params.lobbyId, hostUserId: params.hostUserId, memberIds, candidateSeat2 },
            'Invalid lobby state: could not determine second player'
          );
          seat1 = memberIds[0];
          seat2 = memberIds[1];
        } else {
          seat2 = candidateSeat2;
        }
      } else {
        logger.warn(
          { lobbyId: params.lobbyId, hostUserId: params.hostUserId, memberIds },
          'Host not found in lobby members, using first two members'
        );
        seat1 = memberIds[0];
        seat2 = memberIds[1];
      }

      playerIds = [seat1, seat2];
    }

    // For ranked AI matches, store a stable AI context so matchmaking, gameplay and settlement
    // all use the same synthetic opponent RP and difficulty profile.
    let rankedContext: RankedLobbyContext | null = null;
    if (params.mode === 'ranked') {
      const [seat1, seat2] = playerIds;
      const [user1, user2] = await Promise.all([
        usersRepo.getById(seat1),
        usersRepo.getById(seat2),
      ]);

      let humanUserId: string | null = null;
      const hasAiOpponent = Boolean(user1?.is_ai) !== Boolean(user2?.is_ai);
      if (hasAiOpponent) {
        if (user1 && !user1.is_ai) humanUserId = seat1;
        else if (user2 && !user2.is_ai) humanUserId = seat2;
      }

      if (hasAiOpponent && !humanUserId) {
        logger.warn(
          { lobbyId: params.lobbyId, seat1, seat2 },
          'Could not determine human player for ranked AI context'
        );
      } else if (humanUserId) {
        try {
          const profile = await rankedService.ensureProfile(humanUserId);
          rankedContext = rankedService.buildAiMatchContext(profile);
          logger.info(
            { lobbyId: params.lobbyId, humanUserId, rankedContext },
            'Built ranked AI context for match'
          );
        } catch (err) {
          if (err instanceof AppError) throw err;
          logger.error(
            { err, humanUserId, fn: 'createMatchFromLobby' },
            'Failed to load ranked profile; proceeding without ranked context'
          );
        }
      }
    }

    const totalQuestions = params.totalQuestions
      ?? (params.variant === 'friendly_party_quiz' ? PARTY_QUIZ_TOTAL_QUESTIONS : POSSESSION_TOTAL_NORMAL_QUESTIONS);
    const statePayload =
      params.variant === 'friendly_party_quiz'
        ? createInitialPartyQuizState(totalQuestions)
        : createInitialPossessionState(params.variant === 'ranked_sim' ? 'ranked_sim' : 'friendly_possession');

    const match = await matchesRepo.createMatch({
      lobbyId: params.lobbyId,
      mode: params.mode,
      categoryAId: params.categoryAId,
      categoryBId: params.categoryBId,
      totalQuestions,
      statePayload,
      rankedContext,
      isDev: params.isDev,
    });

    await matchPlayersRepo.insertMatchPlayers(
      match.id,
      playerIds.map((userId, index) => ({
        userId,
        seat: index + 1,
      }))
    );

    return {
      match,
      playerIds,
      variant: params.variant,
    };
  },

  async buildGameQuestion(matchId: string, qIndex: number): Promise<GameQuestionDTO | null> {
    const row = await matchQuestionsRepo.getMatchQuestion(matchId, qIndex);
    if (!row) return null;
    return buildQuestionAssets(row, matchId)?.question ?? null;
  },

  async buildMatchQuestionPayload(matchId: string, qIndex: number): Promise<BuiltMatchQuestionPayload | null> {
    const row: MatchQuestionWithCategory | null = await matchQuestionsRepo.getMatchQuestion(matchId, qIndex);
    if (!row) return null;

    logger.debug({
      matchId,
      qIndex,
      questionId: row.question_id,
    }, 'Building match question payload');

    const assets = buildQuestionAssets(row, matchId);
    if (!assets) {
      return null;
    }

    return {
      question: assets.question,
      evaluation: assets.evaluation,
      reveal: assets.reveal,
      categoryId: row.category_id,
      phaseKind: row.phase_kind,
      phaseRound: row.phase_round,
      shooterSeat: row.shooter_seat as 1 | 2 | null,
      attackerSeat: row.attacker_seat as 1 | 2 | null,
    };
  },

  async computeAvgTimes(matchId: string): Promise<Map<string, number | null>> {
    const rows = await matchAnswersRepo.getAverageTimes(matchId);
    return new Map(rows.map((row) => [row.user_id, row.avg_time_ms]));
  },

  async abandonMatch(matchId: string): Promise<void> {
    const abandoned = await matchesRepo.abandonMatch(matchId);
    if (!abandoned) {
      throw new AppError(
        'Match is not active or does not exist',
        400,
        ErrorCode.BAD_REQUEST
      );
    }
  },

  /**
   * Flip a match to "completed" and fan stats out to the per-user
   * `user_mode_match_stats` aggregate. Atomic — if the stats upsert
   * throws, the match completion rolls back too, so the match stays
   * in 'active' and the caller can retry. Idempotent on subsequent
   * calls (the `WHERE status = 'active'` guard short-circuits).
   *
   * Owns the win/loss/draw policy and the is_dev skip rule — those
   * were business rules previously living in matches.repo.completeMatch,
   * which violated the "repos = data writes only" boundary.
   */
  async completeMatch(matchId: string, winnerId: string | null): Promise<void> {
    await sql.begin(async (tx) => {
      const completed = await matchesRepo.markMatchCompleted(tx, matchId, winnerId);
      if (!completed) {
        // Already completed/abandoned — nothing to do.
        return;
      }

      // Dev matches don't contribute to aggregate stats.
      if (completed.is_dev) {
        return;
      }

      const players = await matchPlayersRepo.listMatchPlayers(matchId, tx);
      if (players.length === 0) return;

      const statRows = players.map((player) => {
        const isDraw = winnerId === null;
        const isWinner = winnerId !== null && winnerId === player.user_id;
        return {
          userId: player.user_id,
          mode: completed.mode,
          wins: (isWinner ? 1 : 0) as 0 | 1,
          losses: (!isDraw && !isWinner ? 1 : 0) as 0 | 1,
          draws: (isDraw ? 1 : 0) as 0 | 1,
          lastMatchAt: completed.ended_at,
        };
      });

      await matchesRepo.recordUserModeStats(tx, statRows);
    });
  },

  /**
   * Atomic goal write. Inserts a `match_goal_events` row (idempotent
   * via ON CONFLICT) and increments the player's goal/penalty-goal
   * counter inside the same DB transaction. Either both succeed or
   * both roll back — never partial state.
   *
   * Returns `inserted: true` only when the event row was newly
   * created; on a duplicate (e.g. a retry after a transient network
   * blip) the player totals are left untouched.
   *
   * Was on matches.repo as `incrementGoalsAndInsertEventIfMissing`;
   * moved here in the repo split so the cross-entity transaction is
   * owned by the service layer. Repos stay table-pure.
   */
  async incrementGoalsAndInsertEventIfMissing(data: {
    matchId: string;
    userId: string;
    seat: 1 | 2;
    half: 1 | 2;
    phaseKind: MatchQuestionPhaseKind;
    qIndex: number | null;
    isPenalty: boolean;
    delta: { goals?: number; penaltyGoals?: number };
  }): Promise<{ inserted: boolean; player: MatchPlayerRow | null }> {
    return sql.begin(async (tx) => {
      const inserted: MatchGoalEventRow | null = await matchEventsRepo.insertGoalEventIfMissingInTx(tx, {
        matchId: data.matchId,
        userId: data.userId,
        seat: data.seat,
        half: data.half,
        phaseKind: data.phaseKind,
        qIndex: data.qIndex,
        isPenalty: data.isPenalty,
      });
      if (!inserted) {
        return { inserted: false, player: null };
      }
      const player = await matchPlayersRepo.updatePlayerGoalTotalsInTx(
        tx,
        data.matchId,
        data.userId,
        data.delta,
      );
      return { inserted: true, player };
    }) as Promise<{ inserted: boolean; player: MatchPlayerRow | null }>;
  },

  /**
   * Atomic party-quiz answer write. Inserts a match_answers row
   * (idempotent via ON CONFLICT) and on first-write increments the
   * player's totals inside the same DB transaction.
   *
   * On duplicate (a retry): the second call's insert no-ops, and we
   * read the already-present rows so the caller can echo back the
   * authoritative state without re-applying the score delta.
   *
   * Was on matches.repo as `recordPartyQuizAnswerIfMissing`; moved
   * here so the cross-entity transaction is owned by the service
   * layer. Repos stay table-pure.
   */
  async recordPartyQuizAnswerIfMissing(data: {
    matchId: string;
    qIndex: number;
    userId: string;
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    answerPayload?: Json | null;
    phaseKind?: MatchQuestionPhaseKind;
    phaseRound?: number | null;
    shooterSeat?: number | null;
  }): Promise<{ inserted: boolean; answer: MatchAnswerRow | null; player: MatchPlayerRow | null }> {
    try {
      return await sql.begin(async (tx) => {
        const insertedAnswer = await matchAnswersRepo.insertMatchAnswerIfMissingInTx(tx, data);

        if (insertedAnswer) {
          const updatedPlayer = await matchPlayersRepo.updatePlayerTotalsInTx(
            tx,
            data.matchId,
            data.userId,
            data.pointsEarned,
            data.isCorrect,
          );

          // UPDATE must hit one row — otherwise the answer persists without
          // the score increment. Throw to roll back the transaction.
          if (!updatedPlayer) {
            throw new AppError(
              'match_players row missing during party answer insert',
              500,
              ErrorCode.INTERNAL_ERROR,
              { matchId: data.matchId, userId: data.userId },
            );
          }

          return {
            inserted: true,
            answer: insertedAnswer,
            player: updatedPlayer,
          };
        }

        // ON CONFLICT path — answer already existed. Read back the
        // authoritative rows so the caller has consistent state.
        const existingAnswer = await matchAnswersRepo.getAnswerForUserInTx(
          tx,
          data.matchId,
          data.qIndex,
          data.userId,
        );
        const existingPlayerRows = await tx.unsafe<MatchPlayerRow[]>(
          `SELECT * FROM match_players WHERE match_id = $1 AND user_id = $2`,
          [data.matchId, data.userId],
        );

        return {
          inserted: false,
          answer: existingAnswer,
          player: existingPlayerRows[0] ?? null,
        };
      }) as { inserted: boolean; answer: MatchAnswerRow | null; player: MatchPlayerRow | null };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('Failed to record party quiz answer', 500, ErrorCode.INTERNAL_ERROR, err);
    }
  },

  /**
   * Admin/dev-only cleanup. Removes old dev matches (kept count
   * preserved as a buffer) plus any AI users that exist ONLY in
   * those cleaned matches. Returns the count of match rows deleted.
   *
   * The single CTE statement is what gives us atomicity — either
   * all 5 deletes commit or none do, no sql.begin required. Lives
   * here in the service rather than matches.repo because the
   * operation spans 5 tables (4 match tables + orphan AI users) and
   * is a lifecycle concern, not pure data access.
   *
   * Guarantees verified by tests:
   *   - Non-dev matches are never touched.
   *   - Non-AI users are never touched.
   *   - AI users that still have non-dev matches are kept.
   *   - AI users orphaned by this cleanup ARE deleted.
   *   - Dev match rows ARE cleaned across all 4 match tables.
   */
  async cleanupOldDevMatches(keep: number): Promise<number> {
    const deleted = await sql<{ id: string }[]>`
      WITH matches_to_delete AS (
        SELECT id
        FROM matches
        WHERE is_dev = true AND status IN ('completed', 'abandoned')
        ORDER BY started_at DESC
        OFFSET ${keep}
      ),
      orphaned_ai_users AS (
        SELECT DISTINCT mp.user_id
        FROM match_players mp
        JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id IN (SELECT id FROM matches_to_delete)
          AND u.is_ai = true
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp2
            WHERE mp2.user_id = mp.user_id
              AND mp2.match_id NOT IN (SELECT id FROM matches_to_delete)
          )
      ),
      del_answers AS (
        DELETE FROM match_answers WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_questions AS (
        DELETE FROM match_questions WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_players AS (
        DELETE FROM match_players WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_matches AS (
        DELETE FROM matches WHERE id IN (SELECT id FROM matches_to_delete)
        RETURNING id
      ),
      del_ai_users AS (
        DELETE FROM users WHERE id IN (SELECT user_id FROM orphaned_ai_users)
      )
      SELECT id FROM del_matches
    `;
    return deleted.length;
  },
};
