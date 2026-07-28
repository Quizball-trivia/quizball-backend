/**
 * Data access for the rubber-band governor (PR9).
 *
 * Three concerns, all narrow:
 *   - read/write a bot's governor state on synthetic_player_profiles
 *   - the HUMAN top-10 RP threshold that drives top-protection
 *   - the telemetry aggregate behind the ops endpoint
 */

import { sql } from '../../../db/index.js';
import { withSpan } from '../../../core/tracing.js';
import type { GovernorState } from './governor-state-machine.js';

export interface GovernorStateRow {
  governor_adjustment: number;
  winrate_ema: number | null;
  winrate_samples: number;
  governor_updated_at: string | null;
  governor_samples_at_adjustment: number;
}

/** Per-day bot-vs-human totals, straight off the persistent_bot_daily_winrate view. */
export interface BotDailyWinrateRow {
  georgiaDay: string;
  botWins: number;
  botLosses: number;
  totalMatches: number;
  distinctBots: number;
}

/** Distribution summary of the live governor offsets across the roster. */
export interface GovernorOffsetSummary {
  bots: number;
  adjusted: number;
  nerfed: number;
  boosted: number;
  minAdjustment: number | null;
  maxAdjustment: number | null;
  avgAdjustment: number | null;
  avgWinrateEma: number | null;
  totalSamples: number;
}

function toState(row: GovernorStateRow): GovernorState {
  return {
    adjustment: Number(row.governor_adjustment) || 0,
    winrateEma: row.winrate_ema == null ? null : Number(row.winrate_ema),
    winrateSamples: Number(row.winrate_samples) || 0,
    updatedAt: row.governor_updated_at ? new Date(row.governor_updated_at) : null,
    samplesAtAdjustment: Number(row.governor_samples_at_adjustment) || 0,
  };
}

