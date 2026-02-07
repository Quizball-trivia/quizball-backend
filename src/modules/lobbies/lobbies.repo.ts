import { sql } from '../../db/index.js';
import type {
  LobbyRow,
  LobbyWithJoinedAt,
  LobbyMemberRow,
  LobbyMemberWithUser,
  LobbyCategoryRow,
  LobbyCategoryWithDetails,
  LobbyCategoryBanRow,
} from './lobbies.types.js';

export interface CreateLobbyData {
  mode: 'friendly' | 'ranked';
  hostUserId: string;
  inviteCode: string | null;
  gameMode?: 'friendly' | 'ranked_sim';
  friendlyRandom?: boolean;
  friendlyCategoryAId?: string | null;
  friendlyCategoryBId?: string | null;
  isPublic?: boolean;
  displayName?: string;
}

const MCQ_VALIDATION_CONDITIONS = sql`
  q.status = 'published'
  AND q.type = 'mcq_single'
  AND qp.payload ? 'options'
  AND jsonb_typeof(qp.payload->'options') = 'array'
  AND jsonb_array_length(qp.payload->'options') > 0
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE jsonb_typeof(opt) <> 'object'
       OR NOT (opt ? 'text')
       OR jsonb_typeof(opt->'text') <> 'object'
       OR NOT (opt ? 'is_correct')
       OR (opt->>'is_correct') NOT IN ('true', 'false')
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE opt->>'is_correct' = 'true'
  )
`;

export const lobbiesRepo = {
  async createLobby(data: CreateLobbyData): Promise<LobbyRow> {
    const gameMode = data.gameMode ?? (data.mode === 'ranked' ? 'ranked_sim' : 'friendly');
    const friendlyRandom = data.friendlyRandom ?? true;
    const isPublic = data.isPublic ?? false;
    const displayName = data.displayName ?? '';
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
        ${data.hostUserId},
        'waiting'
      )
      RETURNING *
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
             u.nickname, u.avatar_url
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
        COUNT(lm.user_id)::int as member_count
      FROM lobbies l
      JOIN users u ON u.id = l.host_user_id
      LEFT JOIN lobby_members lm ON lm.lobby_id = l.id
      WHERE l.status = 'waiting'
        AND l.mode = 'friendly'
        AND l.is_public = true
      GROUP BY l.id, u.nickname, u.avatar_url
      HAVING (${params.joinableOnly}::boolean = false OR COUNT(lm.user_id) < 2)
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

  async selectRandomActiveCategories(
    minQuestions: number,
    limit: number
  ): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null }>> {
    return sql<{ id: string; name: Record<string, string>; icon: string | null }[]>`
      SELECT c.id, c.name, c.icon
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE c.is_active = true
        AND ${MCQ_VALIDATION_CONDITIONS}
      GROUP BY c.id, c.name, c.icon
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
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE c.id = ANY(${sql.array(categoryIds)}::uuid[])
        AND c.is_active = true
        AND ${MCQ_VALIDATION_CONDITIONS}
      GROUP BY c.id
      HAVING COUNT(*) >= ${minQuestions}
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
      SELECT lc.category_id, lc.slot, c.name, c.icon
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

  async insertLobbyCategoryBan(lobbyId: string, userId: string, categoryId: string): Promise<LobbyCategoryBanRow> {
    const [row] = await sql<LobbyCategoryBanRow[]>`
      INSERT INTO lobby_category_bans (lobby_id, user_id, category_id)
      VALUES (${lobbyId}, ${userId}, ${categoryId})
      RETURNING *
    `;
    return row;
  },
};
