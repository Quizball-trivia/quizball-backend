import { POSSESSION_QUESTIONS_PER_HALF, type PossessionStatePayload } from '../modules/matches/matches.service.js';
import type { QuestionType } from '../modules/questions/questions.schemas.js';
import {
  answerCount,
  getCachedPlayer,
  getExpectedUserIds,
  type CachedPlayer,
  type CachedSeat,
  type MatchCache,
} from './match-cache.js';
import { getCachedMultipleChoiceCorrectIndex } from './question-compat.js';
import type { MatchAnswerAckPayload, MatchQuestionKind } from './socket.types.js';

const NORMAL_HALF_SEQUENCE: QuestionType[] = [
  'mcq_single',
  'mcq_single',
  'mcq_single',
  'countdown_list',
  'put_in_order',
  'clue_chain',
];

export function getUserIdByCachedSeat(players: CachedPlayer[], seat: CachedSeat): string | null {
  return players.find((player) => player.seat === seat)?.userId ?? null;
}

export function toCachedAnswerByUserId(cache: MatchCache): Map<string, { is_correct: boolean; time_ms: number }> {
  return new Map(
    Object.entries(cache.answers).map(([userId, answer]) => [
      userId,
      {
        is_correct: answer.isCorrect,
        time_ms: answer.timeMs,
      },
    ])
  );
}

export function buildPlayersPayloadFromCache(cache: MatchCache): Record<string, {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  totalPoints: number;
  foundCount?: number;
  foundAnswerIds?: string[];
  submittedOrderIds?: string[];
  clueIndex?: number | null;
}> {
  const payload: Record<string, {
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    totalPoints: number;
    foundCount?: number;
    foundAnswerIds?: string[];
    submittedOrderIds?: string[];
    clueIndex?: number | null;
  }> = {};

  for (const player of cache.players) {
    const answer = cache.answers[player.userId];
    if (!answer) continue;
    payload[player.userId] = {
      selectedIndex: answer.selectedIndex,
      isCorrect: answer.isCorrect,
      timeMs: answer.timeMs,
      pointsEarned: answer.pointsEarned,
      totalPoints: player.totalPoints,
      foundCount: answer.foundCount,
      foundAnswerIds: answer.foundAnswerIds,
      submittedOrderIds: answer.submittedOrderIds,
      clueIndex: answer.clueIndex ?? null,
    };
  }
  return payload;
}

export function buildCachedAnswerAckPayload(cache: MatchCache, userId: string): MatchAnswerAckPayload | null {
  const question = cache.currentQuestion;
  const answer = cache.answers[userId];
  const player = getCachedPlayer(cache, userId);
  if (!question || !answer || !player) return null;

  const expectedCount = getExpectedUserIds(cache).length;
  const currentAnswerCount = answerCount(cache);
  const shouldWaitForOpponent = expectedCount > 1 && currentAnswerCount < expectedCount;
  const myTotalPoints = answer.questionKind === 'multipleChoice'
    ? player.totalPoints
    : player.totalPoints + answer.pointsEarned;

  return {
    matchId: cache.matchId,
    qIndex: question.qIndex,
    questionKind: answer.questionKind,
    selectedIndex: answer.selectedIndex,
    isCorrect: answer.isCorrect,
    correctIndex: question.kind === 'multipleChoice'
      ? getCachedMultipleChoiceCorrectIndex(question) ?? undefined
      : undefined,
    myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: answer.pointsEarned,
    phaseKind: question.phaseKind,
    phaseRound: question.phaseRound,
    shooterSeat: question.shooterSeat,
    foundCount: answer.foundCount,
    clueIndex: answer.clueIndex,
    submittedOrderIds: answer.submittedOrderIds,
  };
}

export function selectedIndexForAnswerPersistence(
  questionKind: MatchQuestionKind,
  selectedIndex: number | null
): number | null {
  return questionKind === 'multipleChoice' ? selectedIndex : null;
}

export function questionTypeForState(state: PossessionStatePayload): QuestionType {
  if (state.phase === 'NORMAL_PLAY') {
    const slot = state.normalQuestionsAnsweredInHalf % POSSESSION_QUESTIONS_PER_HALF;
    return NORMAL_HALF_SEQUENCE[slot] ?? 'mcq_single';
  }

  return 'mcq_single';
}

export function questionKindForType(type: QuestionType): MatchQuestionKind {
  switch (type) {
    case 'countdown_list':
      return 'countdown';
    case 'put_in_order':
      return 'putInOrder';
    case 'clue_chain':
      return 'clues';
    case 'mcq_single':
    case 'true_false':
    case 'input_text':
    default:
      return 'multipleChoice';
  }
}

export function toCachedPlayers(rows: Array<{
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
}>): CachedPlayer[] {
  return rows.map((row) => ({
    userId: row.user_id,
    seat: row.seat === 2 ? 2 : 1,
    totalPoints: row.total_points,
    correctAnswers: row.correct_answers,
    goals: row.goals,
    penaltyGoals: row.penalty_goals,
    avgTimeMs: row.avg_time_ms,
  }));
}
