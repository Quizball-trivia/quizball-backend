import { lobbiesRepo } from './lobbies.repo.js';
import type { LobbyRow, LobbyMemberWithUser, LobbyCategoryWithDetails } from './lobbies.types.js';
import type { DraftCategory, LobbyMember, LobbyState } from '../../realtime/socket.types.js';
import { NotFoundError, pickI18nText } from '../../core/index.js';

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
      settings: {
        gameMode: lobby.game_mode ?? (lobby.mode === 'ranked' ? 'ranked_sim' : 'friendly'),
        friendlyRandom: lobby.friendly_random ?? true,
        friendlyCategoryAId: lobby.friendly_category_a_id ?? null,
        friendlyCategoryBId: lobby.friendly_category_b_id ?? null,
      },
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
    const rows = await lobbiesRepo.selectRandomActiveCategories(
      MIN_QUESTIONS_PER_CATEGORY,
      count
    );

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
