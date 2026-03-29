import { sql } from '../../db/index.js';
import type { User } from '../../db/types.js';

export interface CreateUserData {
  email?: string | null;
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  isAi?: boolean;
}

export interface CreateIdentityData {
  provider: string;
  subject: string;
  email?: string | null;
}

export interface UpdateUserData {
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  favoriteClub?: string | null;
  preferredLanguage?: string | null;
  onboardingComplete?: boolean;
}

export const usersRepo = {
  async ensureFixedUser(data: {
    id: string;
    nickname: string;
    avatarUrl?: string | null;
  }): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete, is_ai)
      VALUES (${data.id}, null, ${data.nickname}, null, ${data.avatarUrl ?? null}, false, false)
      ON CONFLICT (id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      RETURNING *
    `;
    return user;
  },

  async create(data: CreateUserData): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete, is_ai)
      VALUES (gen_random_uuid(), ${data.email ?? null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null}, false, ${data.isAi ?? false})
      RETURNING *
    `;
    return user;
  },

  /**
   * Create user with identity in a single transaction.
   * Prevents orphaned users if identity creation fails.
   */
  async createWithIdentity(
    userData: CreateUserData,
    identityData: CreateIdentityData
  ): Promise<User> {
    return sql.begin(async (tx) => {
      const result = await tx.unsafe<User[]>(
        `INSERT INTO users (id, email, nickname, country, avatar_url, onboarding_complete, is_ai)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, false, false)
         RETURNING *`,
        [
          userData.email ?? null,
          userData.nickname ?? null,
          userData.country ?? null,
          userData.avatarUrl ?? null,
        ]
      );
      const user = result[0];

      await tx.unsafe(
        `INSERT INTO user_identities (id, user_id, provider, subject, email)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [user.id, identityData.provider, identityData.subject, identityData.email ?? null]
      );

      return user;
    });
  },

  async getById(id: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id}
    `;
    return user ?? null;
  },

  async searchByNickname(query: string, excludeUserId: string, limit = 20): Promise<Array<{
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
  }>> {
    // Escape LIKE metacharacters (% and _) to match literals, not wildcards
    // Replace backslash first to avoid double-escaping, then escape % and _
    const escapedQuery = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escapedQuery}%`;
    return sql<Array<{
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
    }>>`
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
      FROM users u
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE u.is_ai = false
        AND u.nickname IS NOT NULL
        AND u.id != ${excludeUserId}
        AND u.nickname ILIKE ${pattern} ESCAPE '\\'
      ORDER BY rp.rp DESC NULLS LAST
      LIMIT ${limit}
    `;
  },

  async update(id: string, data: UpdateUserData): Promise<User | null> {
    // Use CASE to only update fields that are explicitly provided (not undefined)
    // undefined = keep existing, null = set to null, value = set to value
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        nickname = CASE WHEN ${data.nickname !== undefined} THEN ${data.nickname ?? null} ELSE nickname END,
        country = CASE WHEN ${data.country !== undefined} THEN ${data.country ?? null} ELSE country END,
        avatar_url = CASE WHEN ${data.avatarUrl !== undefined} THEN ${data.avatarUrl ?? null} ELSE avatar_url END,
        favorite_club = CASE WHEN ${data.favoriteClub !== undefined} THEN ${data.favoriteClub ?? null} ELSE favorite_club END,
        preferred_language = CASE WHEN ${data.preferredLanguage !== undefined} THEN ${data.preferredLanguage ?? null} ELSE preferred_language END,
        onboarding_complete = CASE WHEN ${data.onboardingComplete !== undefined} THEN ${data.onboardingComplete ?? false} ELSE onboarding_complete END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return user ?? null;
  },
};
