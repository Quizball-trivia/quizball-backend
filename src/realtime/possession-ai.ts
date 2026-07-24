import { logger } from '../core/logger.js';
import { getRandom } from '../core/rng.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
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
import {
  cancelRealtimeTimer,
  getRealtimeTimerPayload,
  scheduleRealtimeTimer,
} from './realtime-timer-scheduler.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchPhaseKind, MatchQuestionKind } from './socket.types.js';
import { clamp, calculatePoints, calculateCountdownScore, calculatePutInOrderScore, calculateCluesScore } from './scoring.js';
import {
  getQuestionDurationMs,
  getQuestionPreAnswerDelayMs,
  type Seat,
} from './possession-state.js';
import {
  answerLogFields,
  cacheLogFields,
  questionLogFields,
} from './possession-debug-logging.js';

type ResolveRoundFn = (io: QuizballServer, matchId: string, qIndex: number, isTimeout: boolean) => Promise<void>;

const AI_ANSWER_TIMEOUT_BUFFER_MS = 250;
const AI_ANSWER_MIN_RESUME_DELAY_MS = 75;
const AI_DELAY_MIN_MS = 800;
const AI_DELAY_QUESTION_BUFFER_MS = 1500;
const AI_DELAY_FALLBACK_MAX_MS = 9000;
const DEFAULT_AI_DELAY_PROFILE = { minMs: 2000, maxMs: 7000 };

export type AiDelayProfile = {
  minMs: number;
  maxMs: number;
};

type AiSettings = {
  aiCorrectness: number;
  aiDelayProfile: AiDelayProfile | null;
};

type QuestionDifficulty = 'easy' | 'medium' | 'hard';

function normalizedDifficulty(difficulty?: string): QuestionDifficulty {
  if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') {
    return difficulty;
  }
  return 'medium';
}

function difficultyCorrectnessMultiplier(difficulty?: string): number {
  switch (normalizedDifficulty(difficulty)) {
    case 'easy':
      return 1.35;
    case 'hard':
      return 0.65;
    case 'medium':
      return 1;
  }
}

