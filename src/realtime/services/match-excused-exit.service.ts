import { logger } from '../../core/logger.js';
import {
  matchDisconnectKey,
  matchExitPendingKey,
  matchPauseKey,
} from '../match-keys.js';
import { getRedisClient } from '../redis.js';

type MatchRosterPlayer = {
  user_id: string;
};

const EXIT_PENDING_TTL_SEC = 90;

export async function findOpponentInDisconnectGrace(
  matchId: string,
  userId: string,
  roster: MatchRosterPlayer[]
): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis || roster.length !== 2) return null;

  const opponent = roster.find((player) => player.user_id !== userId);
  if (!opponent) return null;

  const [pauseExists, opponentDisconnectExists] = await Promise.all([
    redis.exists(matchPauseKey(matchId)),
    redis.exists(matchDisconnectKey(matchId, opponent.user_id)),
  ]);

  return pauseExists === 1 && opponentDisconnectExists === 1 ? opponent.user_id : null;
}

export async function markExcusedExitPending(params: {
  matchId: string;
  userId: string;
  opponentId: string;
  source: 'match_leave' | 'match_forfeit';
}): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;

  await redis.set(
    matchExitPendingKey(params.matchId, params.userId),
    JSON.stringify({
      opponentId: params.opponentId,
      source: params.source,
      createdAt: new Date().toISOString(),
    }),
    { EX: EXIT_PENDING_TTL_SEC }
  );

  logger.info(
    {
      matchId: params.matchId,
      userId: params.userId,
      opponentId: params.opponentId,
      source: params.source,
      ttlSec: EXIT_PENDING_TTL_SEC,
    },
    'Marked player exit as excused while opponent disconnect grace is active'
  );
  return true;
}
