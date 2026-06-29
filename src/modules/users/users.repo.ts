import { sql } from '../../db/index.js';
import type { Json, User } from '../../db/types.js';
import type { AvatarCustomization } from './avatar-customization.js';

export interface CreateUserData {
  email?: string | null;
  phoneNumber?: string | null;
  phoneVerifiedAt?: string | null;
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
  phoneNumber?: string | null;
  phoneVerifiedAt?: string | null;
  avatarUrl?: string | null;
  avatarCustomization?: AvatarCustomization | null;
  favoriteClub?: string | null;
  preferredLanguage?: string | null;
  onboardingComplete?: boolean;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function isUserAccountInactive(user: Pick<User, 'is_deleted' | 'deleted_at' | 'pending_deletion_at'>): boolean {
  return Boolean(user.is_deleted || user.deleted_at || user.pending_deletion_at);
}

export function isUserBanned(user: Pick<User, 'is_banned'>): boolean {
  return Boolean(user.is_banned);
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
   * active real (non-AI, non-seed) users, lowercased. Seed leaderboard users
   * must not block ranked AI nickname selection. Uses the partial index on
   * lower(nickname) — single query, O((k + matches) log n).
   */
  async findTakenLowerNicknames(nicknames: string[]): Promise<Set<string>> {
    if (nicknames.length === 0) return new Set();
    const lowered = nicknames.map((name) => name.toLowerCase());
    const rows = await sql<{ lower_nickname: string }[]>`
      SELECT lower(nickname) AS lower_nickname FROM users
      WHERE lower(nickname) = ANY(${lowered}::text[])
        AND is_ai = false
        AND is_seed = false
        AND is_deleted = false
        AND deleted_at IS NULL
        AND pending_deletion_at IS NULL
    `;
    return new Set(rows.map((row) => row.lower_nickname));
  },

  async create(data: CreateUserData): Promise<User> {
    const phoneNumber = normalizeOptionalText(data.phoneNumber);
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, phone_number, phone_verified_at, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai)
      VALUES (gen_random_uuid(), ${data.email ?? null}, ${phoneNumber}, ${phoneNumber ? data.phoneVerifiedAt ?? null : null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null}, ${sql.json((data.avatarCustomization ?? null) as Json)}, false, ${data.isAi ?? false})
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
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [`user_identity:${identityData.provider}`, identityData.subject]
      );

      const existingBeforeCreate = await tx.unsafe<{ user_data: User }[]>(
        `SELECT row_to_json(u.*) as user_data
         FROM user_identities ui
         JOIN users u ON u.id = ui.user_id
         WHERE ui.provider = $1 AND ui.subject = $2
         LIMIT 1`,
        [identityData.provider, identityData.subject]
      );

      if (existingBeforeCreate[0]?.user_data) {
        return existingBeforeCreate[0].user_data;
      }

      const avatarCustomizationJson = userData.avatarCustomization == null
        ? null
        : JSON.stringify(userData.avatarCustomization);
      const phoneNumber = normalizeOptionalText(userData.phoneNumber);
      const result = await tx.unsafe<User[]>(
        `INSERT INTO users (id, email, phone_number, phone_verified_at, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, false, false)
         RETURNING *`,
        [
          userData.email ?? null,
          phoneNumber,
          phoneNumber ? userData.phoneVerifiedAt ?? null : null,
          userData.nickname ?? null,
          userData.country ?? null,
          userData.avatarUrl ?? null,
          avatarCustomizationJson,
        ]
      );
      const user = result[0];

      const identityResult = await tx.unsafe<{ user_id: string }[]>(
        `INSERT INTO user_identities (id, user_id, provider, subject, email)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (provider, subject) DO NOTHING
         RETURNING user_id`,
        [user.id, identityData.provider, identityData.subject, identityData.email ?? null]
      );

      if (identityResult.length > 0) {
        return user;
      }

