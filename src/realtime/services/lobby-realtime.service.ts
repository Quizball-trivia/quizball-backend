import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { lobbyChallengeInvitationsRepo } from '../../modules/lobbies/lobby-challenge-invitations.repo.js';
import { isUserAccountInactive, usersRepo } from '../../modules/users/users.repo.js';
import { friendsRepo } from '../../modules/friends/friends.repo.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../core/logger.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import type { LobbyChallengeInvitePayload, LobbyChallengeStatusPayload } from '../socket.types.js';
import type { AvatarCustomization } from '../../modules/users/avatar-customization.js';
import {
  autoLeaveAllWaitingLobbies,
  closeLobbyIfEmpty,
  getFirstDraftActorId,
  getNextDraftActorId,
  getRankedAiUserIdForLobby,
  isRankedAiLobby,
  resolveRankedAiUserIdForDraft,
  transferHostIfNeeded,
} from './lobby-lifecycle.helpers.js';
import { startDraft } from './lobby-draft-start.service.js';

const LOBBY_DISCONNECT_GRACE_MS = 15000;
const CHALLENGE_INVITE_TTL_MS = 5 * 60 * 1000;

function mapChallengeInvitePayload(invite: {
  id: string;
  lobby_id: string;
  expires_at: string;
  lobby_invite_code: string | null;
  from_user_id: string;
  from_nickname: string | null;
  from_avatar_url: string | null;
  from_avatar_customization: unknown;
}): LobbyChallengeInvitePayload | null {
  if (!invite.lobby_invite_code) return null;
  return {
    invitationId: invite.id,
    lobbyId: invite.lobby_id,
    inviteCode: invite.lobby_invite_code,
    fromUser: {
      id: invite.from_user_id,
      username: invite.from_nickname ?? 'Player',
      avatarUrl: invite.from_avatar_url,
      avatarCustomization: (invite.from_avatar_customization ?? null) as AvatarCustomization | null,
    },
    expiresAt: invite.expires_at,
  };
}

function emitChallengeStatus(
  io: QuizballServer,
  payload: LobbyChallengeStatusPayload,
  fromUserId?: string
): void {
  io.to(`user:${payload.toUserId}`).emit('lobby:challenge_status', payload);
  if (fromUserId) {
    io.to(`user:${fromUserId}`).emit('lobby:challenge_status', payload);
  }
}

export { startDraft } from './lobby-draft-start.service.js';
export { startRankedAiForUser } from './lobby-ranked-ai.service.js';
import {
  createLobby,
  joinByCode,
  setReady,
  updateSettings,
  startFriendlyMatch,
  leaveLobby,
} from './lobby-commands.service.js';

