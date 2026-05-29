import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { LobbyJoinByCodeResult } from '../socket.types.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import {
  lobbiesService,
  MIN_QUESTIONS_PER_CATEGORY,
} from '../../modules/lobbies/lobbies.service.js';
import { categoriesRepo } from '../../modules/categories/categories.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import {
  FRIENDLY_LOBBY_MAX_MEMBERS,
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
  normalizeFriendlyGameMode,
  syncFriendlyLobbyModeForMemberCountLocked,
} from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import {
  startDraft,
  tryAcquireDraftStartGuard,
  releaseDraftStartGuard,
} from './lobby-draft-start.service.js';
import { startRankedAiForUser } from './lobby-ranked-ai.service.js';
import {
  acquireLobbyLockWithRetry,
  closeLobbyIfEmpty,
  getRankedAiUserIdForLobby,
  isRankedAiLobby,
  removeUserFromLobbySockets,
  resolveLobbyId,
  transferHostIfNeeded,
} from './lobby-lifecycle.helpers.js';

const JOIN_BY_CODE_LOCK_WAIT_MS = 3500;

export async function createLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { mode: 'friendly' | 'ranked'; isPublic?: boolean }
): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId);
      if (!prepared.ok) {
        userSessionGuardService.emitBlocked(socket, {
          reason: prepared.reason ?? 'ACTIVE_MATCH',
          message: prepared.message ?? 'You are already in an active match',
          stateSnapshot: prepared.snapshot,
        });
        socket.emit('error', {
          code: 'ALREADY_IN_LOBBY',
          message: prepared.message ?? 'You are already in an active match',
          meta: { stateSnapshot: prepared.snapshot },
        });
        return;
      }

      if (payload.mode === 'ranked') {
        logger.info({ userId }, 'Lobby create (ranked AI simulation) requested');
        await startRankedAiForUser(io, userId);
        return;
      }

      const inviteCode = generateInviteCode(6);
      const displayName = generateLobbyName();
      const lobby = await lobbiesRepo.createLobby({
        mode: 'friendly',
        hostUserId: userId,
        inviteCode,
        isPublic: payload.isPublic ?? false,
        displayName,
      });

      await lobbiesRepo.addMember(lobby.id, userId, false);
      await attachUserSocketsToLobby(io, userId, lobby.id);

      const redactedInvite = inviteCode ? `${inviteCode.slice(0, 2)}***` : null;
      logger.info(
        { lobbyId: lobby.id, hostUserId: userId, inviteCode: redactedInvite },
        'Lobby created'
      );
      await emitLobbyState(io, lobby.id);
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Lobby state transition is in progress. Please retry.',
      operation: 'lobby:create',
    }
  );
  if (!completed) return;

  await userSessionGuardService.emitState(io, userId);
}

