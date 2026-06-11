import { sql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';

/**
 * How many recently played categories we remember per (user, mode).
 * Enforced at write time so reads never need a LIMIT/window.
 */
export const RECENT_CATEGORY_LIMIT = 10;

/**
 * Mode value for ranked play (covers the World Cup ranked event — the ranked
 * pool IS the featured/World Cup set). Future events can introduce their own
 * mode value to track recents separately.
 */
export const RANKED_RECENT_CATEGORY_MODE = 'ranked';

export interface UserRecentCategoryRow {
  user_id: string;
  category_id: string;
  played_at: Date;
}

/**
 * Pure-data repo for `user_recent_categories` — the per-user history of
 * categories actually played in ranked matches (recorded only when a drafted
 * category is finalized, never for merely-shown options, never for AI users).
 *
 * Perf contract (ranked draft start is a hot path):
 * - reads hit idx_user_recent_categories_user_mode_played and return at most
 *   RECENT_CATEGORY_LIMIT rows per user (matches have <= 2 users);
 * - writes are a single upsert + a bounded trim, both index-driven.
 */
export const userRecentCategoriesRepo = {
  /**
   * Newest-first recently played categories for a set of users. At most
   * RECENT_CATEGORY_LIMIT rows per user thanks to the write-time cap.
   */
  async listRecentCategoriesForUsers(
    userIds: string[],
    mode: string
  ): Promise<UserRecentCategoryRow[]> {
    if (userIds.length === 0) return [];
    return withSpan('db.user_recent_categories.list_for_users', {
      'db.operation.name': 'select',
      'quizball.user_count': userIds.length,
    }, async (span) => {
      const rows = await sql<UserRecentCategoryRow[]>`
        SELECT user_id, category_id, played_at
        FROM user_recent_categories
        WHERE user_id = ANY(${sql.array(userIds)}::uuid[])
          AND mode = ${mode}
        ORDER BY played_at DESC
      `;
      span.setAttribute('quizball.recent_category_count', rows.length);
      return rows;
    });
  },

  /**
   * Record that `categoryId` was actually played by each user (e.g. both
   * human players of a ranked match once the drafted category is finalized).
   *
   * - Dedupe: replaying a category bumps its played_at to NOW() instead of
   *   creating a duplicate (ON CONFLICT on the unique constraint).
   * - Cap: rows beyond the newest RECENT_CATEGORY_LIMIT per (user, mode) are
   *   trimmed in the same call.
   */
  async recordPlayedCategoryForUsers(params: {
    userIds: string[];
    categoryId: string;
    mode: string;
    limit?: number;
  }): Promise<void> {
    const { userIds, categoryId, mode } = params;
    if (userIds.length === 0) return;
    const limit = params.limit ?? RECENT_CATEGORY_LIMIT;

    await withSpan('db.user_recent_categories.record_played', {
      'db.operation.name': 'insert',
      'quizball.user_count': userIds.length,
      'quizball.category_id': categoryId,
    }, async () => {
      await sql`
        INSERT INTO user_recent_categories (user_id, category_id, mode)
        SELECT uid, ${categoryId}, ${mode}
        FROM unnest(${sql.array(userIds)}::uuid[]) AS uid
        ON CONFLICT ON CONSTRAINT user_recent_categories_user_mode_category_key
        DO UPDATE SET played_at = NOW()
      `;

      // Trim must run as a SEPARATE statement: a CTE DELETE in the insert
      // statement would not see the row inserted above (same-snapshot rule),
      // so the cap would lag one write behind.
      await sql`
        DELETE FROM user_recent_categories
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id
                     ORDER BY played_at DESC, id DESC
                   ) AS rn
            FROM user_recent_categories
            WHERE user_id = ANY(${sql.array(userIds)}::uuid[])
              AND mode = ${mode}
          ) ranked
          WHERE rn > ${limit}
        )
      `;
    });
  },
};
