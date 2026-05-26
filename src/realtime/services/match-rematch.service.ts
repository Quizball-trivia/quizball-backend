import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { getRedisClient } from '../redis.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
import { acquireLock, releaseLock } from '../locks.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import type { MatchPlayAgainPayload } from '../schemas/match.schemas.js';

const FRIENDLY_REMATCH_LOBBY_TTL_MS = 30 * 60 * 1000;
const FRIENDLY_REMATCH_LOCK_TTL_MS = 5000;

const rematchLobbyByMatchId = new Map<string, { lobbyId: string; createdAt: number }>();

// Proactively prune expired rematch entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [matchId, entry] of rematchLobbyByMatchId) {
    if (now - entry.createdAt > FRIENDLY_REMATCH_LOBBY_TTL_MS) {
      rematchLobbyByMatchId.delete(matchId);
    }
  }
}, 5 * 60 * 1000).unref();

function rematchLobbyKey(matchId: string): string {
  return `rematch:${matchId}`;
}

function pruneExpiredRematchLobby(matchId: string): void {
  const entry = rematchLobbyByMatchId.get(matchId);
  if (!entry) return;
  if (Date.now() - entry.createdAt <= FRIENDLY_REMATCH_LOBBY_TTL_MS) return;
  rematchLobbyByMatchId.delete(matchId);
}

async function getWaitingRematchLobbyId(matchId: string): Promise<string | null> {
  pruneExpiredRematchLobby(matchId);
  const entry = rematchLobbyByMatchId.get(matchId);
  let lobbyId = entry?.lobbyId ?? null;

  if (!lobbyId) {
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const raw = await redis.get(rematchLobbyKey(matchId));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<{ lobbyId: string; createdAt: number }>;
          if (typeof parsed.lobbyId === 'string') {
            lobbyId = parsed.lobbyId;
            rematchLobbyByMatchId.set(matchId, {
              lobbyId: parsed.lobbyId,
              createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
            });
          }
        } catch {
          await redis.del(rematchLobbyKey(matchId));
        }
      }
    }
  }

  if (!lobbyId) return null;

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.mode !== 'friendly' || lobby.status !== 'waiting') {
    rematchLobbyByMatchId.delete(matchId);
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      await redis.del(rematchLobbyKey(matchId));
    }
    return null;
  }

  return lobbyId;
}

async function setWaitingRematchLobbyId(matchId: string, lobbyId: string): Promise<void> {
  const createdAt = Date.now();
  rematchLobbyByMatchId.set(matchId, {
    lobbyId,
    createdAt,
  });

  const redis = getRedisClient();
  if (redis && redis.isOpen) {
    await redis.set(
      rematchLobbyKey(matchId),
      JSON.stringify({ lobbyId, createdAt }),
      { PX: FRIENDLY_REMATCH_LOBBY_TTL_MS }
    );
  }
}

async function detachUserSocketsFromMatch(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<void> {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`match:${matchId}`);
    if (socket.data.matchId === matchId) {
      socket.data.matchId = undefined;
    }
  });
}

async function createOrJoinFriendlyRematchLobby(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<string | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.mode !== 'friendly' || match.status !== 'completed') {
    return null;
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  if (!players.some((player) => player.user_id === userId)) {
    return null;
  }

  let rematchLobbyId = await getWaitingRematchLobbyId(matchId);
  const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId, {
    ...(rematchLobbyId ? { keepWaitingLobbyId: rematchLobbyId } : {}),
  });
  if (!prepared.ok) {
    return null;
  }

  if (!rematchLobbyId) {
    const lockKey = `lock:rematch:${matchId}`;
    const lock = await acquireLock(lockKey, FRIENDLY_REMATCH_LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) {
      rematchLobbyId = await getWaitingRematchLobbyId(matchId);
      if (!rematchLobbyId) {
        return null;
      }
    } else {
      try {
        rematchLobbyId = await getWaitingRematchLobbyId(matchId);
        if (!rematchLobbyId) {
          const sourceLobby = match.lobby_id ? await lobbiesRepo.getById(match.lobby_id) : null;
          const rematchLobby = await lobbiesRepo.createLobby({
            mode: 'friendly',
            hostUserId: userId,
            inviteCode: generateInviteCode(6),
            isPublic: sourceLobby?.is_public ?? false,
            displayName: generateLobbyName(),
            gameMode: 'friendly_possession',
            friendlyRandom: true,
            friendlyCategoryAId: null,
            friendlyCategoryBId: null,
          });
          rematchLobbyId = rematchLobby.id;
          await setWaitingRematchLobbyId(matchId, rematchLobby.id);
        }
      } finally {
        await releaseLock(lockKey, lock.token);
      }
    }
  }

  const members = await lobbiesRepo.listMembersWithUser(rematchLobbyId);
  const alreadyMember = members.some((member) => member.user_id === userId);
  if (!alreadyMember) {
    await lobbiesRepo.addMember(rematchLobbyId, userId, false);
    await syncFriendlyLobbyModeForMemberCount(rematchLobbyId, {
      clearReadyOnPartyTransition: members.length <= 2,
    });
  }

  await detachUserSocketsFromMatch(io, userId, matchId);
  await attachUserSocketsToLobby(io, userId, rematchLobbyId);
  await emitLobbyState(io, rematchLobbyId);
  return rematchLobbyId;
}

export async function handlePlayAgain(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchPlayAgainPayload
): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      const match = await matchesRepo.getMatch(payload.matchId);
      if (!match || match.mode !== 'friendly' || match.status !== 'completed') {
        socket.emit('error', {
          code: 'MATCH_NOT_COMPLETED',
          message: 'Play Again is only available after a completed friendly match',
        });
        return;
      }

      const players = await matchesRepo.listMatchPlayers(payload.matchId);
      if (!players.some((player) => player.user_id === userId)) {
        socket.emit('error', {
          code: 'NOT_IN_MATCH',
          message: 'You were not part of this match',
        });
        return;
      }

      const rematchLobbyId = await createOrJoinFriendlyRematchLobby(io, userId, payload.matchId);
      if (!rematchLobbyId) {
        socket.emit('error', {
          code: 'MATCH_PLAY_AGAIN_UNAVAILABLE',
          message: 'Unable to create a rematch lobby right now',
        });
        return;
      }

      logger.info(
        { matchId: payload.matchId, rematchLobbyId, userId },
        'Friendly play again moved user into rematch lobby'
      );
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Match transition is in progress. Please retry.',
      operation: 'match:play_again',
    }
  );
  if (!completed) return;
  await userSessionGuardService.emitState(io, userId);
}
