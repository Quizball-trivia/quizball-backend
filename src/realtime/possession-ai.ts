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
import { cancelRealtimeTimer, scheduleRealtimeTimer } from './realtime-timer-scheduler.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchPhaseKind, MatchQuestionKind } from './socket.types.js';
import { clamp, calculatePoints, calculateCountdownScore, calculatePutInOrderScore, calculateCluesScore } from './scoring.js';
import {
  getQuestionDurationMs,
  getQuestionPreAnswerDelayMs,
  type Seat,
} from './possession-state.js';

type ResolveRoundFn = (io: QuizballServer, matchId: string, qIndex: number, isTimeout: boolean) => Promise<void>;

const AI_ANSWER_TIMEOUT_BUFFER_MS = 250;
const AI_ANSWER_MIN_RESUME_DELAY_MS = 75;

function getAiAnswerDelayMs(questionKind?: string): number {
  // AI "thinking" time after the question becomes playable.
  // Countdown questions are open-ended (the player has to think of and
  // type N football player names from memory) — humans typically need
  // 10-25s, so the AI uses a slower range to feel realistic. Other
  // question kinds (multipleChoice, clues, putInOrder) keep the snappier
  // 2-7s range that mirrors a confident player.
  if (questionKind === 'countdown') {
    // 12-22s window — leaves room for the human to think and type.
    return Math.floor(Math.random() * 10000) + 12000;
  }
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
    void cancelRealtimeTimer('possession_ai_answer', key).catch((error) => {
      logger.warn({ error, matchId, qIndex }, 'Failed to cancel possession AI answer timer');
    });
  }

  async function schedulePossessionAiAnswer(
    _io: QuizballServer,
    matchId: string,
    qIndex: number,
    options: {
      questionKind: MatchQuestionKind;
      evaluation: MatchQuestionEvaluation;
      phaseKind: MatchPhaseKind;
      phaseRound: number;
      shooterSeat: Seat | null;
      playableAt?: Date;
      deadlineAt?: Date;
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

    const nowMs = Date.now();
    const playableAtMs = options.playableAt?.getTime();
    const deadlineAtMs = options.deadlineAt?.getTime();
    const hasAuthoritativeWindow =
      Number.isFinite(playableAtMs) &&
      Number.isFinite(deadlineAtMs) &&
      (deadlineAtMs as number) > (playableAtMs as number);
    const preAnswerDelayMs = hasAuthoritativeWindow
      ? Math.max(0, (playableAtMs as number) - nowMs)
      : getQuestionPreAnswerDelayMs({
          qIndex,
          state: cache.statePayload,
        });
    const aiCorrectness = await resolveAiCorrectnessForMatch(matchId);
    const aiThinkTimeMs = getAiAnswerDelayMs(options.questionKind);
    const clueCountForDelay = options.questionKind === 'clues' && options.evaluation.kind === 'clues'
      ? options.evaluation.clues.length
      : undefined;
    const plannedClueIndex = typeof clueCountForDelay === 'number'
      ? getAiClueIndex(clueCountForDelay, aiCorrectness)
      : null;
    const questionTimeMsForDelay = hasAuthoritativeWindow
      ? Math.max(0, (deadlineAtMs as number) - (playableAtMs as number))
      : getQuestionDurationMs(options.questionKind, clueCountForDelay);
    let plannedAnswerTimeMs = plannedClueIndex !== null && clueCountForDelay && clueCountForDelay > 0
      ? (() => {
          const clueSliceMs = questionTimeMsForDelay / clueCountForDelay;
          return clamp(
            Math.round(clueSliceMs * plannedClueIndex + Math.min(clueSliceMs - 250, aiThinkTimeMs)),
            0,
            questionTimeMsForDelay
          );
        })()
      : clamp(aiThinkTimeMs, 0, questionTimeMsForDelay);
    let dueAtMs = nowMs + preAnswerDelayMs + plannedAnswerTimeMs;
    if (hasAuthoritativeWindow) {
      const latestDueAtMs = Math.max(nowMs + AI_ANSWER_MIN_RESUME_DELAY_MS, (deadlineAtMs as number) - AI_ANSWER_TIMEOUT_BUFFER_MS);
      if (dueAtMs > latestDueAtMs) {
        dueAtMs = latestDueAtMs;
        plannedAnswerTimeMs = clamp(dueAtMs - nowMs - preAnswerDelayMs, 0, questionTimeMsForDelay);
      }
    }
    await scheduleRealtimeTimer('possession_ai_answer', key, new Date(dueAtMs), {
      kind: 'possession_ai_answer',
      matchId,
      qIndex,
      plannedAnswerTimeMs,
      plannedClueIndex,
    });
    logger.debug(
      {
        matchId,
        qIndex,
        questionKind: options.questionKind,
        authoritativeWindow: hasAuthoritativeWindow,
        preAnswerDelayMs,
        plannedAnswerTimeMs,
        dueAt: new Date(dueAtMs).toISOString(),
        deadlineAt: hasAuthoritativeWindow ? new Date(deadlineAtMs as number).toISOString() : null,
      },
      'Scheduled possession AI answer'
    );
  }

  async function runPossessionAiAnswer(
    io: QuizballServer,
    matchId: string,
    qIndex: number,
    plannedAnswerTimeMs: number,
    plannedClueIndex: number | null
  ): Promise<void> {
    try {
      const aiUserId = await resolveAiUserIdForMatch(matchId);
      if (!aiUserId) return;

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
        submittedOrderIds?: string[];
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

        const aiCorrectness = await resolveAiCorrectnessForMatch(matchId);
        const clueCountForDuration = question.kind === 'clues' && question.evaluation.kind === 'clues'
          ? question.evaluation.clues.length
          : undefined;
        const questionTimeMs = getQuestionDurationMs(question.kind, clueCountForDuration);
        const answerTimeMs = clamp(plannedAnswerTimeMs, 0, questionTimeMs);
        let isCorrect = false;
        let selectedIndex: number | null = null;
        let pointsEarned = 0;
        let foundCount: number | undefined;
        let foundAnswerIds: string[] | undefined;
        let submittedOrderIds: string[] | undefined;
        let clueIndex: number | null | undefined;

        if (question.kind === 'multipleChoice' && question.evaluation.kind === 'multipleChoice') {
          const optionCount = question.questionDTO.kind === 'multipleChoice'
            ? question.questionDTO.options.length
            : 4;
          isCorrect = Math.random() < aiCorrectness;
          selectedIndex = isCorrect
            ? question.evaluation.correctIndex
            : pickIncorrectIndex(question.evaluation.correctIndex, optionCount);
          pointsEarned = calculatePoints(isCorrect, answerTimeMs, questionTimeMs);
        } else if (question.kind === 'countdown' && question.evaluation.kind === 'countdown') {
          const totalGroups = question.evaluation.answerGroups.length;
          foundCount = getAiCountdownFoundCount(totalGroups, aiCorrectness);
          foundAnswerIds = question.evaluation.answerGroups.slice(0, foundCount).map((group) => group.id);
          selectedIndex = foundCount;
          pointsEarned = calculateCountdownScore(foundCount, totalGroups);
          isCorrect = false;
        } else if (question.kind === 'putInOrder' && question.evaluation.kind === 'putInOrder') {
          const correctOrderIds = [...question.evaluation.items]
            .sort((left, right) => left.sortValue - right.sortValue)
            .map((item) => item.id);
          isCorrect = Math.random() < aiCorrectness;
          selectedIndex = null;
          // Wrong-answer scoring for put-in-order: scale `aiCorrectness`
          // by 0.55 so an AI that "would have" got the question right
          // (aiCorrectness=1.0) still places ~55% of items in the correct
          // prefix on a miss — partial credit that feels reasonable
          // without making wrong answers nearly as rewarding as right
          // ones. Mirrors the 0.75 factor used for countdown questions.
          foundCount = isCorrect
            ? question.evaluation.items.length
            : Math.min(
              question.evaluation.items.length - 1,
              Math.max(0, Math.round(question.evaluation.items.length * aiCorrectness * 0.55))
            );
          submittedOrderIds = [...correctOrderIds];
          if (!isCorrect && submittedOrderIds.length > 1) {
            const fixedPrefix = submittedOrderIds.slice(0, foundCount);
            const shuffledTail = submittedOrderIds.slice(foundCount).reverse();
            submittedOrderIds = [...fixedPrefix, ...shuffledTail];
          }
          pointsEarned = calculatePutInOrderScore(foundCount, correctOrderIds.length);
        } else if (question.kind === 'clues' && question.evaluation.kind === 'clues') {
          isCorrect = Math.random() < aiCorrectness;
          clueIndex = plannedClueIndex ?? getAiClueIndex(question.evaluation.clues.length, aiCorrectness);
          selectedIndex = null;
          pointsEarned = calculateCluesScore(isCorrect, clueIndex);
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
          submittedOrderIds,
          clueIndex,
        };

        fresh.answers[aiUserId] = answer;
        if (question.kind === 'multipleChoice') {
          aiPlayer.totalPoints += pointsEarned;
          if (isCorrect) aiPlayer.correctAnswers += 1;
        }

        if (question.kind === 'countdown' && foundAnswerIds && foundAnswerIds.length > 0) {
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
          totalPoints: aiPlayer.totalPoints + (question.kind === 'multipleChoice' ? 0 : pointsEarned),
          phaseKind: question.phaseKind,
          phaseRound: question.phaseRound,
          shooterSeat: question.shooterSeat,
          answerCount: answerCount(fresh),
          expectedCount: expected.length,
          foundCount,
          foundAnswerIds,
          submittedOrderIds,
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

      // For countdown the AI commits all found answers atomically, but to
      // the human opponent it should feel like the AI is "typing" them in
      // one at a time. Drip-feed `match:opponent_countdown_progress`
      // events with staggered delays so the live counter ticks up.
      if (committed.questionKind === 'countdown' && committed.foundCount && committed.foundCount > 0) {
        const totalFound = committed.foundCount;
        for (let i = 1; i <= totalFound; i += 1) {
          const stepDelay = 600 + Math.floor(Math.random() * 800) + (i - 1) * 250;
          setTimeout(() => {
            io.to(`match:${matchId}`).emit('match:opponent_countdown_progress', {
              matchId,
              qIndex,
              opponentUserId: aiUserId,
              foundCount: i,
            });
          }, stepDelay);
        }
      }

      if (committed.questionKind !== 'countdown' && committed.answerCount >= committed.expectedCount) {
        await resolveRound(io, matchId, qIndex, false);
      }
    } catch (error) {
      logger.warn({ error, matchId, qIndex }, 'Possession AI answer failed');
    }
  }

  function clearAiMaps(matchId: string): void {
    aiUserIdByMatch.delete(matchId);
    aiCorrectnessForMatch.delete(matchId);
  }

  return {
    resolveAiUserIdForMatch,
    resolveAiCorrectnessForMatch,
    schedulePossessionAiAnswer,
    runPossessionAiAnswer,
    clearAiAnswerTimer,
    clearAiMaps,
  };
}
