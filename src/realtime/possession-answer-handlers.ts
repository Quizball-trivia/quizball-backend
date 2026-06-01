import { logger } from '../core/logger.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
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
import {
  answerInputLogFields,
  answerLogFields,
  cacheLogFields,
  idListLogFields,
  questionLogFields,
} from './possession-debug-logging.js';
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
  const userId = socket.data.user.id;
  logger.info(
    {
      eventName: 'match:answer',
      matchId,
      qIndex,
      userId,
      socketId: socket.id,
      selectedIndex,
      clientTimeMs: timeMs,
    },
    'Possession MCQ answer received'
  );

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
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'match:answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession MCQ answer ignored: inactive or missing cache'
      );
      return null;
    }
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) {
      logger.warn(
        {
          eventName: 'match:answer',
          matchId,
          qIndex,
          userId,
          ...cacheLogFields(cache),
          ...questionLogFields(cache.currentQuestion),
        },
        'Possession MCQ answer ignored: stale or missing current question'
      );
      return null;
    }

    const player = getCachedPlayer(cache, userId);
    if (!player) {
      logger.warn(
        { eventName: 'match:answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession MCQ answer ignored: user is not a match player'
      );
      return null;
    }

    const question = cache.currentQuestion;
    if (question.phaseKind === 'penalty') {
      const shooterSeat = asSeat(question.shooterSeat);
      const keeperSeat = shooterSeat === 1 ? 2 : 1;
      if (player.seat !== shooterSeat && player.seat !== keeperSeat) {
        logger.warn(
          {
            eventName: 'match:answer',
            matchId,
            qIndex,
            userId,
            playerSeat: player.seat,
            shooterSeat,
            keeperSeat,
            ...questionLogFields(question),
          },
          'Possession MCQ answer rejected: penalty participant mismatch'
        );
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'Only the shooter or keeper can answer this penalty question.',
        });
        return null;
      }
    }

    const existingAnswer = cache.answers[userId];
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
      logger.info(
        {
          eventName: 'match:answer',
          matchId,
          qIndex,
          userId,
          expectedCount,
          answerCount: currentAnswerCount,
          ...questionLogFields(question),
          ...answerLogFields(existingAnswer),
        },
        'Possession MCQ answer replayed existing ack'
      );
      return null;
    }

    if (question.kind !== 'multipleChoice' || question.evaluation.kind !== 'multipleChoice') {
      logger.warn(
        { eventName: 'match:answer', matchId, qIndex, userId, ...questionLogFields(question) },
        'Possession MCQ answer rejected: active question requires a dedicated event'
      );
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
          userId,
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
      userId,
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

    cache.answers[userId] = answer;
    player.totalPoints += pointsEarned;
    if (isCorrect) player.correctAnswers += 1;

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);

    await setMatchCache(cache);
    logger.info(
      {
        eventName: 'match:answer',
        matchId,
        qIndex,
        userId,
        selectedIndex,
        correctIndex: question.evaluation.correctIndex,
        isCorrect,
        pointsEarned,
        answerTimeMs: authoritativeTimeMs,
        expectedCount,
        answerCount: currentAnswerCount,
        myTotalPoints: player.totalPoints,
        ...questionLogFields(question),
      },
      'Possession MCQ answer committed'
    );

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
    await matchAnswersRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId,
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
    await matchPlayersRepo.updatePlayerTotals(
      matchId,
      userId,
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

  // Emit live in all phases, penalties included, so the opponent's pick and
  // score-flight surface the same way as a normal ranked question.
  socket.to(`match:${matchId}`).emit('match:opponent_answered', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    opponentTotalPoints: committed.myTotalPoints,
    pointsEarned: committed.pointsEarned,
    isCorrect: committed.isCorrect,
    selectedIndex,
  });

  if (committed.answerCount >= committed.expectedCount) {
    logger.info(
      {
        eventName: 'match:answer',
        matchId,
        qIndex,
        userId,
        answerCount: committed.answerCount,
        expectedCount: committed.expectedCount,
      },
      'Possession MCQ answer triggering round resolve'
    );
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
  logger.info(
    {
      eventName: 'match:countdown_guess',
      matchId,
      qIndex,
      userId,
      socketId: socket.id,
      ...answerInputLogFields(guess),
    },
    'Possession countdown guess received'
  );

  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') {
    logger.warn(
      { eventName: 'match:countdown_guess', matchId, qIndex, userId, ...cacheLogFields(cache) },
      'Possession countdown guess ignored: inactive or missing cache'
    );
    return;
  }
  if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) {
    logger.warn(
      {
        eventName: 'match:countdown_guess',
        matchId,
        qIndex,
        userId,
        ...cacheLogFields(cache),
        ...questionLogFields(cache.currentQuestion),
      },
      'Possession countdown guess ignored: stale or missing current question'
    );
    return;
  }

  const player = getCachedPlayer(cache, userId);
  if (!player) {
    logger.warn(
      { eventName: 'match:countdown_guess', matchId, qIndex, userId, ...cacheLogFields(cache) },
      'Possession countdown guess ignored: user is not a match player'
    );
    return;
  }

  const question = cache.currentQuestion;
  if (question.kind !== 'countdown' || question.evaluation.kind !== 'countdown') {
    logger.warn(
      { eventName: 'match:countdown_guess', matchId, qIndex, userId, ...questionLogFields(question) },
      'Possession countdown guess rejected: active question is not countdown'
    );
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
    logger.info(
      {
        eventName: 'match:countdown_guess',
        matchId,
        qIndex,
        userId,
        accepted: false,
        duplicate: false,
        foundCount: foundIds.size,
        totalGroups: question.evaluation.answerGroups.length,
        ...answerInputLogFields(guess),
        ...questionLogFields(question),
      },
      'Possession countdown guess rejected by matcher'
    );
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
    logger.info(
      {
        eventName: 'match:countdown_guess',
        matchId,
        qIndex,
        userId,
        accepted: false,
        duplicate: true,
        matchedAnswerGroupId: matched.id,
        foundCount: addResult.foundCount,
        totalGroups: question.evaluation.answerGroups.length,
        ...answerInputLogFields(guess),
        ...questionLogFields(question),
      },
      'Possession countdown guess ignored as duplicate'
    );
    socket.emit('match:countdown_guess_ack', {
      matchId,
      qIndex,
      accepted: false,
      duplicate: true,
      foundCount: addResult.foundCount,
    });
    return;
  }

  logger.info(
    {
      eventName: 'match:countdown_guess',
      matchId,
      qIndex,
      userId,
      accepted: true,
      duplicate: false,
      matchedAnswerGroupId: matched.id,
      foundCount: addResult.foundCount,
      totalGroups: question.evaluation.answerGroups.length,
      ...answerInputLogFields(guess),
      ...questionLogFields(question),
    },
    'Possession countdown guess accepted'
  );
  socket.emit('match:countdown_guess_ack', {
    matchId,
    qIndex,
    accepted: true,
    duplicate: false,
    foundCount: addResult.foundCount,
    acceptedDisplay: matched.display,
  });

  // Notify the opponent(s) so they can render the real live count instead
  // of a simulated one. Only fires on accepted (newly-found) answers — no
  // signal needed on rejections/duplicates.
  socket.to(`match:${matchId}`).emit('match:opponent_countdown_progress', {
    matchId,
    qIndex,
    opponentUserId: userId,
    foundCount: addResult.foundCount,
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
  const userId = socket.data.user.id;
  logger.info(
    {
      eventName: 'match:put_in_order_answer',
      matchId,
      qIndex,
      userId,
      socketId: socket.id,
      clientTimeMs: timeMs,
      ...idListLogFields('submittedOrder', orderedItemIds),
    },
    'Possession put-in-order answer received'
  );

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
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'match:put_in_order_answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession put-in-order answer ignored: inactive or missing cache'
      );
      return null;
    }
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) {
      logger.warn(
        {
          eventName: 'match:put_in_order_answer',
          matchId,
          qIndex,
          userId,
          ...cacheLogFields(cache),
          ...questionLogFields(cache.currentQuestion),
        },
        'Possession put-in-order answer ignored: stale or missing current question'
      );
      return null;
    }

    const player = getCachedPlayer(cache, userId);
    if (!player) {
      logger.warn(
        { eventName: 'match:put_in_order_answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession put-in-order answer ignored: user is not a match player'
      );
      return null;
    }

    const question = cache.currentQuestion;
    if (question.kind !== 'putInOrder' || question.evaluation.kind !== 'putInOrder') {
      logger.warn(
        { eventName: 'match:put_in_order_answer', matchId, qIndex, userId, ...questionLogFields(question) },
        'Possession put-in-order answer rejected: active question is not put-in-order'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a put-in-order round.',
      });
      return null;
    }

    const existingAnswer = cache.answers[userId];
    if (existingAnswer) {
      const answerAck = buildCachedAnswerAckPayload(cache, userId);
      if (answerAck) socket.emit('match:answer_ack', answerAck);
      logger.info(
        {
          eventName: 'match:put_in_order_answer',
          matchId,
          qIndex,
          userId,
          ...questionLogFields(question),
          ...answerLogFields(existingAnswer),
        },
        'Possession put-in-order answer replayed existing ack'
      );
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

    cache.answers[userId] = {
      userId,
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
    logger.info(
      {
        eventName: 'match:put_in_order_answer',
        matchId,
        qIndex,
        userId,
        isCorrect,
        pointsEarned,
        answerTimeMs: authoritativeTimeMs,
        foundCount,
        expectedCount,
        answerCount: currentAnswerCount,
        myTotalPoints: player.totalPoints + pointsEarned,
        ...idListLogFields('submittedOrder', orderedItemIds),
        ...idListLogFields('correctOrder', correctOrderIds),
        ...questionLogFields(question),
      },
      'Possession put-in-order answer committed'
    );

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
    await matchAnswersRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId,
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
    logger.info(
      {
        eventName: 'match:put_in_order_answer',
        matchId,
        qIndex,
        userId,
        answerCount: committed.answerCount,
        expectedCount: committed.expectedCount,
      },
      'Possession put-in-order answer triggering round resolve'
    );
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
  const userId = socket.data.user.id;
  const giveUp = payload.kind === 'giveUp';
  const guess = payload.kind === 'guess' ? payload.guess : '';
  logger.info(
    {
      eventName: 'match:clues_answer',
      matchId,
      qIndex,
      userId,
      socketId: socket.id,
      action: payload.kind,
      giveUp,
      clientTimeMs: timeMs,
      ...answerInputLogFields(guess),
    },
    'Possession clues answer received'
  );

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
    | { kind: 'noop' };

  const outcome = await withAnswerLock<LockOutcome>(matchId, 'clues_answer', () => emitMatchBusy(socket), async () => {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'match:clues_answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession clues answer ignored: inactive or missing cache'
      );
      return { kind: 'noop' };
    }
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) {
      logger.warn(
        {
          eventName: 'match:clues_answer',
          matchId,
          qIndex,
          userId,
          ...cacheLogFields(cache),
          ...questionLogFields(cache.currentQuestion),
        },
        'Possession clues answer ignored: stale or missing current question'
      );
      return { kind: 'noop' };
    }

    const player = getCachedPlayer(cache, userId);
    if (!player) {
      logger.warn(
        { eventName: 'match:clues_answer', matchId, qIndex, userId, ...cacheLogFields(cache) },
        'Possession clues answer ignored: user is not a match player'
      );
      return { kind: 'noop' };
    }

    const question = cache.currentQuestion;
    if (question.kind !== 'clues' || question.evaluation.kind !== 'clues') {
      logger.warn(
        { eventName: 'match:clues_answer', matchId, qIndex, userId, ...questionLogFields(question) },
        'Possession clues answer rejected: active question is not clues'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a clues round.',
      });
      return { kind: 'noop' };
    }

    const existingAnswer = cache.answers[userId];
    if (existingAnswer) {
      const answerAck = buildCachedAnswerAckPayload(cache, userId);
      if (answerAck) socket.emit('match:answer_ack', answerAck);
      logger.info(
        {
          eventName: 'match:clues_answer',
          matchId,
          qIndex,
          userId,
          ...questionLogFields(question),
          ...answerLogFields(existingAnswer),
        },
        'Possession clues answer replayed existing ack'
      );
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
    const clueIndex = timedClueIndex;
    const isCorrect = !giveUp && fuzzyMatchesAnswer(guess, question.evaluation.acceptedAnswers);
    const expectedCount = getExpectedUserIds(cache).length;
    const pointsEarned = calculateCluesScore(isCorrect, clueIndex);

    cache.answers[userId] = {
      userId,
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

    const currentAnswerCount = answerCount(cache);
    await setMatchCache(cache);
    logger.info(
      {
        eventName: 'match:clues_answer',
        matchId,
        qIndex,
        userId,
        action: payload.kind,
        giveUp,
        isCorrect,
        pointsEarned,
        answerTimeMs: authoritativeTimeMs,
        clueIndex,
        clueCount: question.evaluation.clues.length,
        expectedCount,
        answerCount: currentAnswerCount,
        myTotalPoints: player.totalPoints + pointsEarned,
        ...answerInputLogFields(guess),
        ...questionLogFields(question),
      },
      'Possession clues answer committed'
    );

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

  if (outcome?.kind !== 'committed') return;
  const committed = outcome.data;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  // Mirror put-in-order: persist the answer row so it survives cache
  // eviction, but leave totals to the resolver (resolver is the sole
  // updater for non-MCQ to avoid double-counting against the additive
  // matchPlayersRepo.updatePlayerTotals).
  fireAndForget('insertMatchAnswer(handlePossessionCluesAnswer)', async () => {
    await matchAnswersRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId,
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
    cluesDisplayAnswer: committed.question.reveal.kind === 'clues'
      ? committed.question.reveal.displayAnswer
      : undefined,
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
    logger.info(
      {
        eventName: 'match:clues_answer',
        matchId,
        qIndex,
        userId,
        answerCount: committed.answerCount,
        expectedCount: committed.expectedCount,
      },
      'Possession clues answer triggering round resolve'
    );
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}
