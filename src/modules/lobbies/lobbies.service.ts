import { lobbiesRepo } from './lobbies.repo.js';
import type { LobbyRow, LobbyMemberWithUser, LobbyCategoryWithDetails } from './lobbies.types.js';
import type { DraftCategory, LobbyMember, LobbyState } from '../../realtime/socket.types.js';
import { NotFoundError, pickI18nText } from '../../core/index.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';

/** Fisher–Yates (Knuth) shuffle — unbiased O(n). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toLobbyMember(row: LobbyMemberWithUser, hostUserId: string): LobbyMember {
  return {
    userId: row.user_id,
    username: row.nickname ?? 'Player',
    avatarUrl: row.avatar_url,
    avatarCustomization: parseStoredAvatarCustomization(row.avatar_customization),
    isReady: row.is_ready,
    isHost: row.user_id === hostUserId,
  };
}

export const MIN_QUESTIONS_PER_CATEGORY = 5;

// ── Valid category cache ──
// Caches the expensive JSONB-validated category query results for 5 minutes.
// Categories/questions change infrequently, so a short TTL is safe.
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CategoryCacheEntry {
  rows: Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>;
  expiresAt: number;
}

let validCategoryCache: CategoryCacheEntry | null = null;
let rankedCategoryCache: CategoryCacheEntry | null = null;

async function getValidCategories(
  minQuestions: number
): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
  const now = Date.now();
  if (validCategoryCache && validCategoryCache.expiresAt > now) {
    return validCategoryCache.rows;
  }
  // Fetch ALL valid categories (no LIMIT, no randomization) and cache the full set.
  // Callers shuffle/filter/slice from this cached set.
  const rows = await lobbiesRepo.listAllValidCategories(minQuestions);
  validCategoryCache = { rows, expiresAt: now + CATEGORY_CACHE_TTL_MS };
  return rows;
}

async function getRankedCategories(): Promise<Array<{ id: string; name: Record<string, string>; icon: string | null; image_url: string | null }>> {
  const now = Date.now();
  if (rankedCategoryCache && rankedCategoryCache.expiresAt > now) {
    return rankedCategoryCache.rows;
  }

  const rows = await lobbiesRepo.listAllRankedEligibleCategories();
  rankedCategoryCache = { rows, expiresAt: now + CATEGORY_CACHE_TTL_MS };
  return rows;
}

/** Invalidate the category cache (e.g., after question import). */
export function invalidateCategoryCache(): void {
  validCategoryCache = null;
  rankedCategoryCache = null;
}

export const lobbiesService = {
  async buildLobbyState(lobby: LobbyRow): Promise<LobbyState> {
    const members = await lobbiesRepo.listMembersWithUser(lobby.id);
    return {
      lobbyId: lobby.id,
      mode: lobby.mode,
      status: lobby.status,
      inviteCode: lobby.invite_code,
      displayName: lobby.display_name ?? 'Friendly Lobby',
      isPublic: lobby.is_public ?? false,
      hostUserId: lobby.host_user_id,
      settings: {
        gameMode: lobby.game_mode ?? (lobby.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
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
    const allValid = await getValidCategories(MIN_QUESTIONS_PER_CATEGORY);
    // Shuffle and take `count` from cached set
    const shuffled = shuffle([...allValid]);
    const selected = shuffled.slice(0, count);

    return selected.map((row) => ({
      id: row.id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
      imageUrl: row.image_url ?? null,
    }));
  },

  async selectRandomCategoriesExcluding(count: number, excludeCategoryIds: string[]): Promise<DraftCategory[]> {
    const allValid = await getValidCategories(MIN_QUESTIONS_PER_CATEGORY);
    const excludeSet = new Set(excludeCategoryIds);
    const filtered = allValid.filter((row) => !excludeSet.has(row.id));
    const shuffled = filtered.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

    return selected.map((row) => ({
      id: row.id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
      imageUrl: row.image_url ?? null,
    }));
  },

  async selectRandomRankedCategories(count: number): Promise<DraftCategory[]> {
    const allRanked = await getRankedCategories();
    const shuffled = shuffle([...allRanked]);
    return shuffled.slice(0, count).map((row) => ({
      id: row.id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
      imageUrl: row.image_url ?? null,
    }));
  },

  async selectRandomRankedCategoriesExcluding(count: number, excludeCategoryIds: string[]): Promise<DraftCategory[]> {
    const allRanked = await getRankedCategories();
    const excludeSet = new Set(excludeCategoryIds);
    const filtered = allRanked.filter((row) => !excludeSet.has(row.id));
    const shuffled = shuffle([...filtered]);
    const selected = shuffled.slice(0, count);

    return selected.map((row) => ({
      id: row.id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
      imageUrl: row.image_url ?? null,
    }));
  },

  async listRankedEligibleCategoryIds(categoryIds: string[]): Promise<string[]> {
    return lobbiesRepo.listRankedEligibleCategoryIds(categoryIds);
  },

  async getLobbyCategories(lobbyId: string): Promise<DraftCategory[]> {
    const rows: LobbyCategoryWithDetails[] = await lobbiesRepo.listLobbyCategoriesWithDetails(lobbyId);
    return rows.map((row) => ({
      id: row.category_id,
      name: pickI18nText(row.name),
      icon: row.icon ?? null,
      imageUrl: row.image_url ?? null,
    }));
  },

  async listPublicLobbies(params: { limit: number; joinableOnly: boolean }) {
    const rows = await lobbiesRepo.listPublicLobbies(params);
    return rows.map((row) => ({
      lobbyId: row.lobby_id,
      inviteCode: row.invite_code,
      displayName: row.display_name ?? 'Friendly Lobby',
      gameMode: row.game_mode ?? 'friendly_possession',
      isPublic: row.is_public,
      createdAt: row.created_at,
      memberCount: row.member_count,
      maxMembers: 6,
      host: {
        id: row.host_user_id,
        username: row.host_nickname ?? 'Player',
        avatarUrl: row.host_avatar_url ?? null,
        avatarCustomization: parseStoredAvatarCustomization(row.host_avatar_customization),
      },
    }));
  },
};
