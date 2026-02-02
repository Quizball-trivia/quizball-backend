import { sql } from '../../db/index.js';
import { lobbiesRepo } from './lobbies.repo.js';
import type { LobbyRow, LobbyMemberWithUser, LobbyCategoryWithDetails } from './lobbies.types.js';
import type { DraftCategory, LobbyMember, LobbyState } from '../../realtime/socket.types.js';
import { NotFoundError } from '../../core/errors.js';

function pickI18nText(field: Record<string, string> | null | undefined): string {
  if (!field) return '';
  if (typeof field.en === 'string') return field.en;
  const first = Object.values(field)[0];
  return typeof first === 'string' ? first : '';
}

function toLobbyMember(row: LobbyMemberWithUser, hostUserId: string): LobbyMember {
  return {
    userId: row.user_id,
    username: row.nickname ?? 'Player',
    avatarUrl: row.avatar_url,
    isReady: row.is_ready,
    isHost: row.user_id === hostUserId,
  };
}

const MIN_QUESTIONS_PER_CATEGORY = 5;

export const lobbiesService = {
  async buildLobbyState(lobby: LobbyRow): Promise<LobbyState> {
    const members = await lobbiesRepo.listMembersWithUser(lobby.id);
    return {
      lobbyId: lobby.id,
      mode: lobby.mode,
      status: lobby.status,
      inviteCode: lobby.invite_code,
      hostUserId: lobby.host_user_id,
      members: members.map((m) => toLobbyMember(m, lobby.host_user_id)),
    };
  },

  async getLobbyOrThrow(lobbyId: string): Promise<LobbyRow> {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      throw new NotFoundError('Lobby not found');
    }
    return lobby;
  },

  async selectRandomCategories(count: number): Promise<DraftCategory[]> {
    const rows = await sql<{ id: string; name: Record<string, string>; icon: string | null }[]>`
      SELECT c.id, c.name, c.icon
      FROM categories c
      JOIN questions q ON q.category_id = c.id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      GROUP BY c.id, c.name, c.icon
      HAVING COUNT(*) >= ${MIN_QUESTIONS_PER_CATEGORY}
      ORDER BY RANDOM()
      LIMIT ${count}
    `;

    return rows.map((row) => ({
      id: row.id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
    }));
  },

  async getLobbyCategories(lobbyId: string): Promise<DraftCategory[]> {
    const rows: LobbyCategoryWithDetails[] = await lobbiesRepo.listLobbyCategoriesWithDetails(lobbyId);
    return rows.map((row) => ({
      id: row.category_id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
    }));
  },
};
