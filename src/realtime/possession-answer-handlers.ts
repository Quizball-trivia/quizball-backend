import { BadRequestError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { storeService } from '../modules/store/store.service.js';
import {
  answerCount,
  countdownAddFound,
  countdownGetFound,
  getCachedPlayer,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  setMatchCache,
  type CachedAnswer,
  type MatchCache,
} from './match-cache.js';
import {
  fireAndForget,
  resolvePossessionRound,
} from './possession-match-flow.js';
import {
  clueIndexForTimeMs,
  countdownMatch,
  fuzzyMatchesAnswer,
} from './possession-answer-matching.js';
import {
  emitMatchBusy,
  emitRedisUnavailable,
  isRedisAvailable,
  withAnswerLock,
} from './possession-answer-lock.js';
import { buildCachedAnswerAckPayload } from './possession-payload-mappers.js';
import {
  asSeat,
  getQuestionDurationMs,
  TIMING_DISCREPANCY_WARN_MS,
} from './possession-state.js';
import { toAuthoritativeTimeMsFromCache } from './possession-timing.js';
import { getCachedMultipleChoiceCorrectIndex } from './question-compat.js';
import {
  calculateCluesScore,
  calculatePoints,
  calculatePutInOrderScore,
  clamp,
} from './scoring.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type { MatchCluesGuessAckPayload } from './socket.types.js';

function emitChanceCardError(
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    clientActionId: string;
  },
  code: 'CHANCE_CARD_NOT_AVAILABLE' | 'CHANCE_CARD_NOT_ALLOWED' | 'CHANCE_CARD_ALREADY_USED' | 'CHANCE_CARD_SYNC_FAILED',
  message: string
): void {
  socket.emit('error', {
    code,
    message,
    meta: {
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      clientActionId: payload.clientActionId,
    },
  });
}

