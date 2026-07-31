import { sql, type TransactionSql } from '../../db/index.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { tierFromRp } from './ranked.service.js';
import type {
  PlacementStatus,
  RankedLeaderboardEntry,
  ArchivedRankedUserRankResult,
  RankedProfileRow,
  RankedRpChangeRow,
  RankedTier,
  RankedSeason,
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
  /**
   * Weekend League QP earned by this result, or 0 for non-humans. Lands only
   * when qpWeekKey is set (the match ended inside the Mon–Fri GE accrual
   * window — derived from matches.ended_at, never from wall-clock at
   * settlement time, so replays of old matches credit the correct week).
   */
  qpAwarded: number;
  qpWeekKey: string | null;
  /** matches.ended_at — QP totals record when the match was PLAYED. */
  qpEndedAt: Date | null;
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

  /**
   * @param occurredAt  Optional backdated timestamp for the ledger row's
   *   created_at and the profile's last_ranked_match_at/updated_at. Defaults to
   *   NOW() so the LIVE settlement path is byte-identical. ONLY the one-time
   *   persistent-bot burn-in writer passes an explicit historical value.
   *
   * @returns the user_ids whose ledger row THIS call actually inserted. A caller
   *   racing another settlement of the same match loses the ON CONFLICT and gets
   *   those users back OMITTED, so post-write side effects (analytics, governor)
   *   fire exactly once per settled participant instead of once per replica.
   *   Participants skipped as finalized accounts are omitted too.
   */
  async applySettlement(entries: RankedSettlementEntry[], occurredAt?: Date): Promise<Set<string>> {
    const appliedUserIds = new Set<string>();
    if (entries.length === 0) return appliedUserIds;

    try {
      logger.info({
        entryCount: entries.length,
        matchIds: [...new Set(entries.map((entry) => entry.change.matchId))],
        userIds: entries.map((entry) => entry.change.userId),
      }, 'Ranked settlement DB transaction starting');

      await sql.begin(async (tx) => {
        // Serialize against finalize_pending_account_deletions(), which holds
        // `SELECT ... FOR UPDATE` on public.users while it anonymizes the account
        // and zeroes its ranked_profiles row. Locking the same rows here means the
        // two can only run one after the other, so the recheck below sees a
        // settled truth rather than a torn one.
        //
        // Ordered by user_id (and locked in ONE statement) so two concurrent
        // settlements touching the same pair of users always take the locks in the
        // same order and cannot deadlock.
        const lockedUserIds = [...new Set(entries.map((entry) => entry.change.userId))].sort();
        // postgres.js types TransactionSql via Omit<Sql, …>, which drops the
        // tagged-template call signatures; the runtime object still supports them.
        const txSql = tx as unknown as typeof sql;
        const activeRows = await txSql<{ id: string }[]>`
          SELECT id FROM users
          WHERE id = ANY(${sql.array(lockedUserIds)}::uuid[])
            AND is_deleted = false
            AND deleted_at IS NULL
          ORDER BY id
          FOR UPDATE
        `;
        const activeUserIds = new Set(activeRows.map((row) => row.id));

        for (const entry of entries) {
          // The account was finalized between the eligibility read and this
          // transaction. Skip ONLY this participant — the opponent's settlement is
          // independent and must still land.
          if (!activeUserIds.has(entry.change.userId)) {
            // Re-assert the zeroed standing finalization applied. The
            // pre-transaction ensureProfile may have re-created (or the eligibility
            // read may have raced) a profile for this account AFTER finalization's
            // own reset ran, which would leave a fresh 450-RP "Youth Prospect"
            // ghost on a deleted player — the exact thing this guard prevents.
            // Same field list as finalization / the season rollover.
            await txSql`
              UPDATE ranked_profiles
              SET rp = 0, tier = 'Academy', placement_status = 'unplaced',
                  placement_played = 0, placement_wins = 0, placement_seed_rp = NULL,
                  placement_perf_sum = 0, placement_points_for_sum = 0,
                  placement_points_against_sum = 0, current_win_streak = 0,
                  updated_at = NOW()
              WHERE user_id = ${entry.change.userId}
                AND (rp <> 0 OR tier <> 'Academy' OR placement_status <> 'unplaced'
                  OR placement_played <> 0 OR placement_wins <> 0
                  OR placement_seed_rp IS NOT NULL OR placement_perf_sum <> 0
                  OR placement_points_for_sum <> 0 OR placement_points_against_sum <> 0
                  OR current_win_streak <> 0)
            `;
            logger.warn({
              matchId: entry.change.matchId,
              userId: entry.change.userId,
            }, 'Ranked settlement skipped participant: account finalized before the write');
            continue;
          }
          const appliedRows = await tx.unsafe<{ applied: boolean }[]>(
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
                coins_awarded,
                created_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $25,
                COALESCE($26::timestamptz, NOW())
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
                last_ranked_match_at = COALESCE($26::timestamptz, NOW()),
                updated_at = COALESCE($26::timestamptz, NOW())
              WHERE user_id = $24
                AND EXISTS (SELECT 1 FROM inserted)
              RETURNING 1
            ),
            -- Coin participation reward (win/loss). Gated on the rp-change
            -- insert so the idempotent re-settlement path never double-pays.
            coins_awarded AS (
              UPDATE users
              SET
                coins = coins + $25,
                updated_at = COALESCE($26::timestamptz, NOW())
              WHERE id = $24
                AND $25 > 0
                AND EXISTS (SELECT 1 FROM inserted)
              RETURNING 1
            ),
            -- Weekend League QP ledger. SELECT ... FROM inserted (not VALUES +
            -- ON CONFLICT WHERE): an upsert's insert branch would fire even
            -- when "inserted" is empty, breaking exactly-once on re-settlement.
            qp_award AS (
              INSERT INTO wl_qp_awards (match_id, user_id, week_key, points, result)
              SELECT $1, $2, $27::date, $28::int, $8
              FROM inserted
              WHERE $28::int > 0 AND $27::date IS NOT NULL
              ON CONFLICT (match_id, user_id) DO NOTHING
              RETURNING points
            ),
            -- Totals read-model, advanced only by the award row this statement
            -- actually inserted (rebuildable from the ledger at any time).
            qp_total AS (
              INSERT INTO wl_qp AS t (week_key, user_id, points, wins, losses, last_match_at)
              SELECT $27::date, $2, qa.points,
                     CASE WHEN $8 = 'win' THEN 1 ELSE 0 END,
                     CASE WHEN $8 = 'loss' THEN 1 ELSE 0 END,
                     COALESCE($29::timestamptz, $26::timestamptz, NOW())
              FROM qp_award qa
              ON CONFLICT (week_key, user_id) DO UPDATE SET
                points = t.points + EXCLUDED.points,
                wins = t.wins + EXCLUDED.wins,
                losses = t.losses + EXCLUDED.losses,
                last_match_at = GREATEST(t.last_match_at, EXCLUDED.last_match_at)
              RETURNING 1
            )
            -- Did THIS statement insert the ledger row? Lets the caller fire the
            -- post-write side effects exactly once per settled participant.
            SELECT EXISTS (SELECT 1 FROM inserted) AS applied
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
              occurredAt ?? null,
              entry.qpWeekKey,
              entry.qpAwarded,
              entry.qpEndedAt ?? null,
            ]
          );
          if (appliedRows[0]?.applied === true) {
            appliedUserIds.add(entry.change.userId);
          }
        }
      });

      logger.info({
        entryCount: entries.length,
        matchIds: [...new Set(entries.map((entry) => entry.change.matchId))],
        userIds: entries.map((entry) => entry.change.userId),
        appliedUserIds: [...appliedUserIds],
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

    return appliedUserIds;
  },

  /**
   * WL QP repair: award QP from the EXISTING RP ledger for a match whose RP
   * settled without QP (rows written before the QP feature deployed, or the
   * already-settled side of a partial settlement — the live path's qp_award
   * CTE only fires for newly inserted RP rows). Idempotent: the award PK
   * makes replays no-ops, and totals advance only from rows this call
   * actually inserted.
   */
  async repairQpFromLedger(input: {
    matchId: string;
    weekKey: string;
    endedAt: Date;
    userIds: string[];
    winPoints: number;
    lossPoints: number;
  }): Promise<number> {
    if (input.userIds.length === 0) return 0;
    const rows = await sql<{ user_id: string }[]>`
      WITH repaired AS (
        INSERT INTO wl_qp_awards (match_id, user_id, week_key, points, result)
        SELECT rc.match_id, rc.user_id, ${input.weekKey}::date,
               CASE WHEN rc.result = 'win' THEN ${input.winPoints}::int ELSE ${input.lossPoints}::int END,
               rc.result
        FROM ranked_rp_changes rc
        WHERE rc.match_id = ${input.matchId}
          AND rc.user_id = ANY(${sql.array(input.userIds)}::uuid[])
          AND rc.result IN ('win', 'loss')
        ON CONFLICT (match_id, user_id) DO NOTHING
        RETURNING user_id, points, result
      )
      INSERT INTO wl_qp AS t (week_key, user_id, points, wins, losses, last_match_at)
      SELECT ${input.weekKey}::date, r.user_id, r.points,
             CASE WHEN r.result = 'win' THEN 1 ELSE 0 END,
             CASE WHEN r.result = 'loss' THEN 1 ELSE 0 END,
             ${input.endedAt}
      FROM repaired r
      ON CONFLICT (week_key, user_id) DO UPDATE SET
        points = t.points + EXCLUDED.points,
        wins = t.wins + EXCLUDED.wins,
        losses = t.losses + EXCLUDED.losses,
        last_match_at = GREATEST(t.last_match_at, EXCLUDED.last_match_at)
      RETURNING user_id
    `;
    return rows.length;
  },

  /**
   * QP payload for a settled match: per-user points from the award ledger
   * joined with the player's CURRENT weekly total (post-settlement read).
   */
  async getQpForMatchUsers(
    matchId: string,
    userIds: string[]
  ): Promise<Array<{ user_id: string; points: number; week_total: number }>> {
    if (userIds.length === 0) return [];
    return sql<Array<{ user_id: string; points: number; week_total: number }>>`
      SELECT a.user_id, a.points,
             COALESCE(
               q.points,
               (SELECT SUM(l.points)::int FROM wl_qp_awards l
                WHERE l.week_key = a.week_key AND l.user_id = a.user_id)
             ) AS week_total
      FROM wl_qp_awards a
      LEFT JOIN wl_qp q ON q.week_key = a.week_key AND q.user_id = a.user_id
      WHERE a.match_id = ${matchId}
        AND a.user_id = ANY(${sql.array(userIds)}::uuid[])
    `;
  },

  /**
   * Admin: set a user's RP + tier to absolute values. Returns the new rp if a
   * ranked_profiles row exists, or null if the user has no profile yet.
   * The RP ledger (ranked_rp_changes) is intentionally NOT written — admin
   * grants are audited separately and are not match-derived RP changes.
   */
  async setRankPoints(
    userId: string,
    rp: number,
    tier: RankedTier,
    tx?: TransactionSql
  ): Promise<number | null> {
    // Optional tx so an admin edit can commit the RP write atomically with its
    // audit rows (bot tuning PATCH); postgres.js drops the tagged-template
    // signature from TransactionSql, hence the cast (see the note above).
    const db = (tx as unknown as typeof sql) ?? sql;
    const [row] = await db<{ rp: number }[]>`
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
   * batch, then zeroes out the live ranked_profiles for settle-eligible users —
   * real humans plus persistent roster bots (excludes ephemeral/auction AI, seed,
   * deleted). Tier becomes 'Academy' (the rp=0 tier) and all
   * placement progress is cleared so players start fresh. Runs in one
   * transaction so the archive and reset are atomic.
   */
  async resetLeaderboard(
    actorUserId: string,
    notes: string | null,
    seasonNumber: number | null = null
  ): Promise<{
    batchId: string;
    profilesArchived: number;
    rpChangesArchived: number;
    profilesReset: number;
  }> {
    return sql.begin(async (tx) => {
      const batchRows = await tx.unsafe<{ id: string }[]>(
        `INSERT INTO ranked_reset_batches (triggered_by, notes, season_number) VALUES ($1, $2, $3) RETURNING id`,
        [actorUserId, notes, seasonNumber]
      );
      const batchId = batchRows[0].id;

      // The archive snapshots only the profiles the reset will actually zero —
      // settle-eligible users (humans + persistent bots), excluding seed/deleted/
      // pending-deletion — so it matches the live-reset predicate below and never
      // retains rows that were never reset.
      const archivedProfiles = await tx.unsafe(
        `INSERT INTO ranked_profiles_archive (
          reset_batch_id, user_id, rp, tier, placement_status,
          placement_required, placement_played, placement_wins, placement_seed_rp,
          placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
          current_win_streak, last_ranked_match_at
        )
        SELECT
          $1, rp.user_id, rp.rp, rp.tier, rp.placement_status,
          rp.placement_required, rp.placement_played, rp.placement_wins, rp.placement_seed_rp,
          rp.placement_perf_sum, rp.placement_points_for_sum, rp.placement_points_against_sum,
          rp.current_win_streak, rp.last_ranked_match_at
        FROM ranked_profiles rp
        WHERE EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = rp.user_id
            AND (u.is_ai = false OR u.ai_kind = 'persistent')
            AND u.is_seed = false
            AND u.is_deleted = false
            AND u.deleted_at IS NULL
            AND u.pending_deletion_at IS NULL
        )`,
        [batchId]
      );

      const archivedChanges = await tx.unsafe(
        `INSERT INTO ranked_rp_changes_archive (
          reset_batch_id, match_id, user_id, opponent_user_id, opponent_is_ai,
          old_rp, delta_rp, new_rp, result, is_placement, placement_game_no,
          placement_anchor_rp, placement_perf_score, calculation_method, source_created_at
        )
        SELECT
          $1, rc.match_id, rc.user_id, rc.opponent_user_id, rc.opponent_is_ai,
          rc.old_rp, rc.delta_rp, rc.new_rp, rc.result, rc.is_placement, rc.placement_game_no,
          rc.placement_anchor_rp, rc.placement_perf_score, rc.calculation_method, rc.created_at
        FROM ranked_rp_changes rc
        WHERE EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = rc.user_id
            AND (u.is_ai = false OR u.ai_kind = 'persistent')
            AND u.is_seed = false
            AND u.is_deleted = false
            AND u.deleted_at IS NULL
            AND u.pending_deletion_at IS NULL
        )`,
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
            AND (u.is_ai = false OR u.ai_kind = 'persistent')
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
        WHERE (u.is_ai = false OR u.ai_kind = 'persistent')
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
      WHERE (u.is_ai = false OR u.ai_kind = 'persistent')
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

  async listSeasons(): Promise<RankedSeason[]> {
    // Only batches stamped with a season_number are seasons — boundary resets
    // (e.g. the pre-event zeroing) keep NULL and stay out of the public list.
    return sql<RankedSeason[]>`
      SELECT
        id,
        season_number AS "seasonNumber",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM ranked_reset_batches
      WHERE completed_at IS NOT NULL
        AND season_number IS NOT NULL
      ORDER BY season_number ASC
    `;
  },

  /** Newest-first. Two rows bound both the current season (start) and the
   *  previous season (start + end); older seasons never affect the split. */
  async listRecentCompletedSeasonResets(): Promise<Array<{
    seasonNumber: number;
    completedAt: string;
  }>> {
    return sql<Array<{ seasonNumber: number; completedAt: string }>>`
      SELECT
        season_number AS "seasonNumber",
        completed_at AS "completedAt"
      FROM ranked_reset_batches
      WHERE completed_at IS NOT NULL
        AND season_number IS NOT NULL
      ORDER BY season_number DESC
      LIMIT 2
    `;
  },

  async listArchivedLeaderboard(
    batchId: string,
    limit: number,
    offset: number,
    country?: string
  ): Promise<RankedLeaderboardEntry[]> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
    return sql<RankedLeaderboardEntry[]>`
      SELECT
        rp.user_id AS "userId",
        COALESCE(u.nickname, 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        rp.rp,
        rp.tier,
        u.country,
        0::int AS "trendWins",
        0::int AS "trendTotal"
      FROM ranked_profiles_archive rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.reset_batch_id = ${batchId}
        AND (u.is_ai = false OR u.ai_kind = 'persistent')
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND rp.placement_status = 'placed'
        ${countryFilter}
      ORDER BY rp.rp DESC, rp.last_ranked_match_at ASC NULLS LAST, rp.user_id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  },

  async getArchivedUserRank(
    batchId: string,
    userId: string,
    country?: string
  ): Promise<ArchivedRankedUserRankResult | null> {
    const countryFilter = country ? sql`AND u.country = ${country}` : sql``;
    const [result] = await sql<ArchivedRankedUserRankResult[]>`
      WITH eligible AS (
        SELECT rp.user_id, rp.rp, rp.tier
        FROM ranked_profiles_archive rp
        JOIN users u ON u.id = rp.user_id
        WHERE rp.reset_batch_id = ${batchId}
          AND (u.is_ai = false OR u.ai_kind = 'persistent')
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND rp.placement_status = 'placed'
          ${countryFilter}
      ), target AS (
        SELECT rp, tier FROM eligible WHERE user_id = ${userId}
      )
      SELECT
        (SELECT COUNT(*)::int + 1 FROM eligible WHERE rp > target.rp) AS rank,
        (SELECT COUNT(*)::int FROM eligible) AS total,
        0::int AS "trendWins",
        0::int AS "trendTotal",
        target.rp,
        target.tier
      FROM target
    `;
    return result ?? null;
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
         WHERE (u.is_ai = false OR u.ai_kind = 'persistent')
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
         WHERE (u.is_ai = false OR u.ai_kind = 'persistent')
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

  /**
   * Directly deduct RP from a user as an early-forfeit abuse penalty and log
   * it in ranked_rp_changes. Unlike normal settlement, this is NOT match-
   * derived — it's a punitive deduction for serial early-forfeit abuse.
   *
   * The deduction is floored at 0 so it never violates the rp >= 0 CHECK on
   * ranked_profiles; the ledger row records the actual amount removed, and the
   * tier is recomputed to stay consistent with the new rp. Returns null if the
   * user has no ranked profile (nothing to deduct).
   */
  async applyEarlyForfeitRpPenalty(
    userId: string,
    matchId: string,
    penaltyRp: number
  ): Promise<{ oldRp: number; newRp: number } | null> {
    return sql.begin(async (tx) => {
      const profileRows = await tx.unsafe<{ rp: number }[]>(
        `SELECT rp FROM ranked_profiles WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      if (!profileRows || profileRows.length === 0) return null;

      const oldRp = profileRows[0].rp;
      const newRp = Math.max(0, oldRp - penaltyRp);
      const actualDelta = newRp - oldRp;
      const newTier = tierFromRp(newRp);

      // Insert the ledger row first and gate the profile update on whether it
      // actually inserted — mirrors applySettlement's idempotency pattern so a
      // replayed penalty (same match_id + user_id) doesn't double-deduct RP.
      const inserted = await tx.unsafe(
        `INSERT INTO ranked_rp_changes (
          match_id, user_id, opponent_user_id, opponent_is_ai,
          old_rp, delta_rp, new_rp, result, is_placement,
          placement_game_no, placement_anchor_rp, placement_perf_score,
          calculation_method, coins_awarded
        )
        VALUES ($1, $2, NULL, false, $3, $4, $5, 'loss', false, NULL, NULL, NULL, 'ranked_formula', 0)
        ON CONFLICT (match_id, user_id) DO NOTHING
        RETURNING 1`,
        [matchId, userId, oldRp, actualDelta, newRp]
      );

      if (!inserted || inserted.length === 0) {
        // Ledger row already existed — this penalty was already applied in a
        // previous run. Don't touch RP again; return the current value.
        return { oldRp, newRp: oldRp };
      }

      await tx.unsafe(
        `UPDATE ranked_profiles SET rp = $1, tier = $2, updated_at = NOW() WHERE user_id = $3`,
        [newRp, newTier, userId]
      );

      return { oldRp, newRp };
    });
  },
};
