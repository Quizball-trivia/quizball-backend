import crypto from 'crypto';

import type { QuizballServer } from './socket-server.js';
import type { LobbyGameMode } from './socket.types.js';
import { acquireLock, releaseLock } from './locks.js';
import { logger } from '../core/logger.js';
import { lobbiesRepo } from '../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../modules/lobbies/lobbies.service.js';

export const FRIENDLY_LOBBY_MAX_MEMBERS = 6;
/** Auction seats exactly 3 players (humans + bot backfill). */
export const FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS = 3;
const LOBBY_LOCK_TTL_MS = 3000;

const LOBBY_NAME_ADJECTIVES = [
  'Golden',
  'Rapid',
  'Electric',
  'Stadium',
  'Victory',
  'Thunder',
  'Derby',
  'Final',
  'Elite',
  'Club',
];

const LOBBY_NAME_NOUNS = [
  'Kickoff',
  'Strikers',
  'Midfield',
  'Penalty',
  'Hat-Trick',
  'Goal Line',
  'The Kop',
  'Champions',
  'Pitch',
  'Arena',
];

export function generateInviteCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

export function generateLobbyName(): string {
  const adjective = LOBBY_NAME_ADJECTIVES[crypto.randomInt(LOBBY_NAME_ADJECTIVES.length)];
  const noun = LOBBY_NAME_NOUNS[crypto.randomInt(LOBBY_NAME_NOUNS.length)];
  return `${adjective} ${noun}`;
}

export function normalizeFriendlyGameMode(
  gameMode: string | null | undefined
): LobbyGameMode {
  if (
    gameMode === 'friendly_party_quiz'
    || gameMode === 'auction'
    || gameMode === 'ranked_sim'
  ) {
    return gameMode;
  }
  return 'friendly_possession';
}

/**
 * How many members a friendly lobby may HOLD in a given game mode.
 *
 * Possession shares the party ceiling because a possession lobby is allowed to
 * grow past 2 — it just auto-promotes to party quiz when it does. Auction is
 * hard-capped at its 3 seats.
 */
export function maxMembersForFriendlyGameMode(gameMode: LobbyGameMode): number {
  return gameMode === 'auction'
    ? FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS
    : FRIENDLY_LOBBY_MAX_MEMBERS;
}

/**
 * How many members can actually PLAY the given mode — the limit a host must
 * satisfy to switch into it. Possession is strictly a 2-player duel, so unlike
 * `maxMembersForFriendlyGameMode` it does not inherit the party ceiling.
 */
export function playableMembersForFriendlyGameMode(gameMode: LobbyGameMode): number {
  if (gameMode === 'auction') return FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS;
  if (gameMode === 'friendly_possession' || gameMode === 'ranked_sim') return 2;
  return FRIENDLY_LOBBY_MAX_MEMBERS;
}

async function syncFriendlyLobbyModeForMemberCountInternal(
  lobbyId: string,
  options?: { clearReadyOnPartyTransition?: boolean }
): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.mode !== 'friendly' || lobby.status !== 'waiting') {
    return;
  }

  const memberCount = await lobbiesRepo.countMembers(lobbyId);
  const currentMode = normalizeFriendlyGameMode(lobby.game_mode);
  // Auction is an explicitly chosen 3-seat mode — a third member is expected
  // there and must NOT auto-promote the lobby to party quiz.
  const nextMode = memberCount > 2 && currentMode !== 'auction'
    ? 'friendly_party_quiz'
    : currentMode;

  // Only the actual promotion into party quiz invalidates ready states. An
  // auction lobby taking its expected third member changes nothing.
  const shouldClearReady =
    options?.clearReadyOnPartyTransition === true &&
    nextMode === 'friendly_party_quiz' &&
    currentMode !== 'friendly_party_quiz';

  if (nextMode !== currentMode) {
    await lobbiesRepo.updateLobbySettings(lobbyId, {
      gameMode: nextMode,
      friendlyRandom: lobby.friendly_random ?? true,
      friendlyCategoryAId: lobby.friendly_category_a_id ?? null,
      friendlyCategoryBId: null,
    });
  }

  if (shouldClearReady) {
    await lobbiesRepo.setAllReady(lobbyId, false);
  }
}

export async function syncFriendlyLobbyModeForMemberCount(
  lobbyId: string,
  options?: { clearReadyOnPartyTransition?: boolean }
): Promise<void> {
  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLock(lockKey, LOBBY_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    logger.warn({ lobbyId }, 'Friendly lobby mode sync skipped: lobby lock not acquired');
    return;
  }

  try {
    await syncFriendlyLobbyModeForMemberCountInternal(lobbyId, options);
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function syncFriendlyLobbyModeForMemberCountLocked(
  lobbyId: string,
  options?: { clearReadyOnPartyTransition?: boolean }
): Promise<void> {
  await syncFriendlyLobbyModeForMemberCountInternal(lobbyId, options);
}

export async function emitLobbyState(
  io: QuizballServer,
  lobbyId: string,
  context?: { correlationId?: string; operation?: string }
): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;

  const state = await lobbiesService.buildLobbyState(lobby);
  const memberUserIds = new Set(state.members.map((member) => member.userId));
  const room = `lobby:${lobbyId}`;
  const sockets = await io.in(room).fetchSockets();
  sockets.forEach((socket) => {
    if (memberUserIds.has(socket.data.user.id)) return;
    socket.leave(room);
    if (socket.data.lobbyId === lobbyId) {
      socket.data.lobbyId = undefined;
    }
    logger.warn(
      {
        lobbyId,
        socketUserId: socket.data.user.id,
        memberUserIds: [...memberUserIds],
      },
      'Removed non-member socket from lobby room before lobby state emit'
    );
  });

  const memberRooms = [...memberUserIds].map((userId) => `user:${userId}`);
  for (const room of memberRooms) {
    io.to(room).emit('lobby:state', state);
  }
  logger.debug(
    {
      lobbyId,
      correlationId: context?.correlationId ?? null,
      operation: context?.operation ?? null,
      status: lobby.status,
      memberCount: state.members.length,
      memberIds: state.members.map((member) => member.userId),
      mode: lobby.mode,
      gameMode: lobby.game_mode,
    },
    'Lobby state broadcast'
  );
}

export async function attachUserSocketsToLobby(
  io: QuizballServer,
  userId: string,
  lobbyId: string
): Promise<void> {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    if (socket.data.user.id !== userId) {
      socket.leave(`user:${userId}`);
      logger.warn(
        {
          lobbyId,
          expectedUserId: userId,
          socketUserId: socket.data.user.id,
        },
        'Skipped attaching socket from mismatched user room to lobby'
      );
      return;
    }
    socket.join(`lobby:${lobbyId}`);
    socket.data.lobbyId = lobbyId;
  });
}
