import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { getRedisClient } from '../redis.js';
import { matchPauseKey } from '../match-keys.js';
import type {
  MatchAnswerPayload,
  MatchCluesAnswerPayload,
  MatchCountdownGuessPayload,
  MatchPutInOrderAnswerPayload,
  MatchReadyForNextQuestionPayload,
} from '../schemas/match.schemas.js';
import {
  handlePossessionAnswer,
  handlePossessionCluesAnswer,
  handlePossessionCountdownGuess,
  handlePossessionHalftimeBan,
  handlePossessionPutInOrderAnswer,
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

export async function handleHalftimeBan(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { matchId: string; categoryId: string }
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const match = await matchesRepo.getMatch(payload.matchId);
  if (!match || match.status !== 'active') {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found for halftime category ban.',
    });
    return;
  }

  if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
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

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
    await handlePartyQuizAnswer(io, socket, payload, match);
    return;
  }

  await handlePossessionAnswer(io, socket, payload);
}

export async function handleCountdownGuess(
  socket: QuizballSocket,
  payload: MatchCountdownGuessPayload
): Promise<void> {
  if (await rejectIfMatchPaused(socket, payload.matchId)) return;

  const match = await matchesRepo.getMatch(payload.matchId);
  if (!match || match.status !== 'active') {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
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

  const match = await matchesRepo.getMatch(payload.matchId);
  if (!match || match.status !== 'active') {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
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

  const match = await matchesRepo.getMatch(payload.matchId);
  if (!match || match.status !== 'active') {
    socket.emit('error', {
      code: 'MATCH_NOT_ACTIVE',
      message: 'No active match found',
    });
    return;
  }

  if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
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

  const match = await matchesRepo.getMatch(payload.matchId);
  if (!match || match.status !== 'active') return;

  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (variant === 'friendly_party_quiz') {
    handlePartyQuizReadyForNextQuestion(userId, payload.matchId, payload.qIndex);
    return;
  }

  handlePossessionReadyForNextQuestion(userId, payload.matchId, payload.qIndex);
}
