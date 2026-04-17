import { logger } from '../core/logger.js';
import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { usersRepo } from '../modules/users/users.repo.js';
import { acquireLock, releaseLock } from './locks.js';
import { RANKED_AI_CORRECTNESS, rankedAiMatchKey } from './ai-ranked.constants.js';
import {
  answerCount,
  getCachedPlayer,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  hasUserAnswered,
  setMatchCache,
  type CachedAnswer,
} from './match-cache.js';
import { getRedisClient } from './redis.js';
import { questionTimerKey, countdownPlayerKey } from './match-keys.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchPhaseKind, MatchQuestionKind } from './socket.types.js';
import { clamp, calculatePoints, calculateCountdownScore } from './scoring.js';
import {
  getQuestionDurationMs,
  getQuestionPreAnswerDelayMs,
  type Seat,
} from './possession-state.js';

type ResolveRoundFn = (io: QuizballServer, matchId: string, qIndex: number, isTimeout: boolean) => Promise<void>;

function getAiAnswerDelayMs(): number {
  // AI "thinking" time after options become visible to players.
  // Range: 2–7s => 80..30 points on correct answers.
  return Math.floor(Math.random() * 5000) + 2000;
}

function pickIncorrectIndex(correctIndex: number, optionCount: number): number {
  const candidates = Array.from({ length: optionCount }, (_, index) => index).filter(
    (index) => index !== correctIndex
  );
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  return picked ?? correctIndex;
}

function getAiCountdownFoundCount(totalAnswers: number, aiCorrectness: number): number {
  const cappedAnswers = Math.max(1, totalAnswers);
  const baseline = Math.round(cappedAnswers * aiCorrectness * 0.75);
  const variance = Math.floor(Math.random() * 3) - 1;
  return clamp(baseline + variance, 0, cappedAnswers);
}

function getAiClueIndex(clueCount: number, aiCorrectness: number): number {
  const maxIndex = Math.max(0, clueCount - 1);
  const weighted = Math.round((1 - aiCorrectness) * maxIndex);
  const variance = Math.floor(Math.random() * 2);
  return clamp(weighted + variance, 0, maxIndex);
}

