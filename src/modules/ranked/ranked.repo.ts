import { sql } from '../../db/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type {
  PlacementStatus,
  RankedLeaderboardEntry,
  RankedProfileRow,
  RankedRpChangeRow,
  RankedTier,
  RankedUserRankResult,
} from './ranked.types.js';

interface RankedProfileUpdateInput {
  userId: string;
  rp: number;
  tier: RankedTier;
  placementStatus: PlacementStatus;
  placementPlayed: number;
  placementWins: number;
  placementSeedRp: number | null;
  placementPerfSum: number;
  placementPointsForSum: number;
  placementPointsAgainstSum: number;
  currentWinStreak: number;
}

interface RankedRpChangeInsertInput {
  matchId: string;
  userId: string;
  opponentUserId: string | null;
  opponentIsAi: boolean;
  oldRp: number;
  deltaRp: number;
  newRp: number;
  result: 'win' | 'loss';
  isPlacement: boolean;
  placementGameNo: number | null;
  placementAnchorRp: number | null;
  placementPerfScore: number | null;
  calculationMethod: 'placement_seed' | 'ranked_formula';
}

interface RankedSettlementEntry {
  profile: RankedProfileUpdateInput;
  change: RankedRpChangeInsertInput;
  /** Coin reward granted with the settlement (win/loss participation reward). */
  coinsAwarded: number;
}