      // Defensive fallback for mixed deploys or any writer that does not take the
      // advisory lock. Under the locked path above, this branch should not run.
      await tx.unsafe(
        `DELETE FROM users WHERE id = $1`,
        [user.id]
      );

      const existing = await tx.unsafe<{ user_data: User }[]>(
        `SELECT row_to_json(u.*) as user_data
         FROM user_identities ui
         JOIN users u ON u.id = ui.user_id
         WHERE ui.provider = $1 AND ui.subject = $2
         LIMIT 1`,
        [identityData.provider, identityData.subject]
      );

      if (!existing[0]?.user_data) {
        throw new Error('Identity conflict occurred but existing user could not be loaded');
      }

      return existing[0].user_data;
    });
  },

  async getById(id: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id}
    `;
    return user ?? null;
  },

  async getActiveByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users
      WHERE phone_number = ${phoneNumber}
        AND is_ai = false
        AND is_deleted = false
        AND deleted_at IS NULL
        AND pending_deletion_at IS NULL
      LIMIT 1
    `;
    return user ?? null;
  },

  async getActiveOrPendingByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users
      WHERE phone_number = ${phoneNumber}
        AND is_ai = false
        AND is_deleted = false
        AND deleted_at IS NULL
      ORDER BY pending_deletion_at NULLS LAST, updated_at DESC
      LIMIT 1
    `;
    return user ?? null;
  },

  async getPendingDeletionByEmail(email: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users
      WHERE lower(email) = lower(${email})
        AND is_ai = false
        AND is_deleted = false
        AND deleted_at IS NULL
        AND pending_deletion_at IS NOT NULL
      ORDER BY pending_deletion_at DESC
      LIMIT 1
    `;
    return user ?? null;
  },

  /**
   * Batch fetch users by IDs.
   * More efficient than calling getById in a loop (avoids N+1 queries).
   * Returns a Map for O(1) lookup by ID (unordered).
   */
  async getByIds(ids: string[]): Promise<Map<string, User>> {
    if (ids.length === 0) return new Map();

    const uniqueIds = [...new Set(ids)];
    const results = await sql<User[]>`
      SELECT * FROM users WHERE id = ANY(${sql.array(uniqueIds)}::uuid[])
    `;

    return new Map(results.map((user) => [user.id, user]));
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
   * Admin: paginated, searchable list of real users joined with ranked + wallet
   * data. Mirrors the active-user filters used by searchByNickname (excludes AI,
   * seed, deleted and pending-deletion accounts) so the admin list matches the
   * set of users that can actually appear on the leaderboard.
   */
  async listUsersForAdmin(params: {
    search?: string;
    page: number;
    limit: number;
    orderBy: 'created_at' | 'total_xp' | 'rp' | 'nickname';
    orderDir: 'asc' | 'desc';
  }): Promise<{
    items: Array<{
      id: string;
      email: string | null;
      nickname: string | null;
      country: string | null;
      avatar_url: string | null;
      total_xp: number;
      coins: number;
      tickets: number;
      created_at: string;
      is_banned: boolean;
      ranked_rp: number | null;
      ranked_tier: string | null;
      ranked_placement_status: 'unplaced' | 'in_progress' | 'placed' | null;
    }>;
    total: number;
  }> {
    const offset = (params.page - 1) * params.limit;

    // Escape LIKE metacharacters so the search term matches literally.
    const searchPattern = params.search
      ? `%${params.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
      : null;
    const searchFilter = searchPattern
      ? sql`AND (u.nickname ILIKE ${searchPattern} ESCAPE '\\' OR u.email ILIKE ${searchPattern} ESCAPE '\\')`
      : sql``;

    const activeFilters = sql`
      u.is_ai = false
      AND u.is_seed = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
      AND u.pending_deletion_at IS NULL
    `;

    // Whitelisted ORDER BY — never interpolate the raw column/direction.
    const direction = params.orderDir === 'asc' ? sql`ASC` : sql`DESC`;
    const orderClause = (() => {
      switch (params.orderBy) {
        case 'total_xp':
          return sql`u.total_xp ${direction}, u.created_at DESC`;
        case 'rp':
          return sql`rp.rp ${direction} NULLS LAST, u.created_at DESC`;
        case 'nickname':
          return sql`u.nickname ${direction} NULLS LAST, u.created_at DESC`;
        case 'created_at':
        default:
          return sql`u.created_at ${direction}`;
      }
    })();

    const [totalRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
      FROM users u
      WHERE ${activeFilters}
      ${searchFilter}
    `;

    const items = await sql<Array<{
      id: string;
      email: string | null;
      nickname: string | null;
      country: string | null;
      avatar_url: string | null;
      total_xp: number;
      coins: number;
      tickets: number;
      created_at: string;
      is_banned: boolean;
      ranked_rp: number | null;
      ranked_tier: string | null;
      ranked_placement_status: 'unplaced' | 'in_progress' | 'placed' | null;
    }>>`
      SELECT
        u.id,
        u.email,
        u.nickname,
        u.country,
        u.avatar_url,
        u.total_xp,
        u.coins,
        u.tickets,
        u.created_at,
        u.is_banned,
        rp.rp AS ranked_rp,
        rp.tier AS ranked_tier,
        rp.placement_status AS ranked_placement_status
      FROM users u
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE ${activeFilters}
      ${searchFilter}
      ORDER BY ${orderClause}
      LIMIT ${params.limit}
      OFFSET ${offset}
    `;

    return { items, total: totalRow?.total ?? 0 };
  },

  /**
   * Admin: set a user's total_xp to an absolute value. Level is recomputed on
   * read from total_xp, so this is a safe single-column write.
   */
  async setTotalXp(userId: string, totalXp: number): Promise<number | null> {
    const [row] = await sql<{ total_xp: number }[]>`
      UPDATE users
      SET total_xp = ${totalXp}, updated_at = NOW()
      WHERE id = ${userId}
      RETURNING total_xp
    `;
    return row?.total_xp ?? null;
  },

  /**
   * Set or clear the ban state on an account. Soft + reversible: clearing the
   * ban leaves all other history intact. `metadata` snapshots state the ban
   * action mutates (e.g. pre-ban RP) so unban can restore it; it is cleared on
   * unban.
   */
  async setBanState(
    userId: string,
    banned: boolean,
    options: { reason?: string | null; metadata?: Json | null } = {}
  ): Promise<User | null> {
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        is_banned = ${banned},
        banned_at = ${banned ? sql`NOW()` : null},
        ban_reason = ${banned ? options.reason ?? null : null},
        ban_metadata = ${banned ? sql.json((options.metadata ?? null) as Json) : null},
        updated_at = NOW()
      WHERE id = ${userId}
      RETURNING *
    `;
    return user ?? null;
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
    const phoneNumber = normalizeOptionalText(data.phoneNumber);
    const phoneVerifiedAt =
      data.phoneNumber !== undefined && !phoneNumber
        ? null
        : data.phoneVerifiedAt ?? null;
    // Use CASE to only update fields that are explicitly provided (not undefined)
    // undefined = keep existing, null = set to null, value = set to value
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        nickname = CASE WHEN ${data.nickname !== undefined} THEN ${data.nickname ?? null} ELSE nickname END,
        country = CASE WHEN ${data.country !== undefined} THEN ${data.country ?? null} ELSE country END,
        phone_number = CASE WHEN ${data.phoneNumber !== undefined} THEN ${phoneNumber} ELSE phone_number END,
        phone_verified_at = CASE
          WHEN ${data.phoneNumber !== undefined && !phoneNumber} THEN null
          WHEN ${data.phoneVerifiedAt !== undefined} THEN ${phoneVerifiedAt}
          ELSE phone_verified_at
        END,
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
