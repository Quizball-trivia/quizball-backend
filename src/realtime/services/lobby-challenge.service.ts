import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbyChallengeInvitationsRepo } from '../../modules/lobbies/lobby-challenge-invitations.repo.js';
import { isUserAccountInactive, usersRepo } from '../../modules/users/users.repo.js';
import { isPersistentBot } from '../../modules/users/ai-classification.js';
import { config } from '../../core/config.js';
import { friendsRepo } from '../../modules/friends/friends.repo.js';
import { logger } from '../../core/logger.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
} from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { joinByCode } from './lobby-commands.service.js';
import type { LobbyChallengeInvitePayload, LobbyChallengeStatusPayload } from '../socket.types.js';
import type { AvatarCustomization } from '../../modules/users/avatar-customization.js';

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

export async function emitPendingChallengeInvitesOnConnect(socket: QuizballSocket): Promise<void> {
  const userId = socket.data.user.id;
  const invites = await lobbyChallengeInvitationsRepo.listPendingForUser(userId);
  for (const invite of invites) {
    const payload = mapChallengeInvitePayload(invite);
    if (payload) {
      socket.emit('lobby:challenge_received', payload);
    }
  }
}

export async function challengeFriend(
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

  // Friendship is checked BEFORE bot classification: a different error code for
  // bot targets would let anyone probe an arbitrary UUID and distinguish roster
  // bots from human strangers (a public masking oracle). Non-friends always get
  // NOT_FRIENDS regardless of what the target is.
  const areFriends = await friendsRepo.friendshipExists(userId, toUserId);
  if (!areFriends) {
    socket.emit('error', {
      code: 'LOBBY_CHALLENGE_NOT_FRIENDS',
      message: 'You can only challenge friends',
    });
    return;
  }

  // Persistent roster bots are challengeable as of PR12: the invite is created
  // normally and the delayed decline worker
  // (`bot-challenge-responder.service.ts`) answers it like a real friend would
  // — declining after seconds/minutes, or ignoring it so the 5-minute TTL
  // lazy-expires it. Rejecting at send time was the PR3 interim behaviour and
  // was itself a tell: no human target ever fails instantly.
  //
  // Ephemeral and auction bots stay unchallengeable. They present publicly as
  // AI, are drained by cleanup, and are never meant to hold a social graph, so
  // a pending 5-minute invite against one is pure dead weight.
  // Flag-off parity: the decline worker only runs when PERSISTENT_BOTS_ENABLED
  // is on. Letting a challenge through with the flag off would create an invite
  // that NOTHING can answer, so the challenger stares at a pending card for the
  // full 5-minute TTL — strictly worse than the instant PR3 rejection. With the
  // flag off, every bot kind falls back to that rejection.
  if (targetUser.is_ai && !(config.PERSISTENT_BOTS_ENABLED && isPersistentBot(targetUser))) {
    socket.emit('error', {
      code: 'LOBBY_CHALLENGE_INVALID',
      message: 'This player is unavailable',
    });
    return;
  }

  // Presence/readiness stays AI for persistent bots (capability matrix §1.1):
  // a bot holds no lobby, match or queue state, so the busy probe below is
  // skipped rather than asked about a user that can never be busy.
  const targetSnapshot = targetUser.is_ai
    ? null
    : await userSessionGuardService.resolveState(toUserId);
  if (
    targetSnapshot &&
    (targetSnapshot.activeMatchId ||
      targetSnapshot.waitingLobbyId ||
      targetSnapshot.queueSearchId ||
      targetSnapshot.openLobbyIds.length > 0)
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
}

export async function acceptChallenge(
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

  // HARD INVARIANT (§1.12): a challenge aimed at a bot can NEVER be accepted.
  // The friendly-possession engine has no bot driver in v1, so an accepted
  // invite would strand a human in a lobby whose opponent can never ready up.
  //
  // Reachability is already narrow — accepting requires a socket authenticated
  // AS the target, and bots hold no sessions — so this is defence in depth
  // against a future path that drives accepts server-side (a rejoin replay, an
  // admin tool, a test seam). It is asserted on the TARGET of the invite, not
  // on the caller, so it holds no matter who initiates the accept.
  const inviteTarget = await usersRepo.getById(invite.to_user_id);
  if (!inviteTarget || inviteTarget.is_ai) {
    logger.warn(
      { invitationId: invite.id, toUserId: invite.to_user_id },
      'Blocked challenge accept for a bot target'
    );
    socket.emit('error', {
      code: 'LOBBY_CHALLENGE_INVALID',
      message: 'This challenge is no longer available',
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

  await joinByCode(io, socket, lobby.invite_code);
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
}

export async function declineChallenge(
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
}
