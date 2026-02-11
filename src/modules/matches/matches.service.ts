import { matchesRepo } from './matches.repo.js';
import { lobbiesRepo } from '../lobbies/lobbies.repo.js';
import { logger, pickI18nText } from '../../core/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import type { GameQuestionDTO } from '../../realtime/socket.types.js';
import type {
  MatchEngine,
  MatchRow,
  MatchQuestionWithCategory,
} from './matches.types.js';
import { config } from '../../core/config.js';

const CLASSIC_TOTAL_QUESTIONS = 10;
const CLASSIC_QUESTIONS_PER_CATEGORY = 5;
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
  winnerDecisionMethod: 'goals' | 'penalty_goals' | 'total_points_fallback' | null;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export interface MatchQuestionSelection {
  questionId: string;
  categoryId: string;
  correctIndex: number;
}

export interface MatchCreationResult {
  match: MatchRow;
  playerIds: [string, string];
}

function resolveMatchEngine(): MatchEngine {
  return config.POSSESSION_V1_ENABLED ? 'possession_v1' : 'classic';
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
    const engine = resolveMatchEngine();

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

    const shouldPreselectClassicQuestions = engine === 'classic';
    const selections = shouldPreselectClassicQuestions
      ? await this.pickQuestions([categoryAId, categoryBId])
      : [];
    const shuffled = shouldPreselectClassicQuestions ? shuffle(selections) : [];

    const match = await matchesRepo.createMatch({
      lobbyId: params.lobbyId,
      mode: params.mode,
      engine,
      categoryAId,
      categoryBId,
      totalQuestions: engine === 'classic' ? CLASSIC_TOTAL_QUESTIONS : POSSESSION_TOTAL_NORMAL_QUESTIONS,
      statePayload: engine === 'possession_v1' ? createInitialPossessionState() : null,
    });

    await matchesRepo.insertMatchPlayers(match.id, [
      { userId: seat1, seat: 1 },
      { userId: seat2, seat: 2 },
    ]);

    if (shouldPreselectClassicQuestions) {
      await matchesRepo.insertMatchQuestions(
        match.id,
        shuffled.map((q, index) => ({
          qIndex: index,
          questionId: q.questionId,
          categoryId: q.categoryId,
          correctIndex: q.correctIndex,
        }))
      );
    }

    return {
      match,
      playerIds: [seat1, seat2],
    };
  },

  async pickQuestions(categoryIds: [string, string]): Promise<MatchQuestionSelection[]> {
    const selections: MatchQuestionSelection[] = [];

    for (const categoryId of categoryIds) {
      const rows = await matchesRepo.getRandomQuestionsForCategory(
        categoryId,
        CLASSIC_QUESTIONS_PER_CATEGORY * 3
      );
      if (rows.length < CLASSIC_QUESTIONS_PER_CATEGORY) {
        throw new Error('Not enough questions to start match');
      }

      const categorySelections: MatchQuestionSelection[] = [];
      for (const row of rows) {
        const parsed = questionPayloadSchema.safeParse(row.payload);
        if (!parsed.success || parsed.data.type !== 'mcq_single') {
          continue;
        }
        const correctIndex = parsed.data.options.findIndex((option) => option.is_correct);
        if (correctIndex < 0) {
          continue;
        }
        categorySelections.push({
          questionId: row.id,
          categoryId: row.category_id,
          correctIndex,
        });
        if (categorySelections.length >= CLASSIC_QUESTIONS_PER_CATEGORY) {
          break;
        }
      }

      if (categorySelections.length < CLASSIC_QUESTIONS_PER_CATEGORY) {
        throw new Error('Not enough valid questions to start match');
      }
      selections.push(...categorySelections);
    }

    if (selections.length < CLASSIC_TOTAL_QUESTIONS) {
      throw new Error('Not enough valid questions to start match');
    }

    return selections;
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
      prompt: pickI18nText(row.prompt),
      options: parsed.data.options.map((option) => pickI18nText(option.text)),
      categoryId: row.category_id,
      categoryName: pickI18nText(row.category_name),
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
      promptRaw: row.prompt,
      promptType: typeof row.prompt,
      categoryNameRaw: row.category_name,
      categoryNameType: typeof row.category_name,
    }, 'Building match question payload');

    const parsed = questionPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.type !== 'mcq_single') {
      return null;
    }

    const promptText = pickI18nText(row.prompt);
    const categoryNameText = pickI18nText(row.category_name);
    const optionsTexts = parsed.data.options.map((option) => pickI18nText(option.text));

    logger.debug({
      matchId,
      qIndex,
      promptText,
      promptTextLength: promptText.length,
      categoryNameText,
      optionsTexts,
      optionsCount: optionsTexts.length,
    }, 'Parsed question texts');

    return {
      question: {
        id: row.question_id,
        prompt: promptText,
        options: optionsTexts,
        categoryId: row.category_id,
        categoryName: categoryNameText,
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
