import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  answerCount,
  buildAnswerPayload,
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
  clueIndexForScoring,
  calculateCluesScore,
  calculatePoints,
  calculatePutInOrderScore,
  clamp,
} from './scoring.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type { MatchCluesGuessAckPayload } from './socket.types.js';

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

  fireAndForget('insertMatchAnswer(handlePossessionPutInOrderAnswer)', async () => {
    await matchesRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId: socket.data.user.id,
      selectedIndex: null,
      isCorrect: committed.isCorrect,
      timeMs: committed.answerTimeMs,
      pointsEarned: committed.pointsEarned,
      answerPayload: buildAnswerPayload({
        questionKind: committed.question.kind,
        foundCount: committed.foundCount,
        submittedOrderIds: orderedItemIds,
      }),
      phaseKind: committed.question.phaseKind,
      phaseRound: committed.question.phaseRound,
      shooterSeat: committed.question.shooterSeat,
    });
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
    const timedClueIndex = clueIndexForTimeMs(question.evaluation.clues.length, authoritativeTimeMs, questionDurationMs);
    const existingRevealCount = cache.clueReveals?.[socket.data.user.id]?.qIndex === qIndex
      ? cache.clueReveals[socket.data.user.id].revealCount
      : 1;
    const clueIndex = clueIndexForScoring(timedClueIndex, existingRevealCount);
    const isCorrect = !giveUp && fuzzyMatchesAnswer(guess, question.evaluation.acceptedAnswers);
    if (!isCorrect && !giveUp) {
      const revealCount = clamp(
        Math.max(existingRevealCount, timedClueIndex + 2),
        1,
        question.evaluation.clues.length
      );
      cache.clueReveals ??= {};
      cache.clueReveals[socket.data.user.id] = {
        qIndex,
        revealCount,
      };
      await setMatchCache(cache);

      return {
        kind: 'wrongGuess',
        ack: {
          matchId,
          qIndex,
          clueIndex: timedClueIndex,
          revealCount,
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

  fireAndForget('insertMatchAnswer(handlePossessionCluesAnswer)', async () => {
    await matchesRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId: socket.data.user.id,
      selectedIndex: null,
      isCorrect: committed.isCorrect,
      timeMs: committed.answerTimeMs,
      pointsEarned: committed.pointsEarned,
      answerPayload: buildAnswerPayload({
        questionKind: committed.question.kind,
        clueIndex: committed.clueIndex,
      }),
      phaseKind: committed.question.phaseKind,
      phaseRound: committed.question.phaseRound,
      shooterSeat: committed.question.shooterSeat,
    });
  });
  fireAndForget('updatePlayerTotals(handlePossessionCluesAnswer)', async () => {
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