export const rankedRepo = {
  async ensureProfile(userId: string): Promise<RankedProfileRow> {
    // SELECT-first: the profile already exists for all but a user's very
    // first ranked touch, and the INSERT .. ON CONFLICT DO NOTHING attempt on
    // every call was pure write-path churn at scale (db-optimize.md #6:
    // ~88k redundant upserts against ~3k rows). The insert below remains the
    // race-safe creation path for first-time users.
    const [preexisting] = await sql<RankedProfileRow[]>`
      SELECT * FROM ranked_profiles WHERE user_id = ${userId}
    `;
    if (preexisting) return preexisting;

    const [row] = await sql<RankedProfileRow[]>`
      INSERT INTO ranked_profiles (
        user_id,
        rp,
        tier,
        placement_status,
        placement_required,
        placement_played,
        placement_wins,
        placement_seed_rp,
        placement_perf_sum,
        placement_points_for_sum,
        placement_points_against_sum,
        current_win_streak,
        last_ranked_match_at
      )
      VALUES (
        ${userId},
        450,
        'Youth Prospect',
        'unplaced',
        3,
        0,
        0,
        NULL,
        0,
        0,
        0,
        0,
        NULL
      )
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *
    `;
    if (row) return row;

    const [existing] = await sql<RankedProfileRow[]>`
      SELECT * FROM ranked_profiles WHERE user_id = ${userId}
    `;
    if (!existing) {
      throw new AppError(
        'Failed to load ranked profile after ensureProfile',
        500,
        ErrorCode.INTERNAL_ERROR,
        { userId }
      );
    }
    return existing;
  },

  async getProfile(userId: string): Promise<RankedProfileRow | null> {
    const [row] = await sql<RankedProfileRow[]>`
      SELECT rp.*, u.country
      FROM ranked_profiles rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.user_id = ${userId}
    `;
    return row ?? null;
  },

  async getProfilesByUserIds(userIds: string[]): Promise<RankedProfileRow[]> {
    if (userIds.length === 0) return [];
    return sql<RankedProfileRow[]>`
      SELECT * FROM ranked_profiles
      WHERE user_id = ANY(${sql.array(userIds)}::uuid[])
    `;
  },

  async getRpChangesForMatch(matchId: string): Promise<RankedRpChangeRow[]> {
    return sql<RankedRpChangeRow[]>`
      SELECT * FROM ranked_rp_changes
      WHERE match_id = ${matchId}
      ORDER BY created_at ASC, user_id ASC
    `;
  },

  async applySettlement(entries: RankedSettlementEntry[]): Promise<void> {
    if (entries.length === 0) return;

    try {
      logger.info({
        entryCount: entries.length,
        matchIds: [...new Set(entries.map((entry) => entry.change.matchId))],
        userIds: entries.map((entry) => entry.change.userId),
      }, 'Ranked settlement DB transaction starting');

      await sql.begin(async (tx) => {
        for (const entry of entries) {
          await tx.unsafe(
            `
            WITH inserted AS (
              INSERT INTO ranked_rp_changes (
                match_id,
                user_id,
                opponent_user_id,
                opponent_is_ai,
                old_rp,
                delta_rp,
                new_rp,
                result,
                is_placement,
                placement_game_no,
                placement_anchor_rp,
                placement_perf_score,
                calculation_method,
                coins_awarded
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $25
              )
              ON CONFLICT (match_id, user_id) DO NOTHING
              RETURNING 1
            ),
            profile_updated AS (
              UPDATE ranked_profiles
              SET
                rp = $14,
                tier = $15,
                placement_status = $16,
                placement_played = $17,
                placement_wins = $18,
                placement_seed_rp = $19,
                placement_perf_sum = $20,
                placement_points_for_sum = $21,
                placement_points_against_sum = $22,
                current_win_streak = $23,
                last_ranked_match_at = NOW(),
                updated_at = NOW()
              WHERE user_id = $24
                AND EXISTS (SELECT 1 FROM inserted)
              RETURNING 1
            )
            -- Coin participation reward (win/loss). Gated on the rp-change
            -- insert so the idempotent re-settlement path never double-pays.
            UPDATE users
            SET
              coins = coins + $25,
              updated_at = NOW()
            WHERE id = $24
              AND $25 > 0
              AND EXISTS (SELECT 1 FROM inserted)
            `,
            [
              entry.change.matchId,
              entry.change.userId,
              entry.change.opponentUserId,
              entry.change.opponentIsAi,
              entry.change.oldRp,
              entry.change.deltaRp,
              entry.change.newRp,
              entry.change.result,
              entry.change.isPlacement,
              entry.change.placementGameNo,
              entry.change.placementAnchorRp,
              entry.change.placementPerfScore,
              entry.change.calculationMethod,
              entry.profile.rp,
              entry.profile.tier,
              entry.profile.placementStatus,
              entry.profile.placementPlayed,
              entry.profile.placementWins,
              entry.profile.placementSeedRp,
              entry.profile.placementPerfSum,
              entry.profile.placementPointsForSum,
              entry.profile.placementPointsAgainstSum,
              entry.profile.currentWinStreak,
              entry.profile.userId,
              entry.coinsAwarded,
            ]
          );
        }
      });

      logger.info({
        entryCount: entries.length,
        matchIds: [...new Set(entries.map((entry) => entry.change.matchId))],
        userIds: entries.map((entry) => entry.change.userId),
      }, 'Ranked settlement DB transaction committed');
    } catch (error) {
      logger.error({
        error,
        entryCount: entries.length,
        entries: entries.map((entry) => ({
          matchId: entry.change.matchId,
          userId: entry.change.userId,
          opponentUserId: entry.change.opponentUserId,
          oldRp: entry.change.oldRp,
          deltaRp: entry.change.deltaRp,
          newRp: entry.change.newRp,
          result: entry.change.result,
          isPlacement: entry.change.isPlacement,
          calculationMethod: entry.change.calculationMethod,
        })),
      }, 'Ranked settlement DB transaction failed');
      throw error;
    }
  },

  /**
   * Admin: set a user's RP + tier to absolute values. Returns the new rp if a
   * ranked_profiles row exists, or null if the user has no profile yet.
   * The RP ledger (ranked_rp_changes) is intentionally NOT written — admin
   * grants are audited separately and are not match-derived RP changes.
   */
  async setRankPoints(userId: string, rp: number, tier: RankedTier): Promise<number | null> {
    const [row] = await sql<{ rp: number }[]>`
      UPDATE ranked_profiles
      SET rp = ${rp}, tier = ${tier}, updated_at = NOW()
      WHERE user_id = ${userId}
      RETURNING rp
    `;
    return row?.rp ?? null;
  },

  /**
   * Admin: reset the leaderboard for an event. Archives every existing ranked
   * profile and RP-change row into the archive tables under a single reset
   * batch, then zeroes out the live ranked_profiles for real users only
   * (excludes AI/seed/deleted). Tier becomes 'Academy' (the rp=0 tier) and all
   * placement progress is cleared so players start fresh. Runs in one
   * transaction so the archive and reset are atomic.
   */
  async resetLeaderboard(actorUserId: string, notes: string | null): Promise<{
    batchId: string;
    profilesArchived: number;
    rpChangesArchived: number;
    profilesReset: number;
  }> {
    return sql.begin(async (tx) => {
      const batchRows = await tx.unsafe<{ id: string }[]>(
        `INSERT INTO ranked_reset_batches (triggered_by, notes) VALUES ($1, $2) RETURNING id`,
        [actorUserId, notes]
      );
      const batchId = batchRows[0].id;

      const archivedProfiles = await tx.unsafe(
        `INSERT INTO ranked_profiles_archive (
          reset_batch_id, user_id, rp, tier, placement_status,
          placement_required, placement_played, placement_wins, placement_seed_rp,
          placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
          current_win_streak, last_ranked_match_at
        )
        SELECT
          $1, user_id, rp, tier, placement_status,
          placement_required, placement_played, placement_wins, placement_seed_rp,
          placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
          current_win_streak, last_ranked_match_at
        FROM ranked_profiles`,
        [batchId]
      );

      const archivedChanges = await tx.unsafe(
        `INSERT INTO ranked_rp_changes_archive (
          reset_batch_id, match_id, user_id, opponent_user_id, opponent_is_ai,
          old_rp, delta_rp, new_rp, result, is_placement, placement_game_no,
          placement_anchor_rp, placement_perf_score, calculation_method, source_created_at
        )
        SELECT
          $1, match_id, user_id, opponent_user_id, opponent_is_ai,
          old_rp, delta_rp, new_rp, result, is_placement, placement_game_no,
          placement_anchor_rp, placement_perf_score, calculation_method, created_at
        FROM ranked_rp_changes`,
        [batchId]
      );

      const resetProfiles = await tx.unsafe(
        `UPDATE ranked_profiles rp
        SET
          rp = 0,
          tier = 'Academy',
          placement_status = 'unplaced',
          placement_played = 0,
          placement_wins = 0,
          placement_seed_rp = NULL,
          placement_perf_sum = 0,
          placement_points_for_sum = 0,
          placement_points_against_sum = 0,
          current_win_streak = 0,
          updated_at = NOW()
        WHERE EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = rp.user_id
            AND u.is_ai = false
            AND u.is_seed = false
            AND u.is_deleted = false
            AND u.deleted_at IS NULL
            AND u.pending_deletion_at IS NULL
        )`,
        []
      );

      await tx.unsafe(
        `UPDATE ranked_reset_batches SET completed_at = NOW() WHERE id = $1`,
        [batchId]
      );

      return {
        batchId,
        profilesArchived: archivedProfiles.count,
        rpChangesArchived: archivedChanges.count,
        profilesReset: resetProfiles.count,
      };
    });
  },

  async listLeaderboard(limit: number, offset: number, country?: string): Promise<RankedLeaderboardEntry[]> {
    if (country) {
      return sql<RankedLeaderboardEntry[]>`
        SELECT
          rp.user_id AS "userId",
          COALESCE(u.nickname, 'Player') AS "username",
          u.avatar_url AS "avatarUrl",
          u.avatar_customization AS "avatarCustomization",
          rp.rp,
          rp.tier,
          u.country,
          COALESCE(trend.wins, 0)::int AS "trendWins",
          COALESCE(trend.total, 0)::int AS "trendTotal"
        FROM ranked_profiles rp
        JOIN users u ON u.id = rp.user_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE sub.result = 'win') AS wins,
            COUNT(*) AS total
          FROM (
            SELECT result FROM ranked_rp_changes
            WHERE user_id = rp.user_id AND is_placement = false
            ORDER BY created_at DESC LIMIT 3
          ) sub
        ) trend ON true
        WHERE u.is_ai = false
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND rp.placement_status = 'placed'
          AND u.country = ${country}
        ORDER BY rp.rp DESC, rp.updated_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    }
    return sql<RankedLeaderboardEntry[]>`
      SELECT
        rp.user_id AS "userId",
        COALESCE(u.nickname, 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        rp.rp,
        rp.tier,
        u.country,
        COALESCE(trend.wins, 0)::int AS "trendWins",
        COALESCE(trend.total, 0)::int AS "trendTotal"
      FROM ranked_profiles rp
      JOIN users u ON u.id = rp.user_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE sub.result = 'win') AS wins,
          COUNT(*) AS total
        FROM (
          SELECT result FROM ranked_rp_changes
          WHERE user_id = rp.user_id AND is_placement = false
          ORDER BY created_at DESC LIMIT 3
        ) sub
      ) trend ON true
      WHERE u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND rp.placement_status = 'placed'
      ORDER BY rp.rp DESC, rp.updated_at ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  },

  async getUserRank(userId: string, country?: string): Promise<RankedUserRankResult | null> {
    const profile = await this.getProfile(userId);
    if (!profile || profile.placement_status !== 'placed') return null;
    if (country && profile.country !== country) return null;

    const countryFilter = country
      ? sql`AND u.country = ${country}`
      : sql``;

    const [result] = await sql<RankedUserRankResult[]>`
      WITH recent_matches AS (
        SELECT result FROM ranked_rp_changes
        WHERE user_id = ${userId} AND is_placement = false
        ORDER BY created_at DESC LIMIT 3
      )
      SELECT
        (SELECT COUNT(*)::int + 1
         FROM ranked_profiles rp2
         JOIN users u ON u.id = rp2.user_id
         WHERE u.is_ai = false
           AND u.is_seed = false
           AND u.is_deleted = false
           AND u.deleted_at IS NULL
           AND u.pending_deletion_at IS NULL
           AND rp2.placement_status = 'placed' ${countryFilter}
           AND (rp2.rp > ${profile.rp} OR (rp2.rp = ${profile.rp} AND rp2.updated_at < ${profile.updated_at}))
        ) AS rank,
        (SELECT COUNT(*)::int
         FROM ranked_profiles rp3
         JOIN users u ON u.id = rp3.user_id
         WHERE u.is_ai = false
           AND u.is_seed = false
           AND u.is_deleted = false
           AND u.deleted_at IS NULL
           AND u.pending_deletion_at IS NULL
           AND rp3.placement_status = 'placed' ${countryFilter}
        ) AS total,
        (SELECT COUNT(*) FILTER (WHERE result = 'win') FROM recent_matches)::int AS "trendWins",
        (SELECT COUNT(*) FROM recent_matches)::int AS "trendTotal"
    `;
    return result ?? null;
  },
};
