import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { getMatchCacheOrRebuild, type MatchCache } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import { matchPauseKey } from '../match-keys.js';
import type {
  MatchAnswerPayload,
  MatchCluesAnswerPayload,
  MatchCountdownGuessPayload,
  MatchPutInOrderAnswerPayload,
  MatchQuestionRevealedPayload,
  MatchReadyForNextQuestionPayload,
} from '../schemas/match.schemas.js';
import {
  handlePossessionAnswer,
  handlePossessionCluesAnswer,
  handlePossessionCountdownGuess,
  handlePossessionHalftimeBan,
  handlePossessionPutInOrderAnswer,
  handlePossessionQuestionRevealed,
  handlePossessionReadyForNextQuestion,
} from '../possession-match-flow.js';
import {
  handlePartyQuizAnswer,
  handlePartyQuizReadyForNextQuestion,
} from '../party-quiz-match-flow.js';

async function rejectIfMatchPaused(socket: QuizballSocket, matchId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    const paused = await redis.exists(matchPauseKey(matchId));
    if (paused) {
      socket.emit('error', {
        code: 'MATCH_PAUSED',
        message: 'Match is paused. Please wait for your opponent to return.',
      });
      return true;
    }
  }
  return false;
}

/**
 * Gate for per-socket-event dispatch: the match must be active.
 *
 * Reads from the Redis match cache (rebuilding from Postgres only on a cache
 * miss) instead of `matchesRepo.getMatch`. These handlers fire on EVERY
 * answer/guess/ready event — at the prod baseline that one `SELECT * FROM
 * matches WHERE id=$1` was ~486k calls ≈ half of all Postgres read volume
 * (db-optimize.md #2). `status`, `mode` and `statePayload` (incl. the
 * party-quiz variant, preserved by sanitizePossessionState's candidate
 * spread) are authoritative in the cache for live matches.
 */
async function getActiveMatchCache(socket: QuizballSocket, matchId: string): Promise<MatchCache | null> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return null;
  healSocketMatchBinding(socket, cache);
  return cache;
}

/**
 * Self-healing socket->match binding. handleMatchDisconnect keys the
 * pause/grace flow off `socket.data.matchId`; if a playing socket ever loses
 * (or never received) that binding — observed once on staging where a
 * mid-match disconnect produced neither a pause nor a skip — a later
 * disconnect silently bypasses the pause and the match runs without the
 * player. Any socket that sends a match event for a match it participates in
 * gets the binding repaired here, so a socket that played even one round can
 * never hit that hole. Deliberately NOT a disconnect-time DB fallback: a
 * missing matchId on a non-playing socket (e.g. a second homepage tab) is the
 * signal that protects multi-tab users from wrong pauses.
 */
function healSocketMatchBinding(socket: QuizballSocket, cache: MatchCache): void {
  if (socket.data.matchId === cache.matchId) return;
  const userId = socket.data.user.id;
  if (!cache.players.some((player) => player.userId === userId)) return;
  logger.warn(
    { matchId: cache.matchId, userId, socketId: socket.id, previousMatchId: socket.data.matchId ?? null },
    'Healed missing socket match binding on match event'
  );
  socket.data.matchId = cache.matchId;
}

export async function handleHalftimeBan(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { matchId: string; categoryId: string }
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found for halftime category ban.',
    });
    return;
  }

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'Party quiz does not support halftime bans.',
    });
    return;
  }

  await handlePossessionHalftimeBan(io, socket, payload);
}

export async function handleAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchAnswerPayload
): Promise<void> {
  const { matchId } = payload;

  if (await rejectIfMatchPaused(socket, matchId)) return;

  const cache = await getActiveMatchCache(socket, matchId);
  if (!cache) {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') {
    // Party quiz needs the full match row (state merge under lock); it loads
    // it itself — only the rarer party path pays the Postgres read now.
    await handlePartyQuizAnswer(io, socket, payload);
    return;
  }

  await handlePossessionAnswer(io, socket, payload);
}

export async function handleCountdownGuess(
  socket: QuizballSocket,
  payload: MatchCountdownGuessPayload
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'Countdown guesses are not available in party quiz mode.',
    });
    return;
  }

  await handlePossessionCountdownGuess(socket, payload);
}

export async function handlePutInOrderAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchPutInOrderAnswerPayload
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'Ordering answers are not available in party quiz mode.',
    });
    return;
  }

  await handlePossessionPutInOrderAnswer(io, socket, payload);
}

export async function handleCluesAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchCluesAnswerPayload
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'Clue answers are not available in party quiz mode.',
    });
    return;
  }

  await handlePossessionCluesAnswer(io, socket, payload);
}

export async function handleReadyForNextQuestion(
  socket: QuizballSocket,
  payload: MatchReadyForNextQuestionPayload
): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) return;

  const variant = resolveMatchVariant(cache.statePayload, cache.mode);
  if (variant === 'friendly_party_quiz') {
    handlePartyQuizReadyForNextQuestion(userId, payload.matchId, payload.qIndex);
    return;
  }

  handlePossessionReadyForNextQuestion(userId, payload.matchId, payload.qIndex);
}

export async function handleQuestionRevealed(
  socket: QuizballSocket,
  payload: MatchQuestionRevealedPayload
): Promise<void> {
  const cache = await getActiveMatchCache(socket, payload.matchId);
  if (!cache) return;

  if (resolveMatchVariant(cache.statePayload, cache.mode) === 'friendly_party_quiz') return;

  await handlePossessionQuestionRevealed(socket, payload, cache);
}