export async function joinByCode(
  io: QuizballServer,
  socket: QuizballSocket,
  inviteCode: string
): Promise<LobbyJoinByCodeResult> {
  const userId = socket.data.user.id;
  const normalizedCode = inviteCode.toUpperCase();
  let result: LobbyJoinByCodeResult | null = null;

  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      const snapshot = await userSessionGuardService.resolveState(userId);
      if (snapshot.activeMatchId) {
        userSessionGuardService.emitBlocked(socket, {
          reason: 'ACTIVE_MATCH',
          message: 'You are already in an active match',
          stateSnapshot: snapshot,
        });
        socket.emit('error', {
          code: 'ALREADY_IN_LOBBY',
          message: 'You are already in an active match',
          meta: { stateSnapshot: snapshot },
        });
        result = {
          ok: false,
          code: 'ALREADY_IN_LOBBY',
          message: 'You are already in an active match',
          retryable: false,
          stateSnapshot: snapshot,
        };
        return;
      }

      const inviteLobby = await lobbiesRepo.getByInviteCode(normalizedCode);
      if (!inviteLobby) {
        logger.warn({ inviteCode: `${normalizedCode.slice(0, 2)}***` }, 'Lobby not found for invite');
        socket.emit('error', {
          code: 'LOBBY_NOT_FOUND',
          message: 'Invalid invite code',
          meta: { inviteCode: normalizedCode },
        });
        userSessionGuardService.emitBlocked(socket, {
          reason: 'INVALID_INVITE',
          message: 'Invalid invite code',
          stateSnapshot: snapshot,
        });
        result = {
          ok: false,
          code: 'LOBBY_NOT_FOUND',
          message: 'Invalid invite code',
          retryable: false,
          stateSnapshot: snapshot,
        };
        return;
      }

      const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId, {
        keepWaitingLobbyId: inviteLobby.id,
      });
      if (!prepared.ok) {
        userSessionGuardService.emitBlocked(socket, {
          reason: prepared.reason ?? 'ACTIVE_MATCH',
          message: prepared.message ?? 'You are already in an active match',
          stateSnapshot: prepared.snapshot,
        });
        socket.emit('error', {
          code: 'ALREADY_IN_LOBBY',
          message: prepared.message ?? 'You are already in an active match',
          meta: { stateSnapshot: prepared.snapshot },
        });
        result = {
          ok: false,
          code: 'ALREADY_IN_LOBBY',
          message: prepared.message ?? 'You are already in an active match',
          retryable: false,
          stateSnapshot: prepared.snapshot,
        };
        return;
      }

      const lobbyLockKey = `lock:lobby:${inviteLobby.id}`;
      const lobbyLock = await acquireLock(lobbyLockKey, 3000);
      if (!lobbyLock.acquired || !lobbyLock.token) {
        socket.emit('error', {
          code: 'TRANSITION_IN_PROGRESS',
          message: 'Lobby transition in progress. Please retry.',
        });
        result = {
          ok: false,
          code: 'TRANSITION_IN_PROGRESS',
          message: 'Lobby transition in progress. Please retry.',
          retryable: true,
        };
        return;
      }

      try {
        // Re-read target lobby after lock to avoid stale code -> deleted lobby race.
        const lobby = await lobbiesRepo.getById(inviteLobby.id);
        if (
          !lobby ||
          lobby.status !== 'waiting' ||
          lobby.mode !== 'friendly' ||
          !lobby.invite_code ||
          lobby.invite_code.toUpperCase() !== normalizedCode
        ) {
          logger.warn(
            { lobbyId: inviteLobby.id, inviteCode: `${normalizedCode.slice(0, 2)}***` },
            'Lobby join failed after lock: invite target no longer valid'
          );
          socket.emit('error', {
            code: 'LOBBY_NOT_FOUND',
            message: 'Invalid invite code',
            meta: { inviteCode: normalizedCode },
          });
          userSessionGuardService.emitBlocked(socket, {
            reason: 'LOBBY_NOT_FOUND',
            message: 'Lobby no longer exists',
            stateSnapshot: prepared.snapshot,
          });
          result = {
            ok: false,
            code: 'LOBBY_NOT_FOUND',
            message: 'Lobby no longer exists',
            retryable: false,
            stateSnapshot: prepared.snapshot,
          };
          return;
        }

        const members = await lobbiesRepo.listMembersWithUser(lobby.id);
        const alreadyMember = members.some((member) => member.user_id === userId);
        if (!alreadyMember && members.length >= FRIENDLY_LOBBY_MAX_MEMBERS) {
          logger.warn({ lobbyId: lobby.id }, 'Lobby already full');
          socket.emit('error', { code: 'LOBBY_FULL', message: 'Lobby is already full' });
          result = {
            ok: false,
            code: 'LOBBY_FULL',
            message: 'Lobby is already full',
            retryable: false,
          };
          return;
        }

        if (!alreadyMember) {
          await lobbiesRepo.addMember(lobby.id, userId, false);
          await syncFriendlyLobbyModeForMemberCountLocked(lobby.id, {
            clearReadyOnPartyTransition: members.length <= 2,
          });
        }
        await attachUserSocketsToLobby(io, userId, lobby.id);

        logger.info(
          { lobbyId: lobby.id, userId, alreadyMember },
          alreadyMember ? 'Lobby rejoined as existing member' : 'Lobby joined by code'
        );
        await emitLobbyState(io, lobby.id);
        result = {
          ok: true,
          lobbyId: lobby.id,
          inviteCode: normalizedCode,
          alreadyMember,
        };
      } finally {
        await releaseLock(lobbyLockKey, lobbyLock.token);
      }
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Lobby state transition is in progress. Please retry.',
      operation: 'lobby:join_by_code',
      waitMs: JOIN_BY_CODE_LOCK_WAIT_MS,
    }
  );
  if (!completed) {
    const snapshot = await userSessionGuardService.resolveState(userId);
    return {
      ok: false,
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Lobby state transition is in progress. Please retry.',
      retryable: true,
      stateSnapshot: snapshot,
    };
  }

  await userSessionGuardService.emitState(io, userId);
  return result ?? {
    ok: false,
    code: 'LOBBY_JOIN_ERROR',
    message: 'Failed to join lobby',
    retryable: true,
  };
}

