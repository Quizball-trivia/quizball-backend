import { createHash } from 'node:crypto';

import type { CachedAnswer, MatchCache } from './match-cache.js';
import { normalizeAnswer } from './possession-answer-matching.js';

type CachedQuestion = NonNullable<MatchCache['currentQuestion']>;

export function shortHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function answerInputLogFields(value: string): {
  answerLength: number;
  normalizedAnswerLength: number;
  answerHash: string | null;
} {
  const normalized = normalizeAnswer(value);
  return {
    answerLength: value.length,
    normalizedAnswerLength: normalized.length,
    answerHash: shortHash(normalized),
  };
}

export function idListLogFields(prefix: string, values: string[]): Record<string, number | string | null> {
  return {
    [`${prefix}Count`]: values.length,
    [`${prefix}Hash`]: shortHash(values.join('|')),
  };
}

export function questionLogFields(question: CachedQuestion | null | undefined): Record<string, unknown> {
  if (!question) return {};

  return {
    questionId: question.questionId,
    questionKind: question.kind,
    evaluationKind: question.evaluation.kind,
    phaseKind: question.phaseKind,
    phaseRound: question.phaseRound,
    shooterSeat: question.shooterSeat,
    attackerSeat: question.attackerSeat,
    shownAt: question.shownAt,
    deadlineAt: question.deadlineAt,
  };
}

export function answerLogFields(answer: CachedAnswer | null | undefined): Record<string, unknown> {
  if (!answer) return {};

  return {
    answerQuestionKind: answer.questionKind,
    selectedIndex: answer.selectedIndex,
    isCorrect: answer.isCorrect,
    answerTimeMs: answer.timeMs,
    pointsEarned: answer.pointsEarned,
    answerPhaseKind: answer.phaseKind,
    answerPhaseRound: answer.phaseRound,
    foundCount: answer.foundCount,
    submittedOrderCount: answer.submittedOrderIds?.length,
    submittedOrderHash: answer.submittedOrderIds ? shortHash(answer.submittedOrderIds.join('|')) : undefined,
    clueIndex: answer.clueIndex,
  };
}

export function cacheLogFields(cache: MatchCache | null | undefined): Record<string, unknown> {
  if (!cache) return { cacheStatus: 'missing' };

  return {
    cacheStatus: cache.status,
    cacheMode: cache.mode,
    currentQIndex: cache.currentQIndex,
    currentQuestionQIndex: cache.currentQuestion?.qIndex ?? null,
    currentQuestionKind: cache.currentQuestion?.kind ?? null,
    cachedAnswerCount: Object.keys(cache.answers).length,
    expectedUserIds: cache.players.map((player) => player.userId),
    players: cache.players.map((player) => ({
      userId: player.userId,
      seat: player.seat,
      totalPoints: player.totalPoints,
      correctAnswers: player.correctAnswers,
      goals: player.goals,
      penaltyGoals: player.penaltyGoals,
    })),
  };
}
