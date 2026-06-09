import { logger } from '../../core/logger.js';
import { matchAnswersRepo } from '../../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchEnteredKey } from '../match-keys.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

const MATCH_ENTERED_TTL_SEC = 24 * 60 * 60;

export async function markMatchEntered(
  matchId: string,
  userId: string,
  source: string
): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;

  try {
    await redis.set(matchEnteredKey(matchId, userId), source, { EX: MATCH_ENTERED_TTL_SEC });
  } catch (error) {
    logger.warn({ error, matchId, userId, source }, 'Failed to mark match entered');
  }
}

export async function markMatchEnteredForSocket(
  socket: QuizballSocket,
  matchId: string,
  source: string
): Promise<void> {
  await markMatchEntered(matchId, socket.data.user.id, source);
}

export async function markMatchEnteredForRoom(
  io: QuizballServer,
  matchId: string,
  source: string
): Promise<void> {
  const sockets = await io.in(`match:${matchId}`).fetchSockets();
  await Promise.all(
    sockets.map((socket) => markMatchEntered(matchId, socket.data.user.id, source))
  );
}

export async function hasMatchEnteredMarker(
  matchId: string,
  userId: string
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  return (await redis.exists(matchEnteredKey(matchId, userId))) === 1;
}

export interface MatchReplayEvidence {
  isParticipant: boolean;
  hasEnteredMarker: boolean;
  hasRecordedActivity: boolean;
  allowed: boolean;
}

export async function resolveMatchReplayEvidence(
  matchId: string,
  userId: string
): Promise<MatchReplayEvidence> {
  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const isParticipant = players.some((player) => player.user_id === userId);
  const hasEnteredMarker = isParticipant
    ? await hasMatchEnteredMarker(matchId, userId)
    : false;

  let hasRecordedActivity = false;
  if (isParticipant) {
    const answers = await matchAnswersRepo.listAnswersForMatch(matchId);
    hasRecordedActivity = answers.some((answer) => answer.user_id === userId);
  }

  return {
    isParticipant,
    hasEnteredMarker,
    hasRecordedActivity,
    allowed: isParticipant && (hasEnteredMarker || hasRecordedActivity),
  };
}