export async function setReady(io: QuizballServer, socket: QuizballSocket, ready: boolean): Promise<void> {
  const lobbyId = socket.data.lobbyId;
  if (!lobbyId) return;

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) {
    logger.warn({ lobbyId }, 'Lobby ready update ignored: lobby not found');
    return;
  }

  const updated = await lobbiesRepo.updateMemberReady(lobbyId, socket.data.user.id, ready);
  if (!updated) {
    logger.warn(
      { lobbyId, userId: socket.data.user.id },
      'Lobby ready update ignored: member not found'
    );
    return;
  }
  logger.info(
    { lobbyId, userId: socket.data.user.id, ready },
    'Lobby member ready state updated'
  );
  await emitLobbyState(io, lobbyId);

  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    logger.warn({ lobbyId }, 'Lobby ready check skipped: lock not acquired');
    return;
  }

  let shouldStartDraft = false;
  try {
    const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
    const memberCount = await lobbiesRepo.countMembers(lobbyId);

    if (lobby.mode === 'friendly') {
      const friendlyMode = normalizeFriendlyGameMode(lobby.game_mode);
      const allReady = memberCount > 0 && readyCount === memberCount;

      if (
        (friendlyMode === 'friendly_possession' && memberCount === 2 && allReady) ||
        (friendlyMode === 'friendly_party_quiz' && memberCount >= 2 && memberCount <= FRIENDLY_LOBBY_MAX_MEMBERS && allReady)
      ) {
        logger.info({ lobbyId, gameMode: friendlyMode }, 'Lobby ready -> waiting for host start (friendly)');
        return;
      }
      if (friendlyMode !== 'ranked_sim') {
        return;
      }
    }

    if (memberCount === 2 && readyCount === 2) {
      const acquiredGuard = await tryAcquireDraftStartGuard(lobbyId);
      if (!acquiredGuard) {
        logger.debug({ lobbyId }, 'Draft already starting, skipping duplicate');
        return;
      }

      shouldStartDraft = true;
    }
  } finally {
    await releaseLock(lockKey, lock.token);
  }

  if (shouldStartDraft) {
    try {
      logger.info({ lobbyId }, 'Lobby ready -> starting draft');
      await startDraft(io, lobbyId);
    } finally {
      await releaseDraftStartGuard(lobbyId);
    }
  }
}

