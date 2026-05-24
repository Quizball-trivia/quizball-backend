import { sql } from '../../db/index.js';
import type { Json, User } from '../../db/types.js';
import type { AvatarCustomization } from './avatar-customization.js';

export interface CreateUserData {
  email?: string | null;
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  avatarCustomization?: AvatarCustomization | null;
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
  avatarCustomization?: AvatarCustomization | null;
  favoriteClub?: string | null;
  preferredLanguage?: string | null;
  onboardingComplete?: boolean;
}

export function isUserAccountInactive(user: Pick<User, 'is_deleted' | 'deleted_at' | 'pending_deletion_at'>): boolean {
  return Boolean(user.is_deleted || user.deleted_at || user.pending_deletion_at);
}

export const usersRepo = {
  async ensureFixedUser(data: {
    id: string;
    nickname: string;
    avatarUrl?: string | null;
    avatarCustomization?: AvatarCustomization | null;
  }): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai)
      VALUES (${data.id}, null, ${data.nickname}, null, ${data.avatarUrl ?? null}, ${sql.json((data.avatarCustomization ?? null) as Json)}, false, false)
      ON CONFLICT (id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        avatar_url = EXCLUDED.avatar_url,
        avatar_customization = EXCLUDED.avatar_customization,
        updated_at = NOW()
      RETURNING *
    `;
    return user;
  },

  /**
   * Case-insensitive nickname existence check among active real users.
   * Backed by the partial unique index `uq_users_lower_nickname_real`
   * (lower(nickname) WHERE is_ai = false AND not deleted), so this is an
   * O(log n) index lookup even at high user counts.
   */
  async isNicknameTaken(nickname: string, excludeUserId?: string): Promise<boolean> {
    const trimmed = nickname.trim();
    if (trimmed.length === 0) return false;
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM users
        WHERE lower(nickname) = lower(${trimmed})
          AND is_ai = false
          AND is_deleted = false
          AND deleted_at IS NULL
          AND pending_deletion_at IS NULL
          ${excludeUserId ? sql`AND id <> ${excludeUserId}` : sql``}
        LIMIT 1
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  },

  /**
   * Batch lookup: returns the subset of input nicknames already taken by
   * active real users, lowercased. Uses the partial index on
   * lower(nickname) — single query, O((k + matches) log n).
   */
  async findTakenLowerNicknames(nicknames: string[]): Promise<Set<string>> {
    if (nicknames.length === 0) return new Set();
    const lowered = nicknames.map((name) => name.toLowerCase());
    const rows = await sql<{ lower_nickname: string }[]>`
      SELECT lower(nickname) AS lower_nickname FROM users
      WHERE lower(nickname) = ANY(${lowered}::text[])
        AND is_ai = false
        AND is_deleted = false
        AND deleted_at IS NULL
        AND pending_deletion_at IS NULL
    `;
    return new Set(rows.map((row) => row.lower_nickname));
  },

  async create(data: CreateUserData): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai)
      VALUES (gen_random_uuid(), ${data.email ?? null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null}, ${sql.json((data.avatarCustomization ?? null) as Json)}, false, ${data.isAi ?? false})
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
      const avatarCustomizationJson = userData.avatarCustomization == null
        ? null
        : JSON.stringify(userData.avatarCustomization);
      const result = await tx.unsafe<User[]>(
        `INSERT INTO users (id, email, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, false, false)
         RETURNING *`,
        [
          userData.email ?? null,
          userData.nickname ?? null,
          userData.country ?? null,
          userData.avatarUrl ?? null,
          avatarCustomizationJson,
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
  avatar_customization: Json | null;
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
      avatar_customization: Json | null;
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
        u.avatar_customization,
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
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.nickname IS NOT NULL
        AND u.id != ${excludeUserId}
        AND u.nickname ILIKE ${pattern} ESCAPE '\\'
      ORDER BY rp.rp DESC NULLS LAST
      LIMIT ${limit}
    `;
  },

  /**
   * Delete an AI-only user. Refuses to delete non-AI rows as a safety guard.
   * Used during dev quick-match cleanup when the match was never created.
   */
  async deleteAiUser(id: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM users WHERE id = ${id} AND is_ai = true
    `;
    return result.count > 0;
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
        avatar_customization = CASE WHEN ${data.avatarCustomization !== undefined} THEN ${sql.json((data.avatarCustomization ?? null) as Json)}::jsonb ELSE avatar_customization END,
        favorite_club = CASE WHEN ${data.favoriteClub !== undefined} THEN ${data.favoriteClub ?? null} ELSE favorite_club END,
        preferred_language = CASE WHEN ${data.preferredLanguage !== undefined} THEN ${data.preferredLanguage ?? null} ELSE preferred_language END,
        onboarding_complete = CASE WHEN ${data.onboardingComplete !== undefined} THEN ${data.onboardingComplete ?? false} ELSE onboarding_complete END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return user ?? null;
  },

  async requestDeletion(id: string): Promise<User | null> {
    // Idempotent: re-calling on a user already pending deletion returns the existing
    // timestamps unchanged. updated_at only bumps on the first scheduling so we don't
    // create spurious audit entries or invalidate caches on no-op repeats.
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
        pending_deletion_at = COALESCE(pending_deletion_at, NOW() + INTERVAL '30 days'),
        updated_at = CASE WHEN pending_deletion_at IS NULL THEN NOW() ELSE updated_at END
      WHERE id = ${id}
        AND is_deleted = false
        AND deleted_at IS NULL
      RETURNING *
    `;
    return user ?? null;
  },

  async cancelPendingDeletion(id: string): Promise<User | null> {
    // Cancellable until the row is actually finalized (is_deleted=true). Don't gate on
    // pending_deletion_at > NOW(): the cron may run hourly/nightly, and if it's late we
    // still want the user/admin to be able to recover the account.
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        deletion_requested_at = NULL,
        pending_deletion_at = NULL,
        updated_at = NOW()
      WHERE id = ${id}
        AND pending_deletion_at IS NOT NULL
        AND deleted_at IS NULL
        AND is_deleted = false
      RETURNING *
    `;
    return user ?? null;
  },
};
