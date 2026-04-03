import { logger } from '../core/logger.js';
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
import { questionTimerKey } from './match-keys.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchPhaseKind } from './socket.types.js';
import { clamp, calculatePoints } from './scoring.js';
import {
  QUESTION_TIME_MS,
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
      correctIndex: number;
      optionCount: number;
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
          } | null = null;

          try {
            const fresh = await getMatchCacheOrRebuild(matchId);
            if (!fresh || fresh.status !== 'active') return;
            if (fresh.currentQIndex !== qIndex || !fresh.currentQuestion) return;
            if (hasUserAnswered(fresh, aiUserId)) return;

            const expected = getExpectedUserIds(fresh);
            if (!expected.includes(aiUserId)) return;

            const isCorrect = Math.random() < aiCorrectness;
            const selectedIndex = isCorrect
              ? options.correctIndex
              : pickIncorrectIndex(options.correctIndex, options.optionCount);
            const answerTimeMs = clamp(aiThinkTimeMs, 0, QUESTION_TIME_MS);
            const pointsEarned = calculatePoints(isCorrect, answerTimeMs, QUESTION_TIME_MS);
            const question = fresh.currentQuestion;
            const aiPlayer = getCachedPlayer(fresh, aiUserId);
            if (!aiPlayer) return;

            const answer: CachedAnswer = {
              userId: aiUserId,
              selectedIndex,
              isCorrect,
              timeMs: answerTimeMs,
              pointsEarned,
              phaseKind: question.phaseKind,
              phaseRound: question.phaseRound,
              shooterSeat: question.shooterSeat,
              answeredAt: new Date().toISOString(),
            };

            fresh.answers[aiUserId] = answer;
            aiPlayer.totalPoints += pointsEarned;
            if (isCorrect) aiPlayer.correctAnswers += 1;

            await setMatchCache(fresh);

            committed = {
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
            };
          } finally {
            await releaseLock(lockKey, lock.token);
          }

          if (!committed) return;

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

          if (committed.phaseKind !== 'penalty') {
            io.to(`match:${matchId}`).emit('match:opponent_answered', {
              matchId,
              qIndex,
              opponentTotalPoints: committed.totalPoints,
              pointsEarned: committed.pointsEarned,
              isCorrect: committed.isCorrect,
              selectedIndex: committed.selectedIndex,
            });
          }

          if (committed.answerCount >= committed.expectedCount) {
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