export async function updateSettings(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    lobbyId?: string;
    gameMode: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
    friendlyRandom?: boolean;
    friendlyCategoryAId?: string | null;
    friendlyCategoryBId?: string | null;
    isPublic?: boolean;
  }
): Promise<void> {
  const lobbyId = resolveLobbyId(socket, payload.lobbyId);
  if (!lobbyId) {
    socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
    return;
  }

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) {
    socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
    return;
  }

  if (socket.data.user.id !== lobby.host_user_id) {
    socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can update settings' });
    return;
  }

  if (lobby.status !== 'waiting') {
    socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby settings are locked' });
    return;
  }

  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLobbyLockWithRetry(lobbyId, 3000);
  if (!lock.acquired || !lock.token) {
    logger.warn(
      { lobbyId, userId: socket.data.user.id, socketId: socket.id },
      'Lobby settings update skipped: lock not acquired'
    );
    socket.emit('error', {
      code: 'LOBBY_SETTINGS_LOCKED',
      message: 'Lobby settings update is busy. Please retry.',
    });
    return;
  }

  try {
    const memberCount = await lobbiesRepo.countMembers(lobbyId);
    const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
    if (memberCount > 0 && readyCount === memberCount) {
      socket.emit('error', { code: 'LOBBY_READY_LOCKED', message: 'Cannot edit settings after both players are ready' });
      return;
    }

    const currentSettings = {
      gameMode: lobby.game_mode ?? (lobby.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
      friendlyRandom: lobby.friendly_random ?? true,
      friendlyCategoryAId: lobby.friendly_category_a_id ?? null,
      friendlyCategoryBId: lobby.friendly_category_b_id ?? null,
    };

    const nextSettings = {
      ...currentSettings,
      gameMode: payload.gameMode ?? currentSettings.gameMode,
      friendlyRandom:
        payload.friendlyRandom !== undefined
          ? payload.friendlyRandom
          : currentSettings.friendlyRandom,
      friendlyCategoryAId:
        payload.friendlyCategoryAId !== undefined
          ? payload.friendlyCategoryAId
          : currentSettings.friendlyCategoryAId,
      friendlyCategoryBId:
        payload.friendlyCategoryBId !== undefined
          ? payload.friendlyCategoryBId
          : currentSettings.friendlyCategoryBId,
    };

    if (lobby.mode === 'friendly') {
      if (memberCount > 2) {
        nextSettings.gameMode = 'friendly_party_quiz';
      }
    }

    if (nextSettings.gameMode === 'ranked_sim') {
      nextSettings.friendlyRandom = true;
      nextSettings.friendlyCategoryAId = null;
      nextSettings.friendlyCategoryBId = null;
    } else if (nextSettings.friendlyRandom) {
      nextSettings.friendlyCategoryAId = null;
      nextSettings.friendlyCategoryBId = null;
    } else {
      if (!nextSettings.friendlyCategoryAId) {
        socket.emit('error', {
          code: 'INVALID_SETTINGS',
          message: 'A category is required when random is disabled',
        });
        return;
      }
      nextSettings.friendlyCategoryBId = null;
    }

    const normalizedVisibility = payload.isPublic ?? lobby.is_public;
    const settingsUnchanged =
      nextSettings.gameMode === currentSettings.gameMode &&
      nextSettings.friendlyRandom === currentSettings.friendlyRandom &&
      nextSettings.friendlyCategoryAId === currentSettings.friendlyCategoryAId &&
      nextSettings.friendlyCategoryBId === currentSettings.friendlyCategoryBId &&
      normalizedVisibility === lobby.is_public;
    if (settingsUnchanged) {
      logger.debug({ lobbyId, userId: socket.data.user.id }, 'Lobby settings update no-op');
      return;
    }

    await lobbiesRepo.updateLobbySettings(lobbyId, {
      gameMode: nextSettings.gameMode,
      friendlyRandom: nextSettings.friendlyRandom,
      friendlyCategoryAId: nextSettings.friendlyCategoryAId,
      friendlyCategoryBId: nextSettings.friendlyCategoryBId,
    });

    if (payload.isPublic !== undefined) {
      await lobbiesRepo.setVisibility(lobbyId, payload.isPublic);
    }

    logger.info(
      {
        lobbyId,
        socketId: socket.id,
        gameMode: nextSettings.gameMode,
        friendlyRandom: nextSettings.friendlyRandom,
        friendlyCategoryAId: nextSettings.friendlyCategoryAId,
        friendlyCategoryBId: nextSettings.friendlyCategoryBId,
        isPublic: payload.isPublic ?? lobby.is_public,
        userId: socket.data.user.id,
      },
      'Lobby settings updated'
    );
    await emitLobbyState(io, lobbyId);
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function startFriendlyMatch(
  io: QuizballServer,
  socket: QuizballSocket,
  lobbyIdOverride?: string
): Promise<void> {
  const lobbyId = resolveLobbyId(socket, lobbyIdOverride);
  if (!lobbyId) {
    socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
    return;
  }

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) {
    socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
    return;
  }

  if (socket.data.user.id !== lobby.host_user_id) {
    socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start the match' });
    return;
  }

  if (lobby.status !== 'waiting') {
    socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby is not ready to start' });
    return;
  }

  const friendlyMode = normalizeFriendlyGameMode(lobby.game_mode);
  if (friendlyMode === 'ranked_sim') {
    socket.emit('error', { code: 'INVALID_SETTINGS', message: 'Host start is not available for ranked sim mode' });
    return;
  }

  const memberCount = await lobbiesRepo.countMembers(lobbyId);
  const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
  const allReady = memberCount > 0 && readyCount === memberCount;
  const isValidFriendlyStart =
    (friendlyMode === 'friendly_possession' && memberCount === 2) ||
    (friendlyMode === 'friendly_party_quiz' && memberCount >= 2 && memberCount <= FRIENDLY_LOBBY_MAX_MEMBERS);

  if (!isValidFriendlyStart || !allReady) {
    socket.emit('error', { code: 'LOBBY_NOT_READY', message: 'All lobby players must be ready' });
    return;
  }

  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    logger.warn({ lobbyId }, 'Friendly match start skipped: lock not acquired');
    socket.emit('error', {
      code: 'MATCH_START_LOCKED',
      message: 'Match start is busy. Please retry.',
    });
    return;
  }

  try {
    let categoryAId: string;
    let categoryBId: string | null;

    if (lobby.friendly_random) {
      const categories = await lobbiesService.selectRandomCategories(1);
      if (categories.length < 1) {
        logger.warn(
          { lobbyId, categoryCount: categories.length },
          'Friendly match start failed: insufficient categories'
        );
        await lobbiesRepo.setAllReady(lobbyId, false);
        await emitLobbyState(io, lobbyId);
        socket.emit('error', {
          code: 'INSUFFICIENT_CATEGORIES',
          message: 'Not enough categories with questions to start the game',
        });
        return;
      }
      categoryAId = categories[0].id;
      categoryBId = null;
    } else {
      const categoryA = lobby.friendly_category_a_id;
      if (!categoryA) {
        socket.emit('error', {
          code: 'INVALID_SETTINGS',
          message: 'Please select a category for the first half',
        });
        return;
      }

      const categories = await categoriesRepo.listByIds([categoryA]);
      if (categories.length !== 1) {
        socket.emit('error', {
          code: 'INVALID_SETTINGS',
          message: 'Selected category is invalid',
        });
        return;
      }

      const validCategoryIds = await lobbiesRepo.listValidCategoryIds(
        [categoryA],
        MIN_QUESTIONS_PER_CATEGORY
      );
      if (validCategoryIds.length !== 1) {
        socket.emit('error', {
          code: 'INSUFFICIENT_CATEGORIES',
          message: 'Selected category does not have enough questions',
        });
        await lobbiesRepo.setAllReady(lobbyId, false);
        await emitLobbyState(io, lobbyId);
        return;
      }

      categoryAId = categoryA;
      categoryBId = null;
    }

    let result;
    try {
      result = await matchesService.createMatchFromLobby({
        lobbyId,
        mode: lobby.mode,
        variant: friendlyMode,
        hostUserId: lobby.host_user_id,
        categoryAId,
        categoryBId,
      });
    } catch (error) {
      logger.warn(
        { lobbyId, error: error instanceof Error ? error.message : error },
        'Failed to create friendly match'
      );
      await lobbiesRepo.setAllReady(lobbyId, false);
      await emitLobbyState(io, lobbyId);
      socket.emit('error', {
        code: 'MATCH_CREATE_FAILED',
        message: 'Unable to start match with the selected categories',
      });
      return;
    }

    await lobbiesRepo.setLobbyStatus(lobbyId, 'active');
    // Non-host members otherwise see no UI change between the host pressing
    // "Start" and the match-start countdown firing — broadcast the status
    // flip so every client can render its "preparing match" state.
    await emitLobbyState(io, lobbyId);
    await warmupRealtimeService.cleanupLobby(lobbyId);

    logger.info(
      { lobbyId, matchId: result.match.id, mode: lobby.mode, categoryAId, categoryBId },
      'Friendly match created'
    );

    await beginMatchForLobby(io, lobbyId, result.match.id);
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function leaveLobby(io: QuizballServer, socket: QuizballSocket): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
    let lobbyId = socket.data.lobbyId;
    if (!lobbyId) {
      const existingLobby = await lobbiesRepo.findWaitingLobbyForUser(userId);
      lobbyId = existingLobby?.id;
      if (lobbyId) {
        logger.info({ lobbyId, userId }, 'Lobby leave: resolved waiting lobby from DB');
      }
    }

    if (!lobbyId) {
      logger.info({ userId }, 'Lobby leave: no waiting lobby to leave');
      return;
    }

    const lobbyLockKey = `lock:lobby:${lobbyId}`;
    const lobbyLock = await acquireLock(lobbyLockKey, 3000);
      if (!lobbyLock.acquired || !lobbyLock.token) {
        logger.warn({ lobbyId, userId }, 'Lobby leave skipped: lock not acquired');
        socket.emit('error', {
          code: 'LOBBY_BUSY',
          message: 'Lobby is currently busy. Please try again.',
          meta: { lobbyId },
        });
        return;
      }

    try {
      const lobby = await lobbiesRepo.getById(lobbyId);
      if (!lobby) {
        logger.info({ lobbyId, userId }, 'Lobby leave: target lobby already gone');
        return;
      }

      if (lobby.status !== 'waiting') {
        socket.emit('error', {
          code: 'LOBBY_ACTIVE',
          message: 'Match already started. Please reconnect to the match.',
        });
        return;
      }

      const membersBefore = await lobbiesRepo.listMembersWithUser(lobbyId);
      const wasMember = membersBefore.some((member) => member.user_id === userId);
      if (!wasMember) {
        await removeUserFromLobbySockets(io, lobbyId, userId);
        logger.info({ lobbyId, userId }, 'Lobby leave: user already removed');
        return;
      }

      await lobbiesRepo.removeMember(lobbyId, userId);
      if (isRankedAiLobby(lobby)) {
        const aiUserId = await getRankedAiUserIdForLobby(lobbyId);
        if (aiUserId) {
          await lobbiesRepo.removeMember(lobbyId, aiUserId);
        }
        const redis = getRedisClient();
        if (redis) {
          await redis.del(rankedAiLobbyKey(lobbyId));
        }
      }

      await removeUserFromLobbySockets(io, lobbyId, userId);
      logger.info({ lobbyId, userId }, 'Lobby leave: removed member');

      const closed = await closeLobbyIfEmpty(io, lobbyId);
      if (closed) {
        return;
      }

      if (lobby.host_user_id === userId) {
        await transferHostIfNeeded(lobbyId, userId);
      }

      await syncFriendlyLobbyModeForMemberCountLocked(lobbyId);

      await emitLobbyState(io, lobbyId);
    } finally {
      await releaseLock(lobbyLockKey, lobbyLock.token);
    }
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Lobby state transition is in progress. Please retry.',
      operation: 'lobby:leave',
    }
  );
  if (!completed) return;

  await userSessionGuardService.emitState(io, userId);
}
