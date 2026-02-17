import { matchesRepo } from './matches.repo.js';
import { lobbiesRepo } from '../lobbies/lobbies.repo.js';
import { rankedService } from '../ranked/ranked.service.js';
import { usersRepo } from '../users/users.repo.js';
import { logger } from '../../core/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import type { GameQuestionDTO } from '../../realtime/socket.types.js';
import type {
  MatchRow,
  MatchQuestionWithCategory,
} from './matches.types.js';

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

export const POSSESSION_QUESTIONS_PER_HALF = 6;
export const POSSESSION_TOTAL_NORMAL_QUESTIONS = POSSESSION_QUESTIONS_PER_HALF * 2;

type PossessionTactic = 'press-high' | 'play-safe' | 'all-in';

export interface PossessionStatePayload {
  version: 1;
  phase: 'NORMAL_PLAY' | 'SHOT_ON_GOAL' | 'HALFTIME' | 'PENALTY_SHOOTOUT' | 'COMPLETED';
  half: 1 | 2;
  sharedPossession: number;
  seatMomentum: { seat1: number; seat2: number };
  kickOffSeat: 1 | 2;
  goals: { seat1: number; seat2: number };
  penaltyGoals: { seat1: number; seat2: number };
  normalQuestionsPerHalf: number;
  normalQuestionsAnsweredInHalf: number;
  normalQuestionsAnsweredTotal: number;
  shot: {
    attackerSeat: 1 | 2 | null;
  };
  halftime: {
    deadlineAt: string | null;
    tactics: {
      seat1: PossessionTactic | null;
      seat2: PossessionTactic | null;
    };
  };
  penalty: {
    round: number;
    shooterSeat: 1 | 2;
    suddenDeath: boolean;
    kicksTaken: { seat1: number; seat2: number };
  };
  currentQuestion: {
    qIndex: number;
    phaseKind: 'normal' | 'shot' | 'penalty';
    phaseRound: number;
    shooterSeat: 1 | 2 | null;
    attackerSeat: 1 | 2 | null;
  } | null;
  winnerDecisionMethod: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null;
  stateVersionCounter: number;
}

export interface MatchCreationResult {
  match: MatchRow;
  playerIds: [string, string];
}

export function createInitialPossessionState(): PossessionStatePayload {
  return {
    version: 1,
    phase: 'NORMAL_PLAY',
    half: 1,
    sharedPossession: 50,
    seatMomentum: { seat1: 0, seat2: 0 },
    kickOffSeat: 1,
    goals: { seat1: 0, seat2: 0 },
    penaltyGoals: { seat1: 0, seat2: 0 },
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: 0,
    normalQuestionsAnsweredTotal: 0,
    shot: {
      attackerSeat: null,
    },
    halftime: {
      deadlineAt: null,
      tactics: {
        seat1: null,
        seat2: null,
      },
    },
    penalty: {
      round: 0,
      shooterSeat: 1,
      suddenDeath: false,
      kicksTaken: {
        seat1: 0,
        seat2: 0,
      },
    },
    currentQuestion: null,
    winnerDecisionMethod: null,
    stateVersionCounter: 0,
  };
}

