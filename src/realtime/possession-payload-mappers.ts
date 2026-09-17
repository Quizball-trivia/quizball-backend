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
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import type { MatchAnswerAckPayload, MatchQuestionKind } from './socket.types.js';

const NORMAL_HALF_SEQUENCE: QuestionType[] = [
  'mcq_single',
  'mcq_single',
  'mcq_single',
  'mcq_single',
  'put_in_order',
  'clue_chain',
];
const MCQ_ONLY_HALF_SEQUENCE: QuestionType[] = NORMAL_HALF_SEQUENCE.map(() => 'mcq_single');

/** Season 3 (POSSESSION_MCQ_ONLY): every slot is an MCQ; the specials moved to the daily challenges. */
export function normalHalfSequence(): QuestionType[] {
  return config.POSSESSION_MCQ_ONLY ? MCQ_ONLY_HALF_SEQUENCE : NORMAL_HALF_SEQUENCE;
}

export function getUserIdByCachedSeat(players: CachedPlayer[], seat: CachedSeat): string | null {
  return players.find((player) => player.seat === seat)?.userId ?? null;
}

export function toCachedAnswerByUserId(
  cache: MatchCache
): Map<string, { is_correct: boolean; time_ms: number; points_earned: number }> {
  return new Map(
    Object.entries(cache.answers).map(([userId, answer]) => [
      userId,
      {
        is_correct: answer.isCorrect,
        time_ms: answer.timeMs,
        points_earned: answer.pointsEarned,
      },
    ])
  );
}

export function buildPlayersPayloadFromCache(cache: MatchCache): Record<string, {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  possessionPointsEarned?: number;
  totalPoints: number;
  foundCount?: number;
  foundAnswerIds?: string[];
  submittedOrderIds: string[];
  clueIndex?: number | null;
}> {
  const payload: Record<string, {
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    possessionPointsEarned?: number;
    totalPoints: number;
    foundCount?: number;
    foundAnswerIds?: string[];
    submittedOrderIds: string[];
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
      possessionPointsEarned: answer.pointsEarned,
      totalPoints: player.totalPoints,
      foundCount: answer.foundCount,
      foundAnswerIds: answer.foundAnswerIds,
      submittedOrderIds: answer.submittedOrderIds ?? [],
      clueIndex: answer.clueIndex ?? null,
    };
  }
  return payload;
}

export type OpponentAnswerAckFields = Pick<
  MatchAnswerAckPayload,
  'opponentPointsEarned' | 'opponentTotalPoints' | 'opponentIsCorrect' | 'opponentSelectedIndex'
>;

/**
 * Outcome of resolving the match's AI player for ack suppression: the AI's
 * user id (null when the match has no AI), or 'unknown' when the lookup
 * failed — which fails closed: the opponent fields are omitted (the pre-fix
 * ack shape) rather than risking a leak or failing the answer.
 */
export type AiOpponentLookup = { aiUserId: string | null } | 'unknown';

export async function lookupAiOpponent(
  matchId: string,
  resolve: (matchId: string) => Promise<string | null>
): Promise<AiOpponentLookup> {
  try {
    return { aiUserId: await resolve(matchId) };
  } catch (error) {
    logger.warn({ error, matchId }, 'AI opponent lookup failed; omitting opponent fields from answer ack');
    return 'unknown';
  }
}

export interface OpponentAnswerSnapshot {
  opponentUserId: string;
  /** The bot keeps its countdown answer hidden until the round result (it broadcasts every other kind, penalties included). */
  hiddenWhenAi: boolean;
  fields: OpponentAnswerAckFields;
}

/**
 * The opponent's committed result for the current round, captured under the
 * round lock (pure, no I/O). `opponentTotalPoints` mirrors the opponent's own
 * `myTotalPoints` at commit (what `match:opponent_answered` sends): MCQ
 * commits bump the cached total in place, the other kinds add the round
 * points on top at reveal. Undefined until the opponent has answered.
 */
export function snapshotOpponentAnswer(cache: MatchCache, userId: string): OpponentAnswerSnapshot | undefined {
  const opponentUserId = getExpectedUserIds(cache).find((candidate) => candidate !== userId);
  if (!opponentUserId) return undefined;
  const answer = cache.answers[opponentUserId];
  const opponent = getCachedPlayer(cache, opponentUserId);
  if (!answer || !opponent) return undefined;
  return {
    opponentUserId,
    hiddenWhenAi: answer.questionKind === 'countdown',
    fields: {
      opponentPointsEarned: answer.pointsEarned,
      opponentTotalPoints: answer.questionKind === 'multipleChoice'
        ? opponent.totalPoints
        : opponent.totalPoints + answer.pointsEarned,
      opponentIsCorrect: answer.isCorrect,
      opponentSelectedIndex: answer.selectedIndex,
    },
  };
}

/**
 * Turn a snapshot into ack fields once the AI lookup is in (after the commit,
 * so the lookup is never on the answer-timing path). Never reveals more than
 * `match:opponent_answered` would have broadcast: the bot hides only its
 * countdown answer until the round result (possession-ai.ts) — it broadcasts
 * every other kind, penalties included, exactly like a human — so an AI
 * opponent's fields are omitted only there.
 */
export function opponentAnswerAckFields(
  snapshot: OpponentAnswerSnapshot | undefined,
  lookup: AiOpponentLookup
): OpponentAnswerAckFields | undefined {
  if (!snapshot || lookup === 'unknown') return undefined;
  if (snapshot.hiddenWhenAi && lookup.aiUserId !== null && snapshot.opponentUserId === lookup.aiUserId) {
    return undefined;
  }
  return snapshot.fields;
}

export function buildOpponentAnswerAckFields(
  cache: MatchCache,
  userId: string,
  lookup: AiOpponentLookup
): OpponentAnswerAckFields | undefined {
  return opponentAnswerAckFields(snapshotOpponentAnswer(cache, userId), lookup);
}

export function buildCachedAnswerAckPayload(
  cache: MatchCache,
  userId: string,
  aiOpponent: AiOpponentLookup
): MatchAnswerAckPayload | null {
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
    ...buildOpponentAnswerAckFields(cache, userId, aiOpponent),
    pointsEarned: answer.pointsEarned,
    phaseKind: question.phaseKind,
    phaseRound: question.phaseRound,
    shooterSeat: question.shooterSeat,
    foundCount: answer.foundCount,
    clueIndex: answer.clueIndex,
    cluesDisplayAnswer: question.kind === 'clues' && question.reveal.kind === 'clues'
      ? question.reveal.displayAnswer
      : undefined,
    submittedOrderIds: answer.questionKind === 'putInOrder' ? (answer.submittedOrderIds ?? []) : answer.submittedOrderIds,
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
    return normalHalfSequence()[slot] ?? 'mcq_single';
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
