import { matchesRepo } from './matches.repo.js';
import { lobbiesRepo } from '../lobbies/lobbies.repo.js';
import { logger, pickI18nText } from '../../core/index.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import type { GameQuestionDTO } from '../../realtime/socket.types.js';
import type {
  MatchRow,
  MatchQuestionWithCategory,
} from './matches.types.js';

const TOTAL_QUESTIONS = 10;
const QUESTIONS_PER_CATEGORY = 5;

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
      throw new Error('Lobby must have 2 members to create a match');
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

    const selections = await this.pickQuestions([categoryAId, categoryBId]);
    const shuffled = shuffle(selections);

    const match = await matchesRepo.createMatch({
      lobbyId: params.lobbyId,
      mode: params.mode,
      categoryAId,
      categoryBId,
      totalQuestions: TOTAL_QUESTIONS,
    });

    await matchesRepo.insertMatchPlayers(match.id, [
      { userId: seat1, seat: 1 },
      { userId: seat2, seat: 2 },
    ]);

    await matchesRepo.insertMatchQuestions(
      match.id,
      shuffled.map((q, index) => ({
        qIndex: index,
        questionId: q.questionId,
        categoryId: q.categoryId,
        correctIndex: q.correctIndex,
      }))
    );

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
        QUESTIONS_PER_CATEGORY * 3
      );
      if (rows.length < QUESTIONS_PER_CATEGORY) {
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
        if (categorySelections.length >= QUESTIONS_PER_CATEGORY) {
          break;
        }
      }

      if (categorySelections.length < QUESTIONS_PER_CATEGORY) {
        throw new Error('Not enough valid questions to start match');
      }
      selections.push(...categorySelections);
    }

    if (selections.length < TOTAL_QUESTIONS) {
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
  } | null> {
    const row: MatchQuestionWithCategory | null = await matchesRepo.getMatchQuestion(matchId, qIndex);
    if (!row) return null;

    const parsed = questionPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.type !== 'mcq_single') {
      return null;
    }

    return {
      question: {
        id: row.question_id,
        prompt: pickI18nText(row.prompt),
        options: parsed.data.options.map((option) => pickI18nText(option.text)),
        categoryId: row.category_id,
        categoryName: pickI18nText(row.category_name),
        difficulty: row.difficulty,
        explanation: null,
      },
      correctIndex: row.correct_index,
      categoryId: row.category_id,
    };
  },

  async computeAvgTimes(matchId: string): Promise<Map<string, number | null>> {
    const rows = await matchesRepo.getAverageTimes(matchId);
    return new Map(rows.map((row) => [row.user_id, row.avg_time_ms]));
  },
};
