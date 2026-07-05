import { logger } from '../core/logger.js';
import {
  commitCachedRevealAck,
  getCachedPlayer,
  getMatchCacheOrRebuild,
  type MatchCache,
} from './match-cache.js';
import { clampRevealAckMs, REVEAL_ACK_GRACE_MS } from './possession-timing.js';
import {
  cacheLogFields,
  questionLogFields,
} from './possession-debug-logging.js';
import type { QuizballSocket } from './socket-server.js';

export async function handlePossessionQuestionRevealed(
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
  },
  preloadedCache?: MatchCache
): Promise<void> {
  const { matchId, qIndex } = payload;
  const userId = socket.data.user.id;

  if (socket.data.user.is_ai) {
    logger.debug(
      { eventName: 'match:question_revealed', matchId, qIndex, userId },
      'Possession question reveal ack ignored: AI user'
    );
    return;
  }

  const cache = preloadedCache ?? await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') {
    logger.warn(
      { eventName: 'match:question_revealed', matchId, qIndex, userId, ...cacheLogFields(cache) },
      'Possession question reveal ack ignored: inactive or missing cache'
    );
    return;
  }

  if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) {
    logger.info(
      {
        eventName: 'match:question_revealed',
        matchId,
        qIndex,
        userId,
        ...cacheLogFields(cache),
        ...questionLogFields(cache.currentQuestion),
      },
      'Possession question reveal ack ignored: stale or missing current question'
    );
    return;
  }

  const player = getCachedPlayer(cache, userId);
  if (!player) {
    logger.warn(
      { eventName: 'match:question_revealed', matchId, qIndex, userId, ...cacheLogFields(cache) },
      'Possession question reveal ack ignored: user is not a match player'
    );
    return;
  }

  cache.revealAcks ??= {};
  if (cache.revealAcks[userId]?.qIndex === qIndex) {
    logger.debug(
      { eventName: 'match:question_revealed', matchId, qIndex, userId, revealAtMs: cache.revealAcks[userId]?.revealAtMs },
      'Possession question reveal ack ignored: already recorded'
    );
    return;
  }

  const receivedAtMs = Date.now();
  const revealAtMs = clampRevealAckMs(receivedAtMs, cache.currentQuestion.shownAt);
  cache.revealAcks[userId] = { qIndex, revealAtMs };

  const stored = await commitCachedRevealAck(cache, userId, revealAtMs);
  if (!stored) {
    delete cache.revealAcks[userId];
    logger.debug(
      { eventName: 'match:question_revealed', matchId, qIndex, userId },
      'Possession question reveal ack ignored: already recorded in overlay'
    );
    return;
  }

  logger.info(
    {
      eventName: 'match:question_revealed',
      matchId,
      qIndex,
      userId,
      receivedAtMs,
      revealAtMs,
      revealAckGraceMs: REVEAL_ACK_GRACE_MS,
      ...questionLogFields(cache.currentQuestion),
    },
    'Possession question reveal ack recorded'
  );
}
