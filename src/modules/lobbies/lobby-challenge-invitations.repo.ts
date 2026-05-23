import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';

export type LobbyChallengeInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'canceled'
  | 'expired';

export interface LobbyChallengeInvitationRow {
  id: string;
  lobby_id: string;
  from_user_id: string;
  to_user_id: string;
  status: LobbyChallengeInvitationStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface PendingLobbyChallengeInvitationRow extends LobbyChallengeInvitationRow {
  from_nickname: string | null;
  from_avatar_url: string | null;
  from_avatar_customization: Json | null;
  lobby_invite_code: string | null;
}

export const lobbyChallengeInvitationsRepo = {
  async create(data: {
    lobbyId: string;
    fromUserId: string;
    toUserId: string;
    expiresAt: Date;
  }): Promise<LobbyChallengeInvitationRow> {
    const [row] = await sql<LobbyChallengeInvitationRow[]>`
      INSERT INTO lobby_challenge_invitations (
        lobby_id,
        from_user_id,
        to_user_id,
        expires_at
      )
      VALUES (${data.lobbyId}, ${data.fromUserId}, ${data.toUserId}, ${data.expiresAt.toISOString()})
      RETURNING *
    `;
    return row;
  },

  async getById(id: string): Promise<LobbyChallengeInvitationRow | null> {
    const [row] = await sql<LobbyChallengeInvitationRow[]>`
      SELECT *
      FROM lobby_challenge_invitations
      WHERE id = ${id}
    `;
    return row ?? null;
  },

  async findPendingBetween(
    fromUserId: string,
    toUserId: string
  ): Promise<LobbyChallengeInvitationRow | null> {
    const [row] = await sql<LobbyChallengeInvitationRow[]>`
      SELECT *
      FROM lobby_challenge_invitations
      WHERE (
          (from_user_id = ${fromUserId} AND to_user_id = ${toUserId})
          OR (from_user_id = ${toUserId} AND to_user_id = ${fromUserId})
        )
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async listPendingForUser(userId: string): Promise<PendingLobbyChallengeInvitationRow[]> {
    return sql<PendingLobbyChallengeInvitationRow[]>`
      SELECT
        i.*,
        u.nickname AS from_nickname,
        u.avatar_url AS from_avatar_url,
        u.avatar_customization AS from_avatar_customization,
        l.invite_code AS lobby_invite_code
      FROM lobby_challenge_invitations i
      JOIN users u ON u.id = i.from_user_id
      JOIN lobbies l ON l.id = i.lobby_id
      WHERE i.to_user_id = ${userId}
        AND i.status = 'pending'
        AND i.expires_at > NOW()
        AND l.status = 'waiting'
      ORDER BY i.created_at DESC
    `;
  },

  async expireStalePendingForUser(userId: string): Promise<void> {
    await sql`
      UPDATE lobby_challenge_invitations
      SET status = 'expired', updated_at = NOW()
      WHERE to_user_id = ${userId}
        AND status = 'pending'
        AND expires_at <= NOW()
    `;
  },

  async expireStalePendingBetween(fromUserId: string, toUserId: string): Promise<void> {
    await sql`
      UPDATE lobby_challenge_invitations
      SET status = 'expired', updated_at = NOW()
      WHERE from_user_id = ${fromUserId}
        AND to_user_id = ${toUserId}
        AND status = 'pending'
        AND expires_at <= NOW()
    `;
  },

  async updateStatus(
    id: string,
    status: LobbyChallengeInvitationStatus
  ): Promise<LobbyChallengeInvitationRow | null> {
    const [row] = await sql<LobbyChallengeInvitationRow[]>`
      UPDATE lobby_challenge_invitations
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return row ?? null;
  },
};
