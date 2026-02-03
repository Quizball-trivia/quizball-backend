import { sql } from '../../db/index.js';
import type {
  LobbyRow,
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
}

export const lobbiesRepo = {
  async createLobby(data: CreateLobbyData): Promise<LobbyRow> {
    const [row] = await sql<LobbyRow[]>`
      INSERT INTO lobbies (id, invite_code, mode, host_user_id, status)
      VALUES (gen_random_uuid(), ${data.inviteCode}, ${data.mode}, ${data.hostUserId}, 'waiting')
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

  async setLobbyStatus(lobbyId: string, status: LobbyRow['status']): Promise<void> {
    await sql`
      UPDATE lobbies
      SET status = ${status}, updated_at = NOW()
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
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon
      HAVING COUNT(*) >= ${minQuestions}
      ORDER BY RANDOM()
      LIMIT ${limit}
    `;
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
