import { sql } from '../../db/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import type {
  PlacementStatus,
  RankedLeaderboardEntry,
  RankedProfileRow,
  RankedRpChangeRow,
  RankedTier,
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
}

export const rankedRepo = {
  async ensureProfile(userId: string): Promise<RankedProfileRow> {
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
        1200,
        'Rotation',
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
      SELECT * FROM ranked_profiles WHERE user_id = ${userId}
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
              calculation_method
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
            )
            ON CONFLICT (match_id, user_id) DO NOTHING
            RETURNING 1
          )
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
          ]
        );
      }
    });
  },

  async listLeaderboard(limit: number, offset: number, country?: string): Promise<RankedLeaderboardEntry[]> {
    if (country) {
      return sql<RankedLeaderboardEntry[]>`
        SELECT
          rp.user_id AS "userId",
          COALESCE(u.nickname, 'Player') AS "username",
          u.avatar_url AS "avatarUrl",
          rp.rp,
          rp.tier,
          u.country
        FROM ranked_profiles rp
        JOIN users u ON u.id = rp.user_id
        WHERE u.is_ai = false AND rp.placement_status = 'placed' AND u.country = ${country}
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
        rp.rp,
        rp.tier,
        u.country
      FROM ranked_profiles rp
      JOIN users u ON u.id = rp.user_id
      WHERE u.is_ai = false AND rp.placement_status = 'placed'
      ORDER BY rp.rp DESC, rp.updated_at ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  },

  async getUserRank(userId: string, country?: string): Promise<{ rank: number; total: number } | null> {
    const profile = await this.getProfile(userId);
    if (!profile || profile.placement_status !== 'placed') return null;

    const countryFilter = country
      ? sql`AND u.country = ${country}`
      : sql``;

    const [result] = await sql<{ rank: number; total: number }[]>`
      SELECT
        (SELECT COUNT(*)::int + 1
         FROM ranked_profiles rp2
         JOIN users u ON u.id = rp2.user_id
         WHERE u.is_ai = false AND rp2.placement_status = 'placed' ${countryFilter}
           AND (rp2.rp > ${profile.rp} OR (rp2.rp = ${profile.rp} AND rp2.updated_at < ${profile.updated_at}))
        ) AS rank,
        (SELECT COUNT(*)::int
         FROM ranked_profiles rp3
         JOIN users u ON u.id = rp3.user_id
         WHERE u.is_ai = false AND rp3.placement_status = 'placed' ${countryFilter}
        ) AS total
    `;
    return result ?? null;
  },
};