export const governorRepo = {
  /** Current governor state for one bot, or null when it has no roster profile. */
  async getState(botUserId: string): Promise<GovernorState | null> {
    const [row] = await sql<GovernorStateRow[]>`
      SELECT
        governor_adjustment,
        winrate_ema,
        winrate_samples,
        governor_updated_at,
        governor_samples_at_adjustment
      FROM synthetic_player_profiles
      WHERE user_id = ${botUserId}
      LIMIT 1
    `;
    return row ? toState(row) : null;
  },

  /**
   * Persist the post-match governor state.
   *
   * CONCURRENCY: guarded on `winrate_samples = expectedSamples` (the value the
   * caller read). Two replicas settling two of a bot's matches at once would
   * otherwise each write samples = read + 1 and silently lose one sample. The
   * loser gets false back and simply skips — one dropped EMA sample out of a
   * 20-match memory is immaterial, whereas a lost UPDATE that also reverted the
   * offset would not be. (A bot plays one match at a time by the reservation
   * invariant, so this is a belt-and-braces guard against the settle-replay and
   * forfeit paths racing on the SAME match.)
   */
  async saveState(
    botUserId: string,
    state: GovernorState,
    expectedSamples: number,
  ): Promise<boolean> {
    const rows = await sql<{ user_id: string }[]>`
      UPDATE synthetic_player_profiles
        SET
          governor_adjustment = ${state.adjustment},
          winrate_ema = ${state.winrateEma},
          winrate_samples = ${state.winrateSamples},
          governor_updated_at = ${state.updatedAt},
          governor_samples_at_adjustment = ${state.samplesAtAdjustment},
          updated_at = now()
      WHERE user_id = ${botUserId}
        AND winrate_samples = ${expectedSamples}
      RETURNING user_id
    `;
    return rows.length > 0;
  },

  /**
   * RP of the #10 HUMAN on the live global leaderboard, or null when fewer than
   * 10 placed humans exist (early season / fresh env) — the caller then leaves
   * top-protection disabled rather than acting on a guess.
   *
   * Deliberately HUMAN-ONLY (`u.is_ai = false`): the public leaderboard predicate
   * counts persistent bots as players, but the thing being protected is the
   * humans' top 10. Using the public predicate would let a cluster of bots at the
   * top raise the threshold and license each other to climb further.
   *
   * The rest of the predicate mirrors listLeaderboard exactly (seed/deleted/
   * pending-deletion excluded, placed only) so "the #10 human" here is the same
   * player a human sees at rank 10.
   */
  async getHumanTop10Rp(): Promise<number | null> {
    return withSpan('db.bots.human_top10_rp', { 'db.operation.name': 'select' }, async () => {
      const [row] = await sql<{ rp: number }[]>`
        SELECT rp.rp AS rp
        FROM ranked_profiles rp
        JOIN users u ON u.id = rp.user_id
        WHERE u.is_ai = false
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND rp.placement_status = 'placed'
        ORDER BY rp.rp DESC, rp.updated_at ASC
        OFFSET 9
        LIMIT 1
      `;
      return row ? Number(row.rp) : null;
    });
  },

  /** Daily bot-vs-human win/loss totals, newest first. */
  async getDailyWinrates(days: number): Promise<BotDailyWinrateRow[]> {
    const rows = await sql<Array<{
      georgia_day: string;
      bot_wins: number;
      bot_losses: number;
      total_matches: number;
      distinct_bots: number;
    }>>`
      SELECT georgia_day, bot_wins, bot_losses, total_matches, distinct_bots
      FROM persistent_bot_daily_winrate
      ORDER BY georgia_day DESC
      LIMIT ${days}
    `;
    return rows.map((row) => ({
      georgiaDay: typeof row.georgia_day === 'string'
        ? row.georgia_day
        : new Date(row.georgia_day).toISOString().slice(0, 10),
      botWins: Number(row.bot_wins),
      botLosses: Number(row.bot_losses),
      totalMatches: Number(row.total_matches),
      distinctBots: Number(row.distinct_bots),
    }));
  },

  /** Roster-wide summary of current governor offsets. */
  async getOffsetSummary(): Promise<GovernorOffsetSummary> {
    const [row] = await sql<Array<{
      bots: number;
      adjusted: number;
      nerfed: number;
      boosted: number;
      min_adjustment: number | null;
      max_adjustment: number | null;
      avg_adjustment: number | null;
      avg_winrate_ema: number | null;
      total_samples: number | null;
    }>>`
      SELECT
        COUNT(*)::int                                                   AS bots,
        COUNT(*) FILTER (WHERE governor_adjustment <> 0)::int           AS adjusted,
        COUNT(*) FILTER (WHERE governor_adjustment < 0)::int            AS nerfed,
        COUNT(*) FILTER (WHERE governor_adjustment > 0)::int            AS boosted,
        MIN(governor_adjustment)                                        AS min_adjustment,
        MAX(governor_adjustment)                                        AS max_adjustment,
        AVG(governor_adjustment)                                        AS avg_adjustment,
        AVG(winrate_ema) FILTER (WHERE winrate_ema IS NOT NULL)         AS avg_winrate_ema,
        SUM(winrate_samples)::int                                       AS total_samples
      FROM synthetic_player_profiles
      WHERE status <> 'retired'
    `;
    const num = (value: number | null): number | null => (value == null ? null : Number(value));
    return {
      bots: Number(row?.bots ?? 0),
      adjusted: Number(row?.adjusted ?? 0),
      nerfed: Number(row?.nerfed ?? 0),
      boosted: Number(row?.boosted ?? 0),
      minAdjustment: num(row?.min_adjustment ?? null),
      maxAdjustment: num(row?.max_adjustment ?? null),
      avgAdjustment: num(row?.avg_adjustment ?? null),
      avgWinrateEma: num(row?.avg_winrate_ema ?? null),
      totalSamples: Number(row?.total_samples ?? 0),
    };
  },
};
