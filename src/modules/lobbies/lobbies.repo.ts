import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { RANKED_ELIGIBILITY_HAVING_COUNTS } from '../../db/sql-fragments.js';
import type {
  LobbyRow,
  LobbyWithJoinedAt,
  LobbyMemberRow,
  LobbyMemberWithUser,
  LobbyCategoryRow,
  LobbyCategoryWithDetails,
  LobbyCategoryBanRow,
  RankedLobbyContext,
} from './lobbies.types.js';

export interface CreateLobbyData {
  mode: 'friendly' | 'ranked';
  hostUserId: string;
  inviteCode: string | null;
  gameMode?: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
  friendlyRandom?: boolean;
  friendlyCategoryAId?: string | null;
  friendlyCategoryBId?: string | null;
  isPublic?: boolean;
  displayName?: string;
  rankedContext?: RankedLobbyContext | null;
}

export interface CreateLobbyMemberData {
  userId: string;
  isReady: boolean;
}

function deriveLobbyDefaults(data: CreateLobbyData) {
  return {
    gameMode: data.gameMode ?? (data.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
    friendlyRandom: data.friendlyRandom ?? true,
    isPublic: data.isPublic ?? false,
    displayName: data.displayName ?? '',
  };
}

export const lobbiesRepo = {
  async createLobby(data: CreateLobbyData): Promise<LobbyRow> {
    const { gameMode, friendlyRandom, isPublic, displayName } = deriveLobbyDefaults(data);
    const [row] = await sql<LobbyRow[]>`
      INSERT INTO lobbies (
        id,
        invite_code,
        mode,
        game_mode,
        friendly_random,
        friendly_category_a_id,
        friendly_category_b_id,
        is_public,
        display_name,
        ranked_context,
        host_user_id,
        status
      )
      VALUES (
        gen_random_uuid(),
        ${data.inviteCode},
        ${data.mode},
        ${gameMode},
        ${friendlyRandom},
        ${data.friendlyCategoryAId ?? null},
        ${data.friendlyCategoryBId ?? null},
        ${isPublic},
        ${displayName},
        ${sql.json((data.rankedContext ?? null) as Json)},
        ${data.hostUserId},
        'waiting'
      )
      RETURNING *
    `;
    return row;
  },

  /**
   * Creates a lobby and its initial roster atomically in one database round
   * trip. Ranked matchmaking used to acquire the app DB bulkhead three times
   * per pair (lobby + two members), which becomes the dominant queue at a
   * streamer-scale join burst even though each Postgres statement is fast.
   */
  async createLobbyWithMembers(
    data: CreateLobbyData,
    members: [CreateLobbyMemberData, CreateLobbyMemberData],
  ): Promise<LobbyRow> {
    const { gameMode, friendlyRandom, isPublic, displayName } = deriveLobbyDefaults(data);
    const [row] = await sql<LobbyRow[]>`
      WITH created_lobby AS (
        INSERT INTO lobbies (
          id,
          invite_code,
          mode,
          game_mode,
          friendly_random,
          friendly_category_a_id,
          friendly_category_b_id,
          is_public,
          display_name,
          ranked_context,
          host_user_id,
          status
        )
        VALUES (
          gen_random_uuid(),
          ${data.inviteCode},
          ${data.mode},
          ${gameMode},
          ${friendlyRandom},
          ${data.friendlyCategoryAId ?? null},
          ${data.friendlyCategoryBId ?? null},
          ${isPublic},
          ${displayName},
          ${sql.json((data.rankedContext ?? null) as Json)},
          ${data.hostUserId},
          'waiting'
        )
        RETURNING *
      ),
      created_members AS (
        INSERT INTO lobby_members (lobby_id, user_id, is_ready)
        SELECT created_lobby.id, member.user_id::uuid, member.is_ready::boolean
        FROM created_lobby
        CROSS JOIN (VALUES
          (${members[0].userId}, ${members[0].isReady}),
          (${members[1].userId}, ${members[1].isReady})
        ) AS member(user_id, is_ready)
        RETURNING lobby_id
      )
      SELECT created_lobby.*
      FROM created_lobby
      CROSS JOIN (SELECT COUNT(*) FROM created_members) AS inserted_members
    `;
    return row;
  },

  async getById(id: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT * FROM lobbies WHERE id = ${id}
    `;
    return row ?? null;
  },

  async getByInviteCode(inviteCode: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT * FROM lobbies
      WHERE invite_code = ${inviteCode} AND status = 'waiting' AND mode = 'friendly'
    `;
    return row ?? null;
  },

  async findWaitingLobbyForUser(userId: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT l.*
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status = 'waiting'
      ORDER BY lm.joined_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async findOpenLobbyForUser(userId: string): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      SELECT l.*
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.joined_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async listOpenLobbiesForUser(userId: string): Promise<LobbyWithJoinedAt[]> {
    return sql<LobbyWithJoinedAt[]>`
      SELECT l.*, lm.joined_at
      FROM lobbies l
      JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE lm.user_id = ${userId}
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.joined_at DESC
    `;
  },

  async listOpenLobbiesForUsers(userIds: string[]): Promise<Map<string, LobbyWithJoinedAt[]>> {
    const uniqueUserIds = [...new Set(userIds)];
    const lobbiesByUserId = new Map(uniqueUserIds.map((userId) => [userId, [] as LobbyWithJoinedAt[]]));
    if (uniqueUserIds.length === 0) return lobbiesByUserId;

    const rows = await sql<Array<LobbyWithJoinedAt & { session_user_id: string }>>`
      SELECT lm.user_id AS session_user_id, l.*, lm.joined_at
      FROM lobby_members lm
      JOIN lobbies l ON l.id = lm.lobby_id
      WHERE lm.user_id = ANY(${sql.array(uniqueUserIds)}::uuid[])
        AND l.status IN ('waiting', 'active')
      ORDER BY lm.user_id, lm.joined_at DESC
    `;
    for (const { session_user_id: userId, ...lobby } of rows) {
      lobbiesByUserId.get(userId)?.push(lobby as LobbyWithJoinedAt);
    }
    return lobbiesByUserId;
  },

  async setLobbyStatus(lobbyId: string, status: LobbyRow['status']): Promise<void> {
    await sql`
      UPDATE lobbies
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async setHostUser(lobbyId: string, userId: string): Promise<void> {
    await sql`
      UPDATE lobbies
      SET host_user_id = ${userId}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async deleteLobby(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobbies WHERE id = ${lobbyId}
    `;
  },

  async updateLobbySettings(
    lobbyId: string,
    settings: {
      gameMode: LobbyRow['game_mode'];
      friendlyRandom: boolean;
      friendlyCategoryAId: string | null;
      friendlyCategoryBId: string | null;
    }
  ): Promise<LobbyRow | null> {
    const [row] = await sql<LobbyRow[]>`
      UPDATE lobbies
      SET
        game_mode = ${settings.gameMode},
        friendly_random = ${settings.friendlyRandom},
        friendly_category_a_id = ${settings.friendlyCategoryAId},
        friendly_category_b_id = ${settings.friendlyCategoryBId},
        updated_at = NOW()
      WHERE id = ${lobbyId}
      RETURNING *
    `;
    return row ?? null;
  },

  async setVisibility(lobbyId: string, isPublic: boolean): Promise<void> {
    await sql`
      UPDATE lobbies
      SET is_public = ${isPublic}, updated_at = NOW()
      WHERE id = ${lobbyId}
    `;
  },

  async addMember(lobbyId: string, userId: string, isReady: boolean): Promise<LobbyMemberRow> {
    const [row] = await sql<LobbyMemberRow[]>`
      INSERT INTO lobby_members (lobby_id, user_id, is_ready)
      VALUES (${lobbyId}, ${userId}, ${isReady})
      ON CONFLICT (lobby_id, user_id)
      DO UPDATE SET is_ready = ${isReady}
      RETURNING *
    `;
    return row;
  },

  async removeMember(lobbyId: string, userId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_members WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
    `;
  },

  async removeMembers(lobbyId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await sql`
      DELETE FROM lobby_members
      WHERE lobby_id = ${lobbyId}
        AND user_id = ANY(${sql.array(userIds)}::uuid[])
    `;
  },

  async updateMemberReady(lobbyId: string, userId: string, isReady: boolean): Promise<boolean> {
    const [row] = await sql<LobbyMemberRow[]>`
      UPDATE lobby_members
      SET is_ready = ${isReady}
      WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
      RETURNING *
    `;
    return row !== undefined;
  },

  async listMembersWithUser(lobbyId: string): Promise<LobbyMemberWithUser[]> {
    return sql<LobbyMemberWithUser[]>`
      SELECT lm.lobby_id, lm.user_id, lm.is_ready, lm.joined_at,
             u.nickname, u.avatar_url, u.avatar_customization, u.favorite_club, u.is_ai
      FROM lobby_members lm
      JOIN users u ON u.id = lm.user_id
      WHERE lm.lobby_id = ${lobbyId}
      ORDER BY lm.joined_at ASC
    `;
  },

  async countMembers(lobbyId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM lobby_members WHERE lobby_id = ${lobbyId}
    `;
    return row?.count ?? 0;
  },

  async countReadyMembers(lobbyId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM lobby_members
      WHERE lobby_id = ${lobbyId} AND is_ready = true
    `;
    return row?.count ?? 0;
  },

  async setAllReady(lobbyId: string, isReady: boolean): Promise<number> {
    const rows = await sql<{ updated: number }[]>`
      UPDATE lobby_members
      SET is_ready = ${isReady}
      WHERE lobby_id = ${lobbyId}
      RETURNING 1 as updated
    `;
    return rows.length;
  },

  async listPublicLobbies(params: {
    limit: number;
    joinableOnly: boolean;
  }): Promise<Array<{
    lobby_id: string;
    invite_code: string;
    display_name: string;
    game_mode: LobbyRow['game_mode'];
    is_public: boolean;
    created_at: string;
    host_user_id: string;
    host_nickname: string | null;
    host_avatar_url: string | null;
    host_avatar_customization: unknown;
    member_count: number;
  }>> {
    return sql<Array<{
      lobby_id: string;
      invite_code: string;
      display_name: string;
      game_mode: LobbyRow['game_mode'];
      is_public: boolean;
      created_at: string;
      host_user_id: string;
      host_nickname: string | null;
      host_avatar_url: string | null;
      host_avatar_customization: unknown;
      member_count: number;
    }>>`
      SELECT
        l.id as lobby_id,
        l.invite_code,
        l.display_name,
        l.game_mode,
        l.is_public,
        l.created_at,
        l.host_user_id,
        u.nickname as host_nickname,
        u.avatar_url as host_avatar_url,
        u.avatar_customization as host_avatar_customization,
        COUNT(lm.user_id)::int as member_count
      FROM lobbies l
      JOIN users u ON u.id = l.host_user_id
      LEFT JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE l.status = 'waiting'
        AND l.mode = 'friendly'
        AND l.is_public = true
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
      GROUP BY l.id, u.nickname, u.avatar_url, u.avatar_customization
      HAVING (${params.joinableOnly}::boolean = false OR COUNT(lm.user_id) < 6)
      ORDER BY l.created_at DESC
      LIMIT ${params.limit}
    `;
  },

  async insertLobbyCategories(lobbyId: string, categories: Array<{ slot: number; categoryId: string }>): Promise<LobbyCategoryRow[]> {
    if (categories.length === 0) return [];

    const rows = categories.map((c) => [lobbyId, c.slot, c.categoryId]);

    const inserted = await sql<LobbyCategoryRow[]>`
      INSERT INTO lobby_categories (lobby_id, slot, category_id)
      VALUES ${sql(rows)}
      RETURNING *
    `;

    return inserted;
  },

  async listAllValidCategories(
    minQuestions: number
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    // Friendly/party pool = NON-featured categories only. Counts-only (no
    // payloads join / JSONB validation) — see RANKED_ELIGIBILITY_HAVING_COUNTS
    // in sql-fragments.ts for the rationale and staging identity verification.
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon, c.image_url
      HAVING COUNT(*) >= ${minQuestions}
    `;
  },

  async listAllRankedEligibleCategories(): Promise<Array<{
    id: string;
    name: Record<string, string>;
    icon: string | null;
    image_url: string | null;
  }>> {
    // Ranked draft pool = NON-featured categories. Featured held the World Cup
    // event content; with the event over, ranked draws from everything else
    // until the featured list is repurposed.
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
      GROUP BY c.id, c.name, c.icon, c.image_url
      ${RANKED_ELIGIBILITY_HAVING_COUNTS}
    `;
  },

  async selectRandomActiveCategories(
    minQuestions: number,
    limit: number
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon, c.image_url
      HAVING COUNT(*) >= ${minQuestions}
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;
  },

  async selectRandomActiveCategoriesExcluding(
    minQuestions: number,
    limit: number,
    excludeCategoryIds: string[]
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
    const exclusionClause = excludeCategoryIds.length > 0
      ? sql`AND c.id <> ALL(${sql.array(excludeCategoryIds)}::uuid[])`
      : sql``;

    return sql<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }[]>`
      SELECT c.id, c.name, c.icon, c.image_url
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        ${exclusionClause}
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon, c.image_url
      HAVING COUNT(*) >= ${minQuestions}
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;
  },

  async listValidCategoryIds(
    categoryIds: string[],
    minQuestions: number
  ): Promise<string[]> {
    if (categoryIds.length === 0) return [];

    const rows = await sql<{ id: string }[]>`
      SELECT c.id
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.id = ANY(${sql.array(categoryIds)}::uuid[])
        AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id
      HAVING COUNT(*) >= ${minQuestions}
    `;

    return rows.map((row) => row.id);
  },

  async listRankedEligibleCategoryIds(categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];

    const rows = await sql<{ id: string }[]>`
      SELECT c.id
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      WHERE c.id = ANY(${sql.array(categoryIds)}::uuid[])
        AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        AND q.status = 'published'
        AND q.type IN ('mcq_single', 'put_in_order', 'clue_chain')
      GROUP BY c.id
      ${RANKED_ELIGIBILITY_HAVING_COUNTS}
    `;

    return rows.map((row) => row.id);
  },

  async clearLobbyCategories(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_categories WHERE lobby_id = ${lobbyId}
    `;
  },

  async clearLobbyCategoryBans(lobbyId: string): Promise<void> {
    await sql`
      DELETE FROM lobby_category_bans WHERE lobby_id = ${lobbyId}
    `;
  },

  async listLobbyCategoriesWithDetails(lobbyId: string): Promise<LobbyCategoryWithDetails[]> {
    return sql<LobbyCategoryWithDetails[]>`
      SELECT lc.category_id, lc.slot, c.name, c.icon, c.image_url
      FROM lobby_categories lc
      JOIN categories c ON c.id = lc.category_id
      WHERE lc.lobby_id = ${lobbyId}
      ORDER BY lc.slot ASC
    `;
  },

  async listLobbyCategoryBans(lobbyId: string): Promise<LobbyCategoryBanRow[]> {
    return sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans WHERE lobby_id = ${lobbyId}
      ORDER BY banned_at ASC
    `;
  },

  // Idempotent against BOTH unique constraints on lobby_category_bans:
  //   - PK (lobby_id, user_id): the same user (re)bans → return their row.
  //   - UNIQUE (lobby_id, category_id): the category is already banned (by this
  //     user OR the opponent / a racing auto-ban) → return the existing row.
  // Either way the desired post-state — "this category is banned in this lobby"
  // — already holds, so we return the existing ban instead of throwing. The
  // returned row's `user_id` lets a caller that cares (the manual ban handler)
  // still detect a FOREIGN ban (user_id !== the actor) and prompt for another
  // pick. Throwing on the category collision used to dead-end the auto-ban /
  // AI-ban / recovery paths and wedge drafts on "preparing match"; making the
  // write idempotent removes that whole class of race.
  async insertLobbyCategoryBan(lobbyId: string, userId: string, categoryId: string): Promise<LobbyCategoryBanRow> {
    const [row] = await sql<LobbyCategoryBanRow[]>`
      INSERT INTO lobby_category_bans (lobby_id, user_id, category_id)
      VALUES (${lobbyId}, ${userId}, ${categoryId})
      ON CONFLICT (lobby_id, user_id) DO NOTHING
      RETURNING *
    `;
    if (row) return row;
    // PK conflict → this user already has a ban row; return it.
    const [existing] = await sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND user_id = ${userId}
      LIMIT 1
    `;
    if (existing) return existing;
    // No PK conflict and no row → the insert hit the (lobby_id, category_id)
    // UNIQUE constraint: a different user (or a racing auto-ban) already banned
    // this category. The category IS banned, which is the desired outcome —
    // return that existing ban rather than throwing and wedging the draft.
    const [foreign] = await sql<LobbyCategoryBanRow[]>`
      SELECT * FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND category_id = ${categoryId}
      LIMIT 1
    `;
    if (foreign) return foreign;
    // Neither lookup found a row — a transient state (e.g. the conflicting row
    // was deleted between INSERT and SELECT). Surface it so the caller's
    // recovery (auto-ban) can re-evaluate from a fresh read.
    throw new Error(`lobby_category_bans: failed to record ban for category ${categoryId} in lobby ${lobbyId}`);
  },
};