export async function handlePossessionAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    selectedIndex: number | null;
    timeMs: number;
  }
): Promise<void> {
  if (!isRedisAvailable()) {
    emitRedisUnavailable(socket, 'Match');
    return;
  }

  const { matchId, qIndex, selectedIndex, timeMs } = payload;

  type Committed = {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
  };

  const committed = await withAnswerLock<Committed | null>(matchId, 'answer', () => emitMatchBusy(socket), async () => {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return null;
    if (cache.currentQIndex !== qIndex) return null;
    if (!cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return null;

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return null;

    const question = cache.currentQuestion;
    if (question.phaseKind === 'penalty') {
      const shooterSeat = asSeat(question.shooterSeat);
      const keeperSeat = shooterSeat === 1 ? 2 : 1;
      if (player.seat !== shooterSeat && player.seat !== keeperSeat) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'Only the shooter or keeper can answer this penalty question.',
        });
        return null;
      }
    }

    const existingAnswer = cache.answers[socket.data.user.id];
    if (existingAnswer) {
      const expectedCount = getExpectedUserIds(cache).length;
      const currentAnswerCount = answerCount(cache);
      const shouldWaitForOpponent = expectedCount > 1 && currentAnswerCount < expectedCount;
      socket.emit('match:answer_ack', {
        matchId,
        qIndex,
        questionKind: question.kind,
        selectedIndex: existingAnswer.selectedIndex,
        isCorrect: existingAnswer.isCorrect,
        correctIndex: getCachedMultipleChoiceCorrectIndex(question) ?? undefined,
        myTotalPoints: player.totalPoints,
        oppAnswered: !shouldWaitForOpponent,
        pointsEarned: existingAnswer.pointsEarned,
        phaseKind: question.phaseKind,
        phaseRound: question.phaseRound,
        shooterSeat: question.shooterSeat,
      });
      return null;
    }

    if (question.kind !== 'multipleChoice' || question.evaluation.kind !== 'multipleChoice') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'This question type requires a dedicated answer event.',
      });
      return null;
    }

    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      getQuestionDurationMs(question.kind)
    );
    const clientTimeMs = clamp(timeMs, 0, getQuestionDurationMs(question.kind));
    const diffMs = Math.abs(authoritativeTimeMs - clientTimeMs);
    if (diffMs > TIMING_DISCREPANCY_WARN_MS) {
      logger.warn(
        {
          matchId,
          qIndex,
          userId: socket.data.user.id,
          serverTimeMs: authoritativeTimeMs,
          clientTimeMs,
          diffMs,
        },
        'Match answer timing discrepancy detected'
      );
    }
    const isCorrect = selectedIndex !== null && selectedIndex === question.evaluation.correctIndex;
    const pointsEarned = calculatePoints(isCorrect, authoritativeTimeMs, getQuestionDurationMs(question.kind));

    const answer: CachedAnswer = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
    };

    cache.answers[socket.data.user.id] = answer;
    player.totalPoints += pointsEarned;
    if (isCorrect) player.correctAnswers += 1;

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);

    await setMatchCache(cache);

    return {
      question,
      isCorrect,
      pointsEarned,
      answerTimeMs: authoritativeTimeMs,
      myTotalPoints: player.totalPoints,
      expectedCount,
      answerCount: currentAnswerCount,
    };
  });

  if (!committed) return;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  fireAndForget('insertMatchAnswer(handlePossessionAnswer)', async () => {
    await matchesRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId: socket.data.user.id,
      selectedIndex,
      isCorrect: committed.isCorrect,
      timeMs: committed.answerTimeMs,
      pointsEarned: committed.pointsEarned,
      phaseKind: committed.question.phaseKind,
      phaseRound: committed.question.phaseRound,
      shooterSeat: committed.question.shooterSeat,
    });
  });
  fireAndForget('updatePlayerTotals(handlePossessionAnswer)', async () => {
    await matchesRepo.updatePlayerTotals(
      matchId,
      socket.data.user.id,
      committed.pointsEarned,
      committed.isCorrect
    );
  });

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex,
    isCorrect: committed.isCorrect,
    correctIndex: getCachedMultipleChoiceCorrectIndex(committed.question) ?? undefined,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionCountdownGuess(
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    guess: string;
  }
): Promise<void> {
  if (!isRedisAvailable()) {
    emitRedisUnavailable(socket, 'Countdown');
    return;
  }

  const { matchId, qIndex, guess } = payload;
  const userId = socket.data.user.id;

  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return;
  if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return;

  const player = getCachedPlayer(cache, userId);
  if (!player) return;

  const question = cache.currentQuestion;
  if (question.kind !== 'countdown' || question.evaluation.kind !== 'countdown') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'The active question is not a countdown round.',
    });
    return;
  }

  const alreadyFound = await countdownGetFound(matchId, userId);
  const foundIds = new Set(alreadyFound);

  const matched = countdownMatch(question.evaluation, guess, foundIds);
  if (!matched) {
    socket.emit('match:countdown_guess_ack', {
      matchId,
      qIndex,
      accepted: false,
      duplicate: false,
      foundCount: foundIds.size,
    });
    return;
  }

  const addResult = await countdownAddFound(matchId, userId, matched.id);
  if (!addResult.added) {
    socket.emit('match:countdown_guess_ack', {
      matchId,
      qIndex,
      accepted: false,
      duplicate: true,
      foundCount: addResult.foundCount,
    });
    return;
  }

  socket.emit('match:countdown_guess_ack', {
    matchId,
    qIndex,
    accepted: true,
    duplicate: false,
    foundCount: addResult.foundCount,
    acceptedDisplay: matched.display,
  });
}

export async function handlePossessionPutInOrderAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    orderedItemIds: string[];
    timeMs: number;
  }
): Promise<void> {
  if (!isRedisAvailable()) {
    emitRedisUnavailable(socket, 'Put-in-order');
    return;
  }

  const { matchId, qIndex, orderedItemIds, timeMs } = payload;

  type Committed = {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
    foundCount: number;
  };

  const committed = await withAnswerLock<Committed | null>(matchId, 'put_in_order_answer', () => emitMatchBusy(socket), async () => {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return null;
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return null;

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return null;

    const question = cache.currentQuestion;
    if (question.kind !== 'putInOrder' || question.evaluation.kind !== 'putInOrder') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a put-in-order round.',
      });
      return null;
    }

    const existingAnswer = cache.answers[socket.data.user.id];
    if (existingAnswer) {
      const answerAck = buildCachedAnswerAckPayload(cache, socket.data.user.id);
      if (answerAck) socket.emit('match:answer_ack', answerAck);
      return null;
    }

    const evaluation = question.evaluation;
    const correctOrderIds = [...evaluation.items]
      .sort((left, right) => left.sortValue - right.sortValue)
      .map((item) => item.id);
    const isCorrect = orderedItemIds.length === correctOrderIds.length
      && orderedItemIds.every((itemId, index) => correctOrderIds[index] === itemId);
    const foundCount = orderedItemIds.reduce((count, itemId, index) => (
      correctOrderIds[index] === itemId ? count + 1 : count
    ), 0);

    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      getQuestionDurationMs(question.kind)
    );
    const pointsEarned = calculatePutInOrderScore(foundCount, correctOrderIds.length);

    cache.answers[socket.data.user.id] = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex: null,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
      submittedOrderIds: orderedItemIds,
      foundCount,
    };

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);
    await setMatchCache(cache);

    return {
      question,
      isCorrect,
      pointsEarned,
      answerTimeMs: authoritativeTimeMs,
      myTotalPoints: player.totalPoints + pointsEarned,
      expectedCount,
      answerCount: currentAnswerCount,
      foundCount,
    };
  });

  if (!committed) return;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex: null,
    isCorrect: committed.isCorrect,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
    foundCount: committed.foundCount,
    submittedOrderIds: orderedItemIds,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex: null,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionCluesAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload:
    | {
        kind: 'guess';
        matchId: string;
        qIndex: number;
        guess: string;
        timeMs: number;
      }
    | {
        kind: 'giveUp';
        matchId: string;
        qIndex: number;
        giveUp: true;
        timeMs: number;
      }
): Promise<void> {
  if (!isRedisAvailable()) {
    emitRedisUnavailable(socket, 'Clues');
    return;
  }

  const { matchId, qIndex, timeMs } = payload;
  const giveUp = payload.kind === 'giveUp';
  const guess = payload.kind === 'guess' ? payload.guess : '';

  type Committed = {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    clueIndex: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
  };
  type LockOutcome =
    | { kind: 'committed'; data: Committed }
    | { kind: 'wrongGuess'; ack: MatchCluesGuessAckPayload }
    | { kind: 'noop' };

  const outcome = await withAnswerLock<LockOutcome>(matchId, 'clues_answer', () => emitMatchBusy(socket), async () => {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return { kind: 'noop' };
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return { kind: 'noop' };

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return { kind: 'noop' };

    const question = cache.currentQuestion;
    if (question.kind !== 'clues' || question.evaluation.kind !== 'clues') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a clues round.',
      });
      return { kind: 'noop' };
    }

    const existingAnswer = cache.answers[socket.data.user.id];
    if (existingAnswer) {
      const answerAck = buildCachedAnswerAckPayload(cache, socket.data.user.id);
      if (answerAck) socket.emit('match:answer_ack', answerAck);
      return { kind: 'noop' };
    }

    const questionDurationMs = getQuestionDurationMs(question.kind, question.evaluation.clues.length);
    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      questionDurationMs
    );
    const clueIndex = clueIndexForTimeMs(question.evaluation.clues.length, authoritativeTimeMs, questionDurationMs);
    const isCorrect = !giveUp && fuzzyMatchesAnswer(guess, question.evaluation.acceptedAnswers);
    if (!isCorrect && !giveUp) {
      return {
        kind: 'wrongGuess',
        ack: {
          matchId,
          qIndex,
          clueIndex,
          revealCount: clamp(clueIndex + 2, 1, question.evaluation.clues.length),
        },
      };
    }
    const pointsEarned = calculateCluesScore(isCorrect, clueIndex);

    cache.answers[socket.data.user.id] = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex: null,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
      clueIndex,
    };

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);
    await setMatchCache(cache);

    return {
      kind: 'committed',
      data: {
        question,
        isCorrect,
        pointsEarned,
        answerTimeMs: authoritativeTimeMs,
        clueIndex,
        myTotalPoints: player.totalPoints + pointsEarned,
        expectedCount,
        answerCount: currentAnswerCount,
      },
    };
  });

  if (outcome?.kind === 'wrongGuess') {
    socket.emit('match:clues_guess_ack', outcome.ack);
    return;
  }

  if (outcome?.kind !== 'committed') return;
  const committed = outcome.data;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex: null,
    isCorrect: committed.isCorrect,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
    clueIndex: committed.clueIndex,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex: null,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionChanceCardUse(
  _io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    clientActionId: string;
  }
): Promise<void> {
  await withAnswerLock(
    payload.matchId,
    'chance_card_use',
    () => emitChanceCardError(socket, payload, 'CHANCE_CARD_SYNC_FAILED', '50-50 card is syncing. Please retry.'),
    async () => {
      const cache = await getMatchCacheOrRebuild(payload.matchId);
      if (!cache || cache.status !== 'active') {
        socket.emit('error', {
          code: 'MATCH_NOT_ACTIVE',
          message: 'No active match found for 50-50 card use.',
          meta: {
            matchId: payload.matchId,
            qIndex: payload.qIndex,
            clientActionId: payload.clientActionId,
          },
        });
        return;
      }

      if (cache.mode !== 'ranked') {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_NOT_ALLOWED',
          '50-50 cards are available only in ranked matches.'
        );
        return;
      }

      if (!cache.currentQuestion || cache.currentQuestion.qIndex !== payload.qIndex || cache.currentQIndex !== payload.qIndex) {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_NOT_ALLOWED',
          '50-50 card can only be used for the active question.'
        );
        return;
      }

      if (cache.currentQuestion.phaseKind === 'penalty') {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_NOT_ALLOWED',
          '50-50 card cannot be used during penalty rounds.'
        );
        return;
      }

      const correctIndex = getCachedMultipleChoiceCorrectIndex(cache.currentQuestion);
      const questionKind = cache.currentQuestion.kind ?? (
        Array.isArray((cache.currentQuestion.questionDTO as { options?: unknown[] } | undefined)?.options)
          ? 'multipleChoice'
          : null
      );
      if (questionKind !== 'multipleChoice' || correctIndex === null) {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_NOT_ALLOWED',
          '50-50 card is only available for multiple-choice rounds.'
        );
        return;
      }

      const player = getCachedPlayer(cache, socket.data.user.id);
      if (!player) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'Only match participants can use 50-50 cards.',
          meta: {
            matchId: payload.matchId,
            qIndex: payload.qIndex,
            clientActionId: payload.clientActionId,
          },
        });
        return;
      }

      const usageKey = `${payload.qIndex}:${socket.data.user.id}`;
      const existingUse = cache.chanceCardUses[usageKey];
      if (existingUse) {
        socket.emit('match:chance_card_applied', {
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          clientActionId: existingUse.clientActionId,
          eliminatedIndices: existingUse.eliminatedIndices,
          remainingQuantity: existingUse.remainingQuantity,
        });
        return;
      }

      const optionCount = (
        cache.currentQuestion.questionDTO.kind === 'multipleChoice'
        || Array.isArray((cache.currentQuestion.questionDTO as { options?: unknown[] }).options)
      )
        ? ((cache.currentQuestion.questionDTO as { options?: unknown[] }).options?.length ?? 0)
        : 0;
      const wrongIndices = Array.from({ length: optionCount }, (_, index) => index).filter(
        (index) => index !== correctIndex
      );
      if (wrongIndices.length < 2) {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_SYNC_FAILED',
          '50-50 card could not be applied to this question.'
        );
        return;
      }
      const shuffledWrongIndices = [...wrongIndices];
      for (let index = shuffledWrongIndices.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffledWrongIndices[index], shuffledWrongIndices[swapIndex]] = [
          shuffledWrongIndices[swapIndex],
          shuffledWrongIndices[index],
        ];
      }
      const eliminatedIndices = shuffledWrongIndices.slice(0, 2);

      let remainingQuantity = 0;
      try {
        const consumed = await storeService.consumeChanceCardForMatch({
          userId: socket.data.user.id,
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          clientActionId: payload.clientActionId,
        });
        remainingQuantity = consumed.remainingQuantity;
      } catch (error) {
        if (error instanceof BadRequestError) {
          emitChanceCardError(
            socket,
            payload,
            'CHANCE_CARD_NOT_AVAILABLE',
            'You do not have any 50-50 cards left.'
          );
          return;
        }

        logger.error({ err: error, payload, userId: socket.data.user.id }, 'Failed to consume 50-50 card');
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_SYNC_FAILED',
          'Failed to apply 50-50 card.'
        );
        return;
      }

      cache.chanceCardUses[usageKey] = {
        userId: socket.data.user.id,
        qIndex: payload.qIndex,
        clientActionId: payload.clientActionId,
        eliminatedIndices,
        remainingQuantity,
      };
      await setMatchCache(cache);

      socket.emit('match:chance_card_applied', {
        matchId: payload.matchId,
        qIndex: payload.qIndex,
        clientActionId: payload.clientActionId,
        eliminatedIndices,
        remainingQuantity,
      });
    }
  );
}
