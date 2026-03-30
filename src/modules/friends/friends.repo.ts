import { sql } from '../../db/index.js';
import type { FriendStatus, FriendRequestStatus } from './friends.schemas.js';

export interface SocialPlayerRow {
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
}

export interface FriendRequestRow {
  id: string;
  sender_user_id: string;
  receiver_user_id: string;
  status: FriendRequestStatus;
  created_at: string;
  updated_at: string;
}

export interface FriendRequestListRow extends SocialPlayerRow {
  request_id: string;
  created_at: string;
}

function normalizePair(userAId: string, userBId: string) {
  return userAId < userBId
    ? { userLowId: userAId, userHighId: userBId }
    : { userLowId: userBId, userHighId: userAId };
}

export const friendsRepo = {
  async getRelationshipStatuses(
    viewerUserId: string,
    candidateUserIds: string[],
  ): Promise<Map<string, FriendStatus>> {
    if (candidateUserIds.length === 0) {
      return new Map();
    }

    const rows = await sql<Array<{ user_id: string; status: FriendStatus }>>`
      WITH candidates AS (
        SELECT UNNEST(${sql.array(candidateUserIds)}::uuid[]) AS user_id
      )
      SELECT
        c.user_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM friendships f
            WHERE (
              f.user_low_id = LEAST(${viewerUserId}::uuid, c.user_id)
              AND f.user_high_id = GREATEST(${viewerUserId}::uuid, c.user_id)
            )
          ) THEN 'friends'
          WHEN EXISTS (
            SELECT 1
            FROM friend_requests fr
            WHERE fr.sender_user_id = ${viewerUserId}
              AND fr.receiver_user_id = c.user_id
              AND fr.status = 'pending'
          ) THEN 'pending_sent'
          WHEN EXISTS (
            SELECT 1
            FROM friend_requests fr
            WHERE fr.sender_user_id = c.user_id
              AND fr.receiver_user_id = ${viewerUserId}
              AND fr.status = 'pending'
          ) THEN 'pending_received'
          ELSE 'none'
        END AS status
      FROM candidates c
    `;

    return new Map(rows.map((row) => [row.user_id, row.status]));
  },

  async listFriends(userId: string): Promise<SocialPlayerRow[]> {
    return sql<SocialPlayerRow[]>`
      SELECT
        u.id,
        u.nickname,
        u.avatar_url,
        u.total_xp,
        rp.rp AS ranked_rp,
        rp.tier AS ranked_tier,
        rp.placement_status AS ranked_placement_status,
        rp.placement_played AS ranked_placement_played,
        rp.placement_required AS ranked_placement_required,
        rp.placement_wins AS ranked_placement_wins,
        rp.current_win_streak AS ranked_current_win_streak,
        rp.last_ranked_match_at AS ranked_last_ranked_match_at
      FROM friendships f
      JOIN users u
        ON u.id = CASE
          WHEN f.user_low_id = ${userId}::uuid THEN f.user_high_id
          ELSE f.user_low_id
        END
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE f.user_low_id = ${userId}::uuid
        OR f.user_high_id = ${userId}::uuid
      ORDER BY rp.rp DESC NULLS LAST, u.nickname ASC NULLS LAST
    `;
  },

  async listIncomingRequests(userId: string): Promise<FriendRequestListRow[]> {
    return sql<FriendRequestListRow[]>`
      SELECT
        fr.id AS request_id,
        fr.created_at,
        u.id,
        u.nickname,
        u.avatar_url,
        u.total_xp,
        rp.rp AS ranked_rp,
        rp.tier AS ranked_tier,
        rp.placement_status AS ranked_placement_status,
        rp.placement_played AS ranked_placement_played,
        rp.placement_required AS ranked_placement_required,
        rp.placement_wins AS ranked_placement_wins,
        rp.current_win_streak AS ranked_current_win_streak,
        rp.last_ranked_match_at AS ranked_last_ranked_match_at
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE fr.receiver_user_id = ${userId}
        AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `;
  },

  async listOutgoingRequests(userId: string): Promise<FriendRequestListRow[]> {
    return sql<FriendRequestListRow[]>`
      SELECT
        fr.id AS request_id,
        fr.created_at,
        u.id,
        u.nickname,
        u.avatar_url,
        u.total_xp,
        rp.rp AS ranked_rp,
        rp.tier AS ranked_tier,
        rp.placement_status AS ranked_placement_status,
        rp.placement_played AS ranked_placement_played,
        rp.placement_required AS ranked_placement_required,
        rp.placement_wins AS ranked_placement_wins,
        rp.current_win_streak AS ranked_current_win_streak,
        rp.last_ranked_match_at AS ranked_last_ranked_match_at
      FROM friend_requests fr
      JOIN users u ON u.id = fr.receiver_user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE fr.sender_user_id = ${userId}
        AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `;
  },

  async friendshipExists(userAId: string, userBId: string): Promise<boolean> {
    const { userLowId, userHighId } = normalizePair(userAId, userBId);
    const [row] = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM friendships
        WHERE user_low_id = ${userLowId}
          AND user_high_id = ${userHighId}
      ) AS exists
    `;
    return row?.exists ?? false;
  },

  async getPendingRequestBetween(userAId: string, userBId: string): Promise<FriendRequestRow | null> {
    const [row] = await sql<FriendRequestRow[]>`
      SELECT *
      FROM friend_requests
      WHERE status = 'pending'
        AND (
          (sender_user_id = ${userAId} AND receiver_user_id = ${userBId})
          OR (sender_user_id = ${userBId} AND receiver_user_id = ${userAId})
        )
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async createFriendRequest(senderUserId: string, receiverUserId: string): Promise<FriendRequestRow> {
    const [row] = await sql<FriendRequestRow[]>`
      INSERT INTO friend_requests (sender_user_id, receiver_user_id, status)
      VALUES (${senderUserId}, ${receiverUserId}, 'pending')
      RETURNING *
    `;
    return row;
  },

  async getPendingRequestById(requestId: string): Promise<FriendRequestRow | null> {
    const [row] = await sql<FriendRequestRow[]>`
      SELECT *
      FROM friend_requests
      WHERE id = ${requestId}
        AND status = 'pending'
    `;
    return row ?? null;
  },

  async acceptRequest(requestId: string, receiverUserId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
      const requestRows = await tx.unsafe<FriendRequestRow[]>(
        `
        SELECT *
        FROM friend_requests
        WHERE id = $1
          AND receiver_user_id = $2
          AND status = 'pending'
        FOR UPDATE
        `,
        [requestId, receiverUserId]
      );

      const request = requestRows[0];
      if (!request) {
        return false;
      }

      const { userLowId, userHighId } = normalizePair(request.sender_user_id, request.receiver_user_id);

      await tx.unsafe(
        `
        INSERT INTO friendships (user_low_id, user_high_id)
        VALUES ($1, $2)
        ON CONFLICT (user_low_id, user_high_id) DO NOTHING
        `,
        [userLowId, userHighId]
      );

      await tx.unsafe(
        `
        UPDATE friend_requests
        SET status = 'accepted', updated_at = NOW()
        WHERE id = $1
        `,
        [requestId]
      );

      await tx.unsafe(
        `
        UPDATE friend_requests
        SET status = 'cancelled', updated_at = NOW()
        WHERE status = 'pending'
          AND id <> $1
          AND (
            (sender_user_id = $2 AND receiver_user_id = $3)
            OR (sender_user_id = $3 AND receiver_user_id = $2)
          )
        `,
        [requestId, request.sender_user_id, request.receiver_user_id]
      );

      return true;
    });
  },

  async declineRequest(requestId: string, receiverUserId: string): Promise<boolean> {
    const [row] = await sql<Array<{ id: string }>>`
      UPDATE friend_requests
      SET status = 'declined', updated_at = NOW()
      WHERE id = ${requestId}
        AND receiver_user_id = ${receiverUserId}
        AND status = 'pending'
      RETURNING id
    `;
    return Boolean(row);
  },

  async removeFriend(userId: string, friendUserId: string): Promise<boolean> {
    const { userLowId, userHighId } = normalizePair(userId, friendUserId);
    const [row] = await sql<Array<{ id: string }>>`
      DELETE FROM friendships
      WHERE user_low_id = ${userLowId}
        AND user_high_id = ${userHighId}
      RETURNING id
    `;
    return Boolean(row);
  },
};