export const matchesService = {
  async createMatchFromLobby(params: {
    lobbyId: string;
    mode: 'friendly' | 'ranked';
    hostUserId: string;
    categoryIds: [string, string];
  }): Promise<MatchCreationResult> {
    const members = await lobbiesRepo.listMembersWithUser(params.lobbyId);
    const memberIds = members.map((m) => m.user_id);

    if (memberIds.length !== 2) {
      throw new AppError(
        'Lobby must have exactly 2 members to create a match',
        400,
        ErrorCode.BAD_REQUEST
      );
    }

    const [categoryAId, categoryBId] = params.categoryIds;

    const hostIndex = memberIds.indexOf(params.hostUserId);
    let seat1: string;
    let seat2: string;

    if (hostIndex !== -1) {
      // Host is in the lobby - host gets seat 1
      seat1 = params.hostUserId;
      const candidateSeat2 = memberIds.find((id) => id !== seat1);

      if (!candidateSeat2 || candidateSeat2 === seat1) {
        logger.error(
          { lobbyId: params.lobbyId, hostUserId: params.hostUserId, memberIds, candidateSeat2 },
          'Invalid lobby state: could not determine second player'
        );
        // Fall back to using first two members as a safe default
        seat1 = memberIds[0];
        seat2 = memberIds[1];
      } else {
        seat2 = candidateSeat2;
      }
    } else {
      // Host not found (edge case) - use first two members
      logger.warn(
        { lobbyId: params.lobbyId, hostUserId: params.hostUserId, memberIds },
        'Host not found in lobby members, using first two members'
      );
      seat1 = memberIds[0];
      seat2 = memberIds[1];
    }

    // For ranked matches, build placement AI context so the anchor adapts per match
    let rankedContext: unknown;
    if (params.mode === 'ranked') {
      const user1 = await usersRepo.getById(seat1);
      const humanUserId = user1?.is_ai ? seat2 : seat1;
      const profile = await rankedService.ensureProfile(humanUserId);
      if (rankedService.isPlacementRequired(profile)) {
        rankedContext = rankedService.buildPlacementAiContext(profile);
        logger.info(
          { lobbyId: params.lobbyId, humanUserId, rankedContext },
          'Built placement AI context for ranked match'
        );
      }
    }

    const match = await matchesRepo.createMatch({
      lobbyId: params.lobbyId,
      mode: params.mode,
      categoryAId,
      categoryBId,
      totalQuestions: POSSESSION_TOTAL_NORMAL_QUESTIONS,
      statePayload: createInitialPossessionState(),
      rankedContext,
    });

    await matchesRepo.insertMatchPlayers(match.id, [
      { userId: seat1, seat: 1 },
      { userId: seat2, seat: 2 },
    ]);

    return {
      match,
      playerIds: [seat1, seat2],
    };
  },

  async buildGameQuestion(matchId: string, qIndex: number): Promise<GameQuestionDTO | null> {
    const row = await matchesRepo.getMatchQuestion(matchId, qIndex);
    if (!row) return null;

    const parsed = questionPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.type !== 'mcq_single') {
      return null;
    }

    return {
      id: row.question_id,
      prompt: ensureI18nObject(row.prompt),
      options: parsed.data.options.map((option) => ensureI18nObject(option.text)),
      categoryId: row.category_id,
      categoryName: ensureI18nObject(row.category_name),
      difficulty: row.difficulty,
      explanation: null,
    };
  },

  async buildMatchQuestionPayload(matchId: string, qIndex: number): Promise<{
    question: GameQuestionDTO;
    correctIndex: number;
    categoryId: string;
    phaseKind: 'normal' | 'shot' | 'penalty';
    phaseRound: number | null;
    shooterSeat: 1 | 2 | null;
    attackerSeat: 1 | 2 | null;
  } | null> {
    const row: MatchQuestionWithCategory | null = await matchesRepo.getMatchQuestion(matchId, qIndex);
    if (!row) return null;

    logger.debug({
      matchId,
      qIndex,
      questionId: row.question_id,
    }, 'Building match question payload');

    const parsed = questionPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.type !== 'mcq_single') {
      return null;
    }

    return {
      question: {
        id: row.question_id,
        prompt: ensureI18nObject(row.prompt),
        options: parsed.data.options.map((option) => ensureI18nObject(option.text)),
        categoryId: row.category_id,
        categoryName: ensureI18nObject(row.category_name),
        difficulty: row.difficulty,
        explanation: null,
      },
      correctIndex: row.correct_index,
      categoryId: row.category_id,
      phaseKind: row.phase_kind,
      phaseRound: row.phase_round,
      shooterSeat: row.shooter_seat as 1 | 2 | null,
      attackerSeat: row.attacker_seat as 1 | 2 | null,
    };
  },

  async computeAvgTimes(matchId: string): Promise<Map<string, number | null>> {
    const rows = await matchesRepo.getAverageTimes(matchId);
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
};