export const lobbyRealtimeService = {
  async rejoinWaitingLobbyOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
    const waitingLobbies = openLobbies.filter((lobby) => lobby.status === 'waiting');
    if (waitingLobbies.length === 0) return;

    const newestLobby = waitingLobbies[0];
    await autoLeaveAllWaitingLobbies(io, userId, newestLobby.id);

    await attachUserSocketsToLobby(io, userId, newestLobby.id);
    const state = await lobbiesService.buildLobbyState(newestLobby);
    socket.emit('lobby:state', state);
    await userSessionGuardService.emitState(io, userId);

    if (newestLobby.mode === 'ranked') {
      const members = await lobbiesRepo.listMembersWithUser(newestLobby.id);
      if (members.length === 2) {
        setTimeout(() => {
          void (async () => {
            const latest = await lobbiesRepo.getById(newestLobby.id);
            if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
            await startDraft(io, newestLobby.id);
          })().catch((error) => {
            logger.warn({ error, lobbyId: newestLobby.id }, 'Failed to recover ranked waiting lobby draft start');
          });
        }, 250);
      }
    }

    logger.info({ userId, lobbyId: newestLobby.id }, 'Socket rejoined waiting lobby');
  },

  async rejoinActiveDraftLobbyOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
    const activeLobbies = openLobbies.filter((lobby) => lobby.status === 'active');
    if (activeLobbies.length === 0) return;

    const newestLobby = activeLobbies[0];
    await attachUserSocketsToLobby(io, userId, newestLobby.id);
    const [state, categories, bans, members] = await Promise.all([
      lobbiesService.buildLobbyState(newestLobby),
      lobbiesService.getLobbyCategories(newestLobby.id),
      lobbiesRepo.listLobbyCategoryBans(newestLobby.id),
      lobbiesRepo.listMembersWithUser(newestLobby.id),
    ]);

    socket.emit('lobby:state', state);

    if (categories.length > 0 && members.length === 2) {
      const aiUserId = newestLobby.mode === 'ranked'
        ? await resolveRankedAiUserIdForDraft(newestLobby.id, members)
        : null;
      const firstActorUserId = getFirstDraftActorId(members, newestLobby.host_user_id, aiUserId);
      const turnUserId = getNextDraftActorId(members, bans, firstActorUserId);

      socket.emit('draft:start', {
        lobbyId: newestLobby.id,
        categories,
        turnUserId,
      });
      for (const ban of bans) {
        socket.emit('draft:banned', {
          actorId: ban.user_id,
          categoryId: ban.category_id,
        });
      }

      void import('./draft-realtime.service.js')
        .then(async ({ draftRealtimeService, resumeActiveDraftTimers }) => {
          await draftRealtimeService.resumeDraftForReconnectedPlayer(io, newestLobby.id, userId);
          await resumeActiveDraftTimers(io, newestLobby.id);
        })
        .catch((error) => {
          logger.warn({ error, lobbyId: newestLobby.id }, 'Failed to resume active draft timers on reconnect');
        });
    }

    logger.info(
      { userId, lobbyId: newestLobby.id, categoryCount: categories.length, banCount: bans.length },
      'Socket rejoined active draft lobby'
    );
  },

  async emitPendingChallengeInvitesOnConnect(socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    await lobbyChallengeInvitationsRepo.expireStalePendingForUser(userId);
    const invites = await lobbyChallengeInvitationsRepo.listPendingForUser(userId);
    for (const invite of invites) {
      const payload = mapChallengeInvitePayload(invite);
      if (payload) {
        socket.emit('lobby:challenge_received', payload);
      }
    }
  },

  async challengeFriend(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { toUserId: string }
  ): Promise<void> {
    const userId = socket.data.user.id;
    const toUserId = payload.toUserId;

    if (userId === toUserId) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_INVALID',
        message: 'You cannot challenge yourself',
      });
      return;
    }

    const targetUser = await usersRepo.getById(toUserId);
    if (!targetUser || isUserAccountInactive(targetUser)) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_INVALID',
        message: 'This player is unavailable',
      });
      return;
    }

    const areFriends = await friendsRepo.friendshipExists(userId, toUserId);
    if (!areFriends) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_NOT_FRIENDS',
        message: 'You can only challenge friends',
      });
      return;
    }

    const targetSnapshot = await userSessionGuardService.resolveState(toUserId);
    if (
      targetSnapshot.activeMatchId ||
      targetSnapshot.waitingLobbyId ||
      targetSnapshot.queueSearchId ||
      targetSnapshot.openLobbyIds.length > 0
    ) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_TARGET_BUSY',
        message: 'This player is already in another session',
        meta: { stateSnapshot: targetSnapshot },
      });
      return;
    }

    await lobbyChallengeInvitationsRepo.expireStalePendingBetween(userId, toUserId);
    const duplicate = await lobbyChallengeInvitationsRepo.findPendingBetween(userId, toUserId);
    if (duplicate) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_DUPLICATE',
        message: 'A challenge is already pending with this friend',
      });
      return;
    }

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
            code: 'LOBBY_CHALLENGE_BUSY',
            message: prepared.message ?? 'You are already in an active match',
            meta: { stateSnapshot: prepared.snapshot },
          });
          return;
        }

        const inviteCode = generateInviteCode(6);
        const displayName = generateLobbyName();
        const lobby = await lobbiesRepo.createLobby({
          mode: 'friendly',
          hostUserId: userId,
          inviteCode,
          gameMode: 'friendly_possession',
          isPublic: false,
          displayName,
        });

        let invite;
        try {
          await lobbiesRepo.addMember(lobby.id, userId, false);
          invite = await lobbyChallengeInvitationsRepo.create({
            lobbyId: lobby.id,
            fromUserId: userId,
            toUserId,
            expiresAt: new Date(Date.now() + CHALLENGE_INVITE_TTL_MS),
          });
        } catch (err) {
          // Compensating rollback: prevent stray lobby + member if the
          // invitation insert fails (e.g. unique constraint conflict).
          await lobbiesRepo.removeMember(lobby.id, userId).catch(() => {});
          await lobbiesRepo.deleteLobby(lobby.id).catch(() => {});
          throw err;
        }

        await attachUserSocketsToLobby(io, userId, lobby.id);
        await emitLobbyState(io, lobby.id);
        socket.emit('lobby:challenge_created', {
          invitationId: invite.id,
          lobbyId: lobby.id,
          inviteCode,
          toUserId,
        });

        io.to(`user:${toUserId}`).emit('lobby:challenge_received', {
          invitationId: invite.id,
          lobbyId: lobby.id,
          inviteCode,
          fromUser: {
            id: userId,
            username: socket.data.user.nickname ?? 'Player',
            avatarUrl: socket.data.user.avatar_url,
            avatarCustomization: (socket.data.user.avatar_customization ?? null) as AvatarCustomization | null,
          },
          expiresAt: invite.expires_at,
        });

        logger.info({ lobbyId: lobby.id, fromUserId: userId, toUserId }, 'Friend challenge lobby created');
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Lobby state transition is in progress. Please retry.',
        operation: 'lobby:challenge',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async acceptChallenge(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { invitationId: string }
  ): Promise<void> {
    const userId = socket.data.user.id;
    const invite = await lobbyChallengeInvitationsRepo.getById(payload.invitationId);
    if (!invite || invite.to_user_id !== userId) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_NOT_FOUND',
        message: 'Challenge invite not found',
      });
      return;
    }

    if (invite.status !== 'pending') {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_NOT_PENDING',
        message: 'This challenge is no longer pending',
      });
      return;
    }

    const lobby = await lobbiesRepo.getById(invite.lobby_id);
    if (!lobby || !lobby.invite_code || lobby.status !== 'waiting') {
      await lobbyChallengeInvitationsRepo.updateStatus(invite.id, 'canceled');
      emitChallengeStatus(io, {
        invitationId: invite.id,
        status: 'canceled',
        toUserId: invite.to_user_id,
        lobbyId: invite.lobby_id,
      }, invite.from_user_id);
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_EXPIRED',
        message: 'This challenge is no longer available',
      });
      return;
    }

    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await lobbyChallengeInvitationsRepo.updateStatus(invite.id, 'expired');
      emitChallengeStatus(io, {
        invitationId: invite.id,
        status: 'expired',
        toUserId: invite.to_user_id,
        lobbyId: invite.lobby_id,
        inviteCode: lobby.invite_code,
      }, invite.from_user_id);
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_EXPIRED',
        message: 'This challenge has expired',
      });
      return;
    }

    await this.joinByCode(io, socket, lobby.invite_code);
    if (socket.data.lobbyId !== invite.lobby_id) {
      return;
    }

    await lobbyChallengeInvitationsRepo.updateStatus(invite.id, 'accepted');
    emitChallengeStatus(io, {
      invitationId: invite.id,
      status: 'accepted',
      toUserId: invite.to_user_id,
      lobbyId: invite.lobby_id,
      inviteCode: lobby.invite_code,
    }, invite.from_user_id);
  },

  async declineChallenge(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { invitationId: string }
  ): Promise<void> {
    const userId = socket.data.user.id;
    const invite = await lobbyChallengeInvitationsRepo.getById(payload.invitationId);
    if (!invite || invite.to_user_id !== userId) {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_NOT_FOUND',
        message: 'Challenge invite not found',
      });
      return;
    }

    if (invite.status !== 'pending') {
      socket.emit('error', {
        code: 'LOBBY_CHALLENGE_NOT_PENDING',
        message: 'This challenge is no longer pending',
      });
      return;
    }

    const nextStatus: 'expired' | 'declined' =
      new Date(invite.expires_at).getTime() <= Date.now() ? 'expired' : 'declined';
    const updated = await lobbyChallengeInvitationsRepo.updateStatus(invite.id, nextStatus);
    emitChallengeStatus(io, {
      invitationId: invite.id,
      status: updated?.status === 'expired' ? 'expired' : 'declined',
      toUserId: invite.to_user_id,
      lobbyId: invite.lobby_id,
    }, invite.from_user_id);
  },

  createLobby,
  joinByCode,
  setReady,
  updateSettings,
  startFriendlyMatch,
  leaveLobby,

  async handleLobbyDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    const userId = socket.data.user.id;

    if (!lobbyId) {
      logger.info({ userId }, 'Lobby disconnect: no waiting lobby attached');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      return;
    }

    if (lobby.status === 'active') {
      void import('./draft-realtime.service.js')
        .then(({ draftRealtimeService }) => draftRealtimeService.pauseDraftForDisconnectedPlayer(io, lobbyId, userId))
        .catch((error) => {
          logger.warn({ error, lobbyId, userId }, 'Draft disconnect pause failed');
        });
      return;
    }

    if (lobby.status !== 'waiting') {
      return;
    }

    setTimeout(async () => {
      try {
        const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
        const stillPresent = sockets.some((s) => s.data.user.id === userId);
        if (stillPresent) return;

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
        logger.info({ lobbyId, userId }, 'Lobby disconnect cleanup: removed member');

        const closed = await closeLobbyIfEmpty(io, lobbyId);
        if (closed) {
          return;
        }

        if (lobby.host_user_id === userId) {
          await transferHostIfNeeded(lobbyId, userId);
        }

        await syncFriendlyLobbyModeForMemberCount(lobbyId);

        await emitLobbyState(io, lobbyId);
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Lobby disconnect cleanup failed');
      }
    }, LOBBY_DISCONNECT_GRACE_MS);
  },
};
