import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { usersRepo } from '../users/users.repo.js';
import { progressionService } from '../progression/progression.service.js';
import { friendsRepo } from './friends.repo.js';
import type { RankedProfileResponse } from '../ranked/ranked.schemas.js';

function toPlayerSummary(row: {
  id: string;
  nickname: string | null;
  avatar_url: string | null;
  total_xp: number;
  ranked_rp: number | null;
  ranked_tier: string | null;
  ranked_placement_status: 'unplaced' | 'in_progress' | 'placed' | null;
  ranked_placement_played: number | null;
  ranked_placement_required: number | null;
  ranked_placement_wins: number | null;
  ranked_current_win_streak: number | null;
  ranked_last_ranked_match_at: string | null;
}, friendStatus: 'friends' | 'pending_sent' | 'pending_received') {
  const ranked: RankedProfileResponse | null = row.ranked_tier && row.ranked_placement_status
    ? {
        rp: row.ranked_rp ?? 0,
        tier: row.ranked_tier as RankedProfileResponse['tier'],
        placementStatus: row.ranked_placement_status,
        placementPlayed: row.ranked_placement_played ?? 0,
        placementRequired: row.ranked_placement_required ?? 0,
        placementWins: row.ranked_placement_wins ?? 0,
        currentWinStreak: row.ranked_current_win_streak ?? 0,
        lastRankedMatchAt: row.ranked_last_ranked_match_at,
      }
    : null;

  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    level: progressionService.getProgression(row.total_xp).level,
    ranked,
    friendStatus,
  };
}

export const friendsService = {
  async listFriends(userId: string) {
    const rows = await friendsRepo.listFriends(userId);
    return {
      friends: rows.map((row) => toPlayerSummary(row, 'friends')),
    };
  },

  async listRequests(userId: string) {
    const [incomingRows, outgoingRows] = await Promise.all([
      friendsRepo.listIncomingRequests(userId),
      friendsRepo.listOutgoingRequests(userId),
    ]);

    return {
      incoming: incomingRows.map((row) => ({
        requestId: row.request_id,
        createdAt: row.created_at,
        user: toPlayerSummary(row, 'pending_received'),
      })),
      outgoing: outgoingRows.map((row) => ({
        requestId: row.request_id,
        createdAt: row.created_at,
        user: toPlayerSummary(row, 'pending_sent'),
      })),
      incomingCount: incomingRows.length,
    };
  },

  async createRequest(senderUserId: string, targetUserId: string) {
    if (senderUserId === targetUserId) {
      throw new BadRequestError('You cannot send a friend request to yourself');
    }

    const targetUser = await usersRepo.getById(targetUserId);
    if (!targetUser) {
      throw new NotFoundError('Target user not found');
    }

    if (await friendsRepo.friendshipExists(senderUserId, targetUserId)) {
      throw new ConflictError('Users are already friends');
    }

    const existingPendingRequest = await friendsRepo.getPendingRequestBetween(senderUserId, targetUserId);
    if (existingPendingRequest) {
      if (existingPendingRequest.sender_user_id === senderUserId) {
        throw new ConflictError('Friend request already sent');
      }
      throw new ConflictError('This user has already sent you a friend request');
    }

    const request = await friendsRepo.createFriendRequest(senderUserId, targetUserId);
    return {
      requestId: request.id,
      status: 'pending' as const,
    };
  },

  async acceptRequest(userId: string, requestId: string) {
    const success = await friendsRepo.acceptRequest(requestId, userId);
    if (!success) {
      throw new NotFoundError('Friend request not found');
    }
    return { success: true as const };
  },

  async declineRequest(userId: string, requestId: string) {
    const success = await friendsRepo.declineRequest(requestId, userId);
    if (!success) {
      throw new NotFoundError('Friend request not found');
    }
    return { success: true as const };
  },

  async removeFriend(userId: string, friendUserId: string) {
    if (userId === friendUserId) {
      throw new BadRequestError('You cannot remove yourself');
    }

    const success = await friendsRepo.removeFriend(userId, friendUserId);
    if (!success) {
      throw new NotFoundError('Friendship not found');
    }
    return { success: true as const };
  },
};