export function createPossessionAi(resolveRound: ResolveRoundFn) {
  const aiUserIdByMatch = new Map<string, string | null>();
  const aiCorrectnessForMatch = new Map<string, number>();
  const aiAnswerTimers = new Map<string, NodeJS.Timeout>();

  function fireAndForget(label: string, fn: () => Promise<unknown>): void {
    fn().catch((error) => {
      logger.error({ error, label }, 'Fire-and-forget DB write failed');
    });
  }

  async function resolveAiUserIdForMatch(matchId: string): Promise<string | null> {
    if (aiUserIdByMatch.has(matchId)) {
      return aiUserIdByMatch.get(matchId) ?? null;
    }

    const redis = getRedisClient();
    if (redis) {
      const aiUserId = await redis.get(rankedAiMatchKey(matchId));
      if (aiUserId) {
        aiUserIdByMatch.set(matchId, aiUserId);
        return aiUserId;
      }
    }

    const players = await matchesRepo.listMatchPlayers(matchId);
    for (const player of players) {
      const user = await usersRepo.getById(player.user_id);
      if (user?.is_ai) {
        aiUserIdByMatch.set(matchId, user.id);
        return user.id;
      }
    }

    aiUserIdByMatch.set(matchId, null);
    return null;
  }

  async function resolveAiCorrectnessForMatch(matchId: string): Promise<number> {
    const cached = aiCorrectnessForMatch.get(matchId);
    if (cached !== undefined) return cached;

    const match = await matchesRepo.getMatch(matchId);
    const ctx = match?.ranked_context;
    if (ctx && typeof ctx === 'object' && 'aiCorrectness' in ctx) {
      const val = (ctx as { aiCorrectness?: unknown }).aiCorrectness;
      if (typeof val === 'number') {
        aiCorrectnessForMatch.set(matchId, val);
        return val;
      }
    }

    aiCorrectnessForMatch.set(matchId, RANKED_AI_CORRECTNESS);
    return RANKED_AI_CORRECTNESS;
  }

  function clearAiAnswerTimer(matchId: string, qIndex: number): void {
    const key = questionTimerKey(matchId, qIndex);
    const timer = aiAnswerTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    aiAnswerTimers.delete(key);
  }

  async function schedulePossessionAiAnswer(
    io: QuizballServer,
    matchId: string,
    qIndex: number,
    options: {
      questionKind: MatchQuestionKind;
      evaluation: MatchQuestionEvaluation;
      phaseKind: MatchPhaseKind;
      phaseRound: number;
      shooterSeat: Seat | null;
    }
  ): Promise<void> {
    const key = questionTimerKey(matchId, qIndex);
    clearAiAnswerTimer(matchId, qIndex);
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    if (cache.currentQIndex !== qIndex) return;
    if (!cache.currentQuestion) return;

    const aiUserId = await resolveAiUserIdForMatch(matchId);
    if (!aiUserId) return;

    const hasAi = cache.players.some((player) => player.userId === aiUserId);
    if (!hasAi) return;

    const expectedUserIds = getExpectedUserIds(cache);
    if (!expectedUserIds.includes(aiUserId)) return;

    const aiThinkTimeMs = getAiAnswerDelayMs();
    const preAnswerDelayMs = getQuestionPreAnswerDelayMs({
      qIndex,
      state: cache.statePayload,
    });
    const delayMs = preAnswerDelayMs + aiThinkTimeMs;
    const aiCorrectness = await resolveAiCorrectnessForMatch(matchId);
    const timeout = setTimeout(() => {
      const stored = aiAnswerTimers.get(key);
      if (stored) {
        clearTimeout(stored);
        aiAnswerTimers.delete(key);
      }

      void (async () => {
        try {
          const lockKey = `lock:match:${matchId}:answer`;
          const lock = await acquireLock(lockKey, 2000);
          if (!lock.acquired || !lock.token) return;

          let committed: {
            questionKind: MatchQuestionKind;
            selectedIndex: number | null;
            isCorrect: boolean;
            answerTimeMs: number;
            pointsEarned: number;
            totalPoints: number;
            phaseKind: MatchPhaseKind;
            phaseRound: number | null;
            shooterSeat: Seat | null;
            answerCount: number;
            expectedCount: number;
            foundCount?: number;
            foundAnswerIds?: string[];
            clueIndex?: number | null;
          } | null = null;

          try {
            const fresh = await getMatchCacheOrRebuild(matchId);
            if (!fresh || fresh.status !== 'active') return;
            if (fresh.currentQIndex !== qIndex || !fresh.currentQuestion) return;
            if (hasUserAnswered(fresh, aiUserId)) return;

            const expected = getExpectedUserIds(fresh);
            if (!expected.includes(aiUserId)) return;

            const question = fresh.currentQuestion;
            const aiPlayer = getCachedPlayer(fresh, aiUserId);
            if (!aiPlayer) return;

            const clueCountForDuration = options.questionKind === 'clues' && options.evaluation.kind === 'clues'
              ? options.evaluation.clues.length
              : undefined;
            const questionTimeMs = getQuestionDurationMs(options.questionKind, clueCountForDuration);
            let answerTimeMs = clamp(aiThinkTimeMs, 0, questionTimeMs);
            let isCorrect = false;
            let selectedIndex: number | null = null;
            let pointsEarned = 0;
            let foundCount: number | undefined;
            let foundAnswerIds: string[] | undefined;
            let clueIndex: number | null | undefined;

            if (options.questionKind === 'multipleChoice' && options.evaluation.kind === 'multipleChoice') {
              const optionCount = question.questionDTO.kind === 'multipleChoice'
                ? question.questionDTO.options.length
                : 4;
              isCorrect = Math.random() < aiCorrectness;
              selectedIndex = isCorrect
                ? options.evaluation.correctIndex
                : pickIncorrectIndex(options.evaluation.correctIndex, optionCount);
              pointsEarned = calculatePoints(isCorrect, answerTimeMs, questionTimeMs);
            } else if (options.questionKind === 'countdown' && options.evaluation.kind === 'countdown') {
              const totalGroups = options.evaluation.answerGroups.length;
              foundCount = getAiCountdownFoundCount(totalGroups, aiCorrectness);
              foundAnswerIds = options.evaluation.answerGroups.slice(0, foundCount).map((group) => group.id);
              selectedIndex = foundCount;
              pointsEarned = calculateCountdownScore(foundCount, totalGroups);
              isCorrect = false;
            } else if (options.questionKind === 'putInOrder' && options.evaluation.kind === 'putInOrder') {
              isCorrect = Math.random() < aiCorrectness;
              selectedIndex = null;
              pointsEarned = isCorrect ? calculatePoints(true, answerTimeMs, questionTimeMs) : 0;
            } else if (options.questionKind === 'clues' && options.evaluation.kind === 'clues') {
              isCorrect = Math.random() < aiCorrectness;
              clueIndex = getAiClueIndex(options.evaluation.clues.length, aiCorrectness);
              selectedIndex = null;
              if (options.evaluation.clues.length > 0) {
                const clueSliceMs = questionTimeMs / options.evaluation.clues.length;
                answerTimeMs = clamp(
                  Math.round(clueSliceMs * clueIndex + Math.min(clueSliceMs - 250, aiThinkTimeMs)),
                  0,
                  questionTimeMs
                );
              }
              pointsEarned = isCorrect ? [200, 150, 100, 50, 25][clueIndex] ?? 25 : 0;
            }

            const answer: CachedAnswer = {
              userId: aiUserId,
              questionKind: question.kind,
              selectedIndex,
              isCorrect,
              timeMs: answerTimeMs,
              pointsEarned,
              phaseKind: question.phaseKind,
              phaseRound: question.phaseRound,
              shooterSeat: question.shooterSeat,
              answeredAt: new Date().toISOString(),
              foundCount,
              foundAnswerIds,
              clueIndex,
            };

            fresh.answers[aiUserId] = answer;
            if (options.questionKind === 'multipleChoice') {
              aiPlayer.totalPoints += pointsEarned;
              if (isCorrect) aiPlayer.correctAnswers += 1;
            }

            // Write AI countdown found answers to per-player Redis Set
            // so resolution can merge them alongside the human player's Set.
            if (options.questionKind === 'countdown' && foundAnswerIds && foundAnswerIds.length > 0) {
              const redisClient = getRedisClient();
              if (redisClient?.isOpen) {
                const countdownKey = countdownPlayerKey(matchId, aiUserId);
                await redisClient.sAdd(countdownKey, foundAnswerIds);
                await redisClient.expire(countdownKey, 120);
              }
            }

            await setMatchCache(fresh);

            committed = {
              questionKind: question.kind,
              selectedIndex,
              isCorrect,
              answerTimeMs,
              pointsEarned,
              totalPoints: aiPlayer.totalPoints,
              phaseKind: question.phaseKind,
              phaseRound: question.phaseRound,
              shooterSeat: question.shooterSeat,
              answerCount: answerCount(fresh),
              expectedCount: expected.length,
              foundCount,
              foundAnswerIds,
              clueIndex,
            };
          } finally {
            await releaseLock(lockKey, lock.token);
          }

          if (!committed) return;

          if (committed.questionKind === 'multipleChoice') {
            fireAndForget('insertMatchAnswer(ai)', async () => {
              await matchesRepo.insertMatchAnswerIfMissing({
                matchId,
                qIndex,
                userId: aiUserId,
                selectedIndex: committed.selectedIndex,
                isCorrect: committed.isCorrect,
                timeMs: committed.answerTimeMs,
                pointsEarned: committed.pointsEarned,
                phaseKind: committed.phaseKind,
                phaseRound: committed.phaseRound,
                shooterSeat: committed.shooterSeat,
              });
            });

            fireAndForget('updatePlayerTotals(ai)', async () => {
              await matchesRepo.updatePlayerTotals(
                matchId,
                aiUserId,
                committed.pointsEarned,
                committed.isCorrect
              );
            });
          }

          if (committed.phaseKind !== 'penalty' && committed.questionKind !== 'countdown') {
            io.to(`match:${matchId}`).emit('match:opponent_answered', {
              matchId,
              qIndex,
              questionKind: committed.questionKind,
              opponentTotalPoints: committed.totalPoints,
              pointsEarned: committed.pointsEarned,
              isCorrect: committed.isCorrect,
              selectedIndex: committed.selectedIndex,
            });
          }

          if (committed.questionKind !== 'countdown' && committed.answerCount >= committed.expectedCount) {
            await resolveRound(io, matchId, qIndex, false);
          }
        } catch (error) {
          logger.warn({ error, matchId, qIndex }, 'Possession AI answer scheduling failed');
        }
      })();
    }, delayMs);

    aiAnswerTimers.set(key, timeout);
  }

  function clearAiMaps(matchId: string): void {
    aiUserIdByMatch.delete(matchId);
    aiCorrectnessForMatch.delete(matchId);
  }

  return {
    resolveAiUserIdForMatch,
    resolveAiCorrectnessForMatch,
    schedulePossessionAiAnswer,
    clearAiAnswerTimer,
    clearAiMaps,
  };
}
