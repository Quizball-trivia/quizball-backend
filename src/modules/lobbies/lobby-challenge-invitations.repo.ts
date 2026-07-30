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

/** A pending challenge aimed at a bot, for the delayed decline worker. */
export interface PendingBotChallengeInvitationRow {
  id: string;
  lobby_id: string;
  from_user_id: string;
  to_user_id: string;
  created_at: string;
  expires_at: string;
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
      WHERE (
        (from_user_id = ${fromUserId} AND to_user_id = ${toUserId})
        OR (from_user_id = ${toUserId} AND to_user_id = ${fromUserId})
      )
        AND status = 'pending'
        AND expires_at <= NOW()
    `;
  },

  /**
   * Pending challenges whose target is a bot, for the delayed decline worker.
   *
   * `to_user.is_ai` (not `ai_kind`) deliberately: every bot population is
   * unchallengeable by a live opponent, and the worker only ever DECLINES, so
   * a wider net is the safe direction. Bounded by `expires_at > NOW()` because
   * an already-expired invite needs no response — the existing lazy expiry
   * resolves it exactly as it does for an unresponsive human.
   */
  async listPendingBotChallenges(limit = 500): Promise<PendingBotChallengeInvitationRow[]> {
    return sql<PendingBotChallengeInvitationRow[]>`
      SELECT
        i.id,
        i.lobby_id,
        i.from_user_id,
        i.to_user_id,
        i.created_at,
        i.expires_at,
        l.invite_code AS lobby_invite_code
      FROM lobby_challenge_invitations i
      JOIN users u ON u.id = i.to_user_id
      JOIN lobbies l ON l.id = i.lobby_id
      WHERE i.status = 'pending'
        AND i.expires_at > NOW()
        AND u.is_ai = true
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
      ORDER BY i.created_at ASC
      LIMIT ${limit}
    `;
  },

  async updateStatus(
    id: string,
    status: LobbyChallengeInvitationStatus
  ): Promise<LobbyChallengeInvitationRow | null> {
    const [row] = await sql<LobbyChallengeInvitationRow[]>`
      UPDATE lobby_challenge_invitations i
      SET status = ${status}, updated_at = NOW()
      WHERE i.id = ${id}
        AND i.status = 'pending'
        -- ZERO-ACCEPTS INVARIANT (§1.12), enforced at the last possible layer.
        -- The friendly-possession engine cannot drive a bot, so an accepted
        -- invite whose target is AI would strand the challenger in a lobby that
        -- can never start. lobby-challenge.service.acceptChallenge already
        -- refuses this, but that is one caller's check; putting the predicate in
        -- the only write that can produce 'accepted' means no future path — a
        -- rejoin replay, an admin tool, a new service — can bypass it by
        -- forgetting to look. Every other status (declined/expired/canceled)
        -- stays available for bots, which is exactly what the decline worker
        -- needs.
        AND (
          ${status}::text <> 'accepted'
          OR NOT EXISTS (
            SELECT 1 FROM users u WHERE u.id = i.to_user_id AND u.is_ai = true
          )
        )
      RETURNING i.*
    `;
    return row ?? null;
  },
};