function difficultyDelayMultiplier(difficulty?: string): number {
  switch (normalizedDifficulty(difficulty)) {
    case 'easy':
      return 0.6;
    case 'hard':
      return 1.4;
    case 'medium':
      return 1;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseAiDelayProfile(value: unknown): AiDelayProfile | null {
  const record = asRecord(value);
  if (!record) return null;
  const minMs = record.minMs;
  const maxMs = record.maxMs;
  if (
    typeof minMs !== 'number' ||
    typeof maxMs !== 'number' ||
    !Number.isFinite(minMs) ||
    !Number.isFinite(maxMs) ||
    minMs > maxMs
  ) {
    return null;
  }
  return {
    minMs: Math.round(minMs),
    maxMs: Math.round(maxMs),
  };
}

function aiSettingsFromRankedContext(ctx: unknown): AiSettings {
  const record = asRecord(ctx);
  if (!record) {
    return {
      aiCorrectness: RANKED_AI_CORRECTNESS,
      aiDelayProfile: null,
    };
  }

  const aiCorrectness = typeof record.aiCorrectness === 'number'
    ? record.aiCorrectness
    : RANKED_AI_CORRECTNESS;
  return {
    aiCorrectness,
    aiDelayProfile: parseAiDelayProfile(record.aiDelayProfile),
  };
}

function normalizeAiDelayProfile(profile?: AiDelayProfile | null): AiDelayProfile {
  if (!profile) return DEFAULT_AI_DELAY_PROFILE;
  return {
    minMs: Math.max(0, Math.min(profile.minMs, profile.maxMs)),
    maxMs: Math.max(0, Math.max(profile.minMs, profile.maxMs)),
  };
}

export function difficultyAdjustedCorrectness(base: number, difficulty?: string): number {
  return clamp(base * difficultyCorrectnessMultiplier(difficulty), 0.10, 0.97);
}

export function getAiAnswerDelayMs(options: {
  questionKind?: MatchQuestionKind;
  difficulty?: string;
  delayProfile?: AiDelayProfile | null;
  isCorrect?: boolean;
  questionTimeMs?: number | null;
} = {}): number {
  // Countdown is open-ended typing, so the AI uses a much slower range than other kinds.
  if (options.questionKind === 'countdown') {
    return harnessDelayMs(Math.floor(getRandom() * 10000) + 12000);
  }

  const profile = normalizeAiDelayProfile(options.delayProfile);
  const rangeMs = Math.max(0, profile.maxMs - profile.minMs);
  const baseMs = profile.minMs + Math.floor(getRandom() * (rangeMs + 1));
  const hesitationMultiplier = options.isCorrect === false
    ? 1.3 + getRandom() * 0.3
    : 1;
  const jitterMultiplier = 0.85 + getRandom() * 0.3;
  const rawDelayMs =
    baseMs *
    difficultyDelayMultiplier(options.difficulty) *
    hesitationMultiplier *
    jitterMultiplier;
  const maxDelayMs = typeof options.questionTimeMs === 'number' && Number.isFinite(options.questionTimeMs)
    ? Math.max(AI_DELAY_MIN_MS, options.questionTimeMs - AI_DELAY_QUESTION_BUFFER_MS)
    : AI_DELAY_FALLBACK_MAX_MS;
  return harnessDelayMs(Math.round(clamp(rawDelayMs, AI_DELAY_MIN_MS, maxDelayMs)));
}

function pickIncorrectIndex(correctIndex: number, optionCount: number): number {
  const candidates = Array.from({ length: optionCount }, (_, index) => index).filter(
    (index) => index !== correctIndex
  );
  const picked = candidates[Math.floor(getRandom() * candidates.length)];
  return picked ?? correctIndex;
}

function getAiCountdownFoundCount(totalAnswers: number, aiCorrectness: number): number {
  const cappedAnswers = Math.max(1, totalAnswers);
  const baseline = Math.round(cappedAnswers * aiCorrectness * 0.75);
  const variance = Math.floor(getRandom() * 3) - 1;
  return clamp(baseline + variance, 0, cappedAnswers);
}

function getAiClueIndex(clueCount: number, aiCorrectness: number): number {
  const maxIndex = Math.max(0, clueCount - 1);
  const weighted = Math.round((1 - aiCorrectness) * maxIndex);
  const variance = Math.floor(getRandom() * 2);
  return clamp(weighted + variance, 0, maxIndex);
}

export function createPossessionAi(resolveRound: ResolveRoundFn) {
  const aiUserIdByMatch = new Map<string, string | null>();
  const aiSettingsForMatch = new Map<string, AiSettings>();

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

    const players = await matchPlayersRepo.listMatchPlayers(matchId);
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

  async function resolveAiSettingsForMatch(matchId: string): Promise<AiSettings> {
    const cached = aiSettingsForMatch.get(matchId);
    if (cached) return cached;

    const match = await matchesRepo.getMatch(matchId);
    const settings = aiSettingsFromRankedContext(match?.ranked_context);
    aiSettingsForMatch.set(matchId, settings);
    return settings;
  }

  async function resolveAiCorrectnessForMatch(matchId: string): Promise<number> {
    const settings = await resolveAiSettingsForMatch(matchId);
    return settings.aiCorrectness;
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
    // Reconnect/resume can re-arm the same question. Preserve the original
    // planned outcome instead of drawing a new random result. Read before
    // cancelling: the durable payload may still exist even if its due ZSET
    // member has already been popped by another replica.
    const existingPlan = await getRealtimeTimerPayload('possession_ai_answer', key);
    await cancelRealtimeTimer('possession_ai_answer', key);
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: inactive or missing cache'
      );
      return;
    }
    if (cache.currentQIndex !== qIndex) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: qIndex mismatch'
      );
      return;
    }
    if (!cache.currentQuestion) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: missing current question'
      );
      return;
    }

    const aiUserId = await resolveAiUserIdForMatch(matchId);
    if (!aiUserId) return;

    const hasAi = cache.players.some((player) => player.userId === aiUserId);
    if (!hasAi) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: AI user is not a match player'
      );
      return;
    }

    const expectedUserIds = getExpectedUserIds(cache);
    if (!expectedUserIds.includes(aiUserId)) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, expectedUserIds, ...questionLogFields(cache.currentQuestion) },
        'Possession AI answer schedule skipped: AI user is not expected for this question'
      );
      return;
    }

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
    const aiSettings = await resolveAiSettingsForMatch(matchId);
    const questionDifficulty = cache.currentQuestion.questionDTO.difficulty;
    const aiCorrectness = difficultyAdjustedCorrectness(aiSettings.aiCorrectness, questionDifficulty);
    const plannedIsCorrect = existingPlan?.plannedIsCorrect
      ?? (options.questionKind === 'countdown'
        ? false
        : getRandom() < aiCorrectness);
    const clueCountForDelay = options.questionKind === 'clues' && options.evaluation.kind === 'clues'
      ? options.evaluation.clues.length
      : undefined;
    const plannedClueIndex = existingPlan?.plannedClueIndex
      ?? (typeof clueCountForDelay === 'number'
        ? getAiClueIndex(clueCountForDelay, aiCorrectness)
        : null);
    const questionTimeMsForDelay = hasAuthoritativeWindow
      ? Math.max(0, (deadlineAtMs as number) - (playableAtMs as number))
      : getQuestionDurationMs(options.questionKind, clueCountForDelay);
    const aiThinkTimeMs = getAiAnswerDelayMs({
      questionKind: options.questionKind,
      difficulty: questionDifficulty,
      delayProfile: aiSettings.aiDelayProfile,
      isCorrect: plannedIsCorrect,
      questionTimeMs: questionTimeMsForDelay,
    });
    let plannedAnswerTimeMs = existingPlan
      ? clamp(existingPlan.plannedAnswerTimeMs, 0, questionTimeMsForDelay)
      : plannedClueIndex !== null && clueCountForDelay && clueCountForDelay > 0
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
      plannedIsCorrect,
    });
    logger.info(
      {
        eventName: 'possession_ai_answer',
        matchId,
        qIndex,
        aiUserId,
        questionKind: options.questionKind,
        phaseKind: options.phaseKind,
        phaseRound: options.phaseRound,
        shooterSeat: options.shooterSeat,
        authoritativeWindow: hasAuthoritativeWindow,
        preAnswerDelayMs,
        aiThinkTimeMs,
        aiCorrectness,
        questionDifficulty,
        plannedAnswerTimeMs,
        plannedClueIndex,
        plannedIsCorrect,
        reusedExistingPlan: existingPlan !== null,
        playableAt: hasAuthoritativeWindow ? new Date(playableAtMs as number).toISOString() : null,
        dueAt: new Date(dueAtMs).toISOString(),
        deadlineAt: hasAuthoritativeWindow ? new Date(deadlineAtMs as number).toISOString() : null,
        ...questionLogFields(cache.currentQuestion),
      },
      'Scheduled possession AI answer'
    );
  }

  async function runPossessionAiAnswer(
    io: QuizballServer,
    matchId: string,
    qIndex: number,
    plannedAnswerTimeMs: number,
    plannedClueIndex: number | null,
    plannedIsCorrect?: boolean
  ): Promise<void> {
    try {
      const aiUserId = await resolveAiUserIdForMatch(matchId);
      if (!aiUserId) return;
      logger.info(
        {
          eventName: 'possession_ai_answer',
          matchId,
          qIndex,
          aiUserId,
          plannedAnswerTimeMs,
          plannedClueIndex,
          plannedIsCorrect,
        },
        'Possession AI answer timer fired'
      );

      const lockKey = `lock:match:${matchId}:answer`;
      const lock = await acquireLock(lockKey, 2000);
      if (!lock.acquired || !lock.token) {
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId },
          'Possession AI answer skipped: answer lock busy'
        );
        return;
      }

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
        if (!fresh || fresh.status !== 'active') {
          logger.warn(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh) },
            'Possession AI answer skipped: inactive or missing cache'
          );
          return;
        }
        if (fresh.currentQIndex !== qIndex || !fresh.currentQuestion) {
          logger.warn(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh), ...questionLogFields(fresh.currentQuestion) },
            'Possession AI answer skipped: stale or missing current question'
          );
          return;
        }
        if (hasUserAnswered(fresh, aiUserId)) {
          logger.info(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...questionLogFields(fresh.currentQuestion) },
            'Possession AI answer skipped: AI already answered'
          );
          return;
        }

        const expected = getExpectedUserIds(fresh);
        if (!expected.includes(aiUserId)) {
          logger.warn(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, expectedUserIds: expected, ...questionLogFields(fresh.currentQuestion) },
            'Possession AI answer skipped: AI user is not expected for this question'
          );
          return;
        }

        const question = fresh.currentQuestion;
        const aiPlayer = getCachedPlayer(fresh, aiUserId);
        if (!aiPlayer) {
          logger.warn(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh) },
            'Possession AI answer skipped: AI user is not a match player'
          );
          return;
        }

        const baseAiCorrectness = await resolveAiCorrectnessForMatch(matchId);
        const aiCorrectness = difficultyAdjustedCorrectness(baseAiCorrectness, question.questionDTO.difficulty);
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
          isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
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
          isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
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
          isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
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
        logger.info(
          {
            eventName: 'possession_ai_answer',
            matchId,
            qIndex,
            aiUserId,
            aiCorrectness,
            answerCount: answerCount(fresh),
            expectedCount: expected.length,
            totalPoints: aiPlayer.totalPoints + (question.kind === 'multipleChoice' ? 0 : pointsEarned),
            ...questionLogFields(question),
            ...answerLogFields(answer),
          },
          'Possession AI answer committed'
        );

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
          await matchAnswersRepo.insertMatchAnswerIfMissing({
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
          await matchPlayersRepo.updatePlayerTotals(
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
        logger.info(
          {
            eventName: 'match:opponent_answered',
            matchId,
            qIndex,
            aiUserId,
            questionKind: committed.questionKind,
            isCorrect: committed.isCorrect,
            pointsEarned: committed.pointsEarned,
            selectedIndex: committed.selectedIndex,
          },
          'Possession AI opponent_answered emitted'
        );
      }

      // AI commits all countdown answers at once; drip-feed them so the human sees a typing pace.
      if (committed.questionKind === 'countdown' && committed.foundCount && committed.foundCount > 0) {
        const totalFound = committed.foundCount;
        const emitQIndex = qIndex;
        logger.info(
          {
            eventName: 'match:opponent_countdown_progress',
            matchId,
            qIndex,
            aiUserId,
            totalFound,
          },
          'Possession AI countdown drip scheduled'
        );
        for (let i = 1; i <= totalFound; i += 1) {
          const stepDelay = 600 + Math.floor(getRandom() * 800) + (i - 1) * 250;
          setTimeout(() => {
            void (async () => {
              try {
                // Skip if the round advanced before our timer fired.
                const liveCache = await getMatchCacheOrRebuild(matchId);
                if (!liveCache || liveCache.status !== 'active') return;
                if (liveCache.currentQIndex !== emitQIndex) return;
                io.to(`match:${matchId}`).emit('match:opponent_countdown_progress', {
                  matchId,
                  qIndex: emitQIndex,
                  opponentUserId: aiUserId,
                  foundCount: i,
                });
                logger.info(
                  {
                    eventName: 'match:opponent_countdown_progress',
                    matchId,
                    qIndex: emitQIndex,
                    aiUserId,
                    foundCount: i,
                    totalFound,
                  },
                  'Possession AI countdown progress emitted'
                );
              } catch (error) {
                logger.warn({ error, matchId, qIndex: emitQIndex }, 'AI countdown drip emit failed');
              }
            })();
          }, stepDelay);
        }
      }

      if (committed.questionKind !== 'countdown' && committed.answerCount >= committed.expectedCount) {
        logger.info(
          {
            eventName: 'match:round_result',
            matchId,
            qIndex,
            aiUserId,
            answerCount: committed.answerCount,
            expectedCount: committed.expectedCount,
            questionKind: committed.questionKind,
          },
          'Possession AI answer triggering round resolve'
        );
        await resolveRound(io, matchId, qIndex, false);
      }
    } catch (error) {
      logger.warn({ error, eventName: 'possession_ai_answer', matchId, qIndex }, 'Possession AI answer failed');
    }
  }

  function clearAiMaps(matchId: string): void {
    aiUserIdByMatch.delete(matchId);
    aiSettingsForMatch.delete(matchId);
  }

  function clearAllAiMaps(): void {
    aiUserIdByMatch.clear();
    aiSettingsForMatch.clear();
  }

  return {
    resolveAiUserIdForMatch,
    resolveAiCorrectnessForMatch,
    schedulePossessionAiAnswer,
    runPossessionAiAnswer,
    clearAiAnswerTimer,
    clearAiMaps,
    clearAllAiMaps,
  };
}
