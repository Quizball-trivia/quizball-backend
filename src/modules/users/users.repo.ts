import { sql, type TransactionSql } from '../../db/index.js';
import type { Json, User } from '../../db/types.js';
import type { AvatarCustomization } from './avatar-customization.js';

/** Free nickname changes before the cooldown applies. */
export const NICKNAME_FREE_CHANGES = 2;
/** Rolling cooldown between changes once the free allowance is spent. */
export const NICKNAME_COOLDOWN_DAYS = 30;
/** How long a vacated nickname stays reserved against other users. */
export const NICKNAME_RESERVATION_DAYS = 30;

export type NicknameChangeSource = 'user' | 'signup' | 'admin' | 'system';

export interface NicknameHistoryEntry {
  nickname: string;
  changedAt: string;
}

export interface NicknameQuota {
  /** Counted changes already spent. */
  countedChanges: number;
  /** When the cooldown lifts, or null when a change is available now. */
  nextChangeAt: string | null;
}

export type AiKind = 'ephemeral' | 'persistent' | 'auction';

export interface CreateUserData {
  email?: string | null;
  phoneNumber?: string | null;
  phoneVerifiedAt?: string | null;
  nickname?: string | null;
  country?: string | null;
  avatarUrl?: string | null;
  avatarCustomization?: AvatarCustomization | null;
  isAi?: boolean;
  aiKind?: AiKind;
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
   * Case-insensitive nickname existence check among name-holding users: active
   * real users plus persistent roster bots (whose names must block signups —
   * a human registering a roster bot's exact name would out the bot). Backed by
   * the partial unique index `uq_users_lower_nickname_claimable`, so this is an
   * O(log n) index lookup even at high user counts.
   */
  async isNicknameTaken(nickname: string, excludeUserId?: string): Promise<boolean> {
    const trimmed = nickname.trim();
    if (trimmed.length === 0) return false;
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM users
        WHERE lower(nickname) = lower(${trimmed})
          AND (is_ai = false OR ai_kind = 'persistent')
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
   * Freed-name reservation: a nickname another user vacated within
   * NICKNAME_RESERVATION_DAYS is not immediately claimable.
   *
   * Publishing rename history makes vacated names discoverable, so without this
   * an attacker could watch a well-known player rename, grab the old name, and
   * have the victim's own profile read "previously known as <attacker>".
   *
   * Scoped to OTHER users: the original holder can always reclaim their own
   * former name (A held Foo -> B took and vacated Foo -> A may take Foo back).
   */
  async isNicknameReserved(nickname: string, requesterUserId: string): Promise<boolean> {
    const trimmed = nickname.trim();
    if (trimmed.length === 0) return false;
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM nickname_history AS other
        WHERE lower(other.old_nickname) = lower(${trimmed})
          AND other.user_id <> ${requesterUserId}
          AND other.changed_at > now() - (${NICKNAME_RESERVATION_DAYS}::int * INTERVAL '1 day')
          -- A name the requester themselves once held is always reclaimable,
          -- even if someone else has since used and vacated it
          -- (A holds Foo -> B takes and vacates Foo -> A may take Foo back).
          AND NOT EXISTS (
            SELECT 1 FROM nickname_history AS mine
            WHERE mine.user_id = ${requesterUserId}
              AND lower(mine.old_nickname) = lower(${trimmed})
          )
        LIMIT 1
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  },

  /**
   * Batch lookup: returns the subset of input nicknames already taken by
   * active name-holding users — real users (non-seed) plus persistent roster
   * bots, lowercased. Seed leaderboard users must not block ranked AI nickname
   * selection, but roster bots must: an ephemeral opponent spawning with a
   * roster bot's exact name would show two identical players. Uses the partial
   * index on lower(nickname) — single query, O((k + matches) log n).
   */
  async findTakenLowerNicknames(nicknames: string[]): Promise<Set<string>> {
    if (nicknames.length === 0) return new Set();
    const lowered = nicknames.map((name) => name.toLowerCase());
    const rows = await sql<{ lower_nickname: string }[]>`
      SELECT lower(nickname) AS lower_nickname FROM users
      WHERE lower(nickname) = ANY(${lowered}::text[])
        AND (is_ai = false OR ai_kind = 'persistent')
        AND is_seed = false
        AND is_deleted = false
        AND deleted_at IS NULL
        AND pending_deletion_at IS NULL
    `;
    return new Set(rows.map((row) => row.lower_nickname));
  },

  async create(data: CreateUserData): Promise<User> {
    const phoneNumber = normalizeOptionalText(data.phoneNumber);
    const isAi = data.isAi ?? false;
    const aiKind = isAi ? data.aiKind ?? 'ephemeral' : null;
    const [user] = await sql<User[]>`
      INSERT INTO users (id, email, phone_number, phone_verified_at, nickname, country, avatar_url, avatar_customization, onboarding_complete, is_ai, ai_kind)
      VALUES (gen_random_uuid(), ${data.email ?? null}, ${phoneNumber}, ${phoneNumber ? data.phoneVerifiedAt ?? null : null}, ${data.nickname ?? null}, ${data.country ?? null}, ${data.avatarUrl ?? null}, ${sql.json((data.avatarCustomization ?? null) as Json)}, false, ${isAi}, ${aiKind})
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

      // An OAuth provider's identity.name is the user's real name, not a handle
      // they chose. Mark it here, in the same transaction as the account, so it
      // can never later be published as a "previously known as" entry. A
      // best-effort write after the fact would leave accounts permanently
      // unprotected whenever it failed.
      if (userData.nickname) {
        await tx.unsafe(
          `INSERT INTO nickname_history
             (user_id, old_nickname, new_nickname, changed_by, counted, identity_derived)
           VALUES ($1, NULL, $2, 'signup', false, true)`,
          [user.id, userData.nickname]
        );
      }

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
      WHERE (u.is_ai = false OR u.ai_kind = 'persistent')
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
        -- Preserve the original banned_at across re-bans (idempotent retries /
        -- reason refreshes); only stamp it on the first transition into banned.
        banned_at = ${banned ? sql`COALESCE(banned_at, NOW())` : null},
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
      DELETE FROM users
      WHERE id = ${id}
        AND is_ai = true
        AND ai_kind IN ('ephemeral', 'auction')
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
    // AI users are excluded: account deletion is a human-account flow, and letting it
    // schedule a synthetic user would give deletion automation a path to roster bots.
    const [user] = await sql<User[]>`
      UPDATE users
      SET
        deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
        pending_deletion_at = COALESCE(pending_deletion_at, NOW() + INTERVAL '30 days'),
        updated_at = CASE WHEN pending_deletion_at IS NULL THEN NOW() ELSE updated_at END
      WHERE id = ${id}
        AND is_ai = false
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

  /**
   * Atomically bump the rolling 24h early-forfeit counter for a user and
   * return the new count. The window opens on the first early forfeit and
   * stays open for 24h; the next early forfeit after expiry resets the
   * counter to 1 and opens a fresh window.
   *
   * Used by the ranked early-forfeit penalty: 4+ early-forfeits in the
   * window trigger a 100 RP deduction and skip the ticket refund.
   */
  async bumpEarlyForfeitCount(userId: string, matchId: string): Promise<number> {
    return sql.begin(async (tx) => {
      const inserted = await tx.unsafe<{ match_id: string }[]>(
        `INSERT INTO ranked_early_forfeit_events (match_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (match_id, user_id) DO NOTHING
         RETURNING match_id`,
        [matchId, userId]
      );

      if (inserted.length > 0) {
        const rows = await tx.unsafe<{ early_forfeit_count: number }[]>(
          `UPDATE users
           SET
             early_forfeit_count = CASE
               WHEN early_forfeit_window_started_at IS NULL
                 OR early_forfeit_window_started_at <= NOW() - INTERVAL '24 hours'
               THEN 1
               ELSE early_forfeit_count + 1
             END,
             early_forfeit_window_started_at = CASE
               WHEN early_forfeit_window_started_at IS NULL
                 OR early_forfeit_window_started_at <= NOW() - INTERVAL '24 hours'
               THEN NOW()
               ELSE early_forfeit_window_started_at
             END,
             updated_at = NOW()
           WHERE id = $1
           RETURNING early_forfeit_count`,
          [userId]
        );
        return rows[0]?.early_forfeit_count ?? 0;
      }

      const rows = await tx.unsafe<{ early_forfeit_count: number }[]>(
        `SELECT early_forfeit_count FROM users WHERE id = $1`,
        [userId]
      );
      return rows[0]?.early_forfeit_count ?? 0;
    });
  },

  /**
   * Current quota state, derived from nickname_history (the single source of
   * truth — there are deliberately no counter columns on `users`).
   * Read-only; used to shape responses and error payloads, never to authorize a
   * change (that decision is made atomically in changeNicknameInTx).
   */
  async getNicknameQuota(userId: string): Promise<NicknameQuota> {
    const rows = await sql<{ counted_changes: number; last_counted_at: Date | null }[]>`
      SELECT
        COUNT(*)::int AS counted_changes,
        MAX(changed_at) AS last_counted_at
      FROM nickname_history
      WHERE user_id = ${userId} AND counted
    `;
    const countedChanges = rows[0]?.counted_changes ?? 0;
    const lastCountedAt = rows[0]?.last_counted_at ?? null;

    if (countedChanges < NICKNAME_FREE_CHANGES || !lastCountedAt) {
      return { countedChanges, nextChangeAt: null };
    }
    const next = new Date(lastCountedAt.getTime() + NICKNAME_COOLDOWN_DAYS * 86_400_000);
    return {
      countedChanges,
      nextChangeAt: next.getTime() > Date.now() ? next.toISOString() : null,
    };
  },

  /** Publishable previous nicknames, newest first. */
  async getPublicNicknameHistory(userId: string, limit = 10): Promise<NicknameHistoryEntry[]> {
    const rows = await sql<{ nickname: string; changed_at: Date }[]>`
      SELECT old_nickname AS nickname, changed_at
      FROM nickname_history
      WHERE user_id = ${userId}
        AND counted
        AND old_nickname IS NOT NULL
      ORDER BY changed_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      nickname: row.nickname,
      changedAt: row.changed_at.toISOString(),
    }));
  },

  /**
   * Atomically apply a nickname change and log it.
   *
   * Enforcement lives in SQL, not JS: a read-then-write would let two concurrent
   * PUT /users/me calls both observe `counted < FREE` and double-spend the
   * quota (there is no rate limiting on that route). The row lock on `users`
   * serializes same-user writers, so the second transaction only evaluates its
   * gate after the first has committed its history row.
   *
   * Returns null when the quota gate rejected the change; the caller turns that
   * into NICKNAME_CHANGE_COOLDOWN.
   */
  async changeNicknameInTx(params: {
    userId: string;
    oldNickname: string | null;
    newNickname: string;
    changedBy: NicknameChangeSource;
    counted: boolean;
  }): Promise<User | null> {
    const { userId, oldNickname, newNickname, changedBy, counted } = params;
    // User-driven renames are never identity-derived; only createWithIdentity
    // writes those rows.
    const identityDerived = false;

    return sql.begin(async (tx: TransactionSql) => {
      // Serializes concurrent renames of THIS user. Must come first: the gate
      // below reads nickname_history, which this lock does not itself cover.
      await tx.unsafe(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

      if (counted) {
        const gated = await tx.unsafe<{ id: string }[]>(
          `INSERT INTO nickname_history
             (user_id, old_nickname, new_nickname, changed_by, counted, identity_derived)
           SELECT $1, $2, $3, $4, true, $5
           WHERE (SELECT count(*) FROM nickname_history WHERE user_id = $1 AND counted) < $6
              OR (SELECT max(changed_at) FROM nickname_history WHERE user_id = $1 AND counted)
                 <= now() - ($7::int * INTERVAL '1 day')
           RETURNING id`,
          [userId, oldNickname, newNickname, changedBy, identityDerived,
           NICKNAME_FREE_CHANGES, NICKNAME_COOLDOWN_DAYS]
        );
        // Gate rejected: no quota left and the cooldown has not elapsed.
        if (gated.length === 0) return null;
      } else {
        await tx.unsafe(
          `INSERT INTO nickname_history
             (user_id, old_nickname, new_nickname, changed_by, counted, identity_derived)
           VALUES ($1, $2, $3, $4, false, $5)`,
          [userId, oldNickname, newNickname, changedBy, identityDerived]
        );
      }

      const rows = await tx.unsafe<User[]>(
        `UPDATE users SET nickname = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [userId, newNickname]
      );
      return rows[0] ?? null;
    });
  },

  /** True once the one-shot onboarding naming pass has been consumed. */
  async hasConsumedSignupNaming(userId: string): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM nickname_history
        WHERE user_id = ${userId} AND changed_by = 'signup'
        LIMIT 1
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  },

  /** The user's OAuth identity-derived name, if any — never publishable. */
  async getIdentityDerivedNickname(userId: string): Promise<string | null> {
    const rows = await sql<{ new_nickname: string }[]>`
      SELECT new_nickname FROM nickname_history
      WHERE user_id = ${userId} AND identity_derived
      ORDER BY changed_at ASC
      LIMIT 1
    `;
    return rows[0]?.new_nickname ?? null;
  },
};
