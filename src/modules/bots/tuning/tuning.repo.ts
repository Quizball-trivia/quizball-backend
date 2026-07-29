/**
 * Data access for the PR10 live-tuning surface.
 *
 * Four concerns:
 *   - read/write the bot_tuning_overrides singleton
 *   - the paginated roster overview behind the CMS table
 *   - the per-bot selection freeze
 *   - the emergency roster-wide offset zeroing
 */

import { sql } from '../../../db/index.js';
import { withSpan } from '../../../core/tracing.js';

/**
 * Raw singleton row. Every knob is nullable: NULL means "no override, use the
 * code constant", which is what keeps the code constants authoritative for
 * anything the operator has not deliberately set.
 */
export interface BotTuningOverridesRow {
  version: number;
  ceiling_margin: number | null;
  top_band_target_winrate: number | null;
  mid_ladder_target_winrate: number | null;
  governor_step: number | null;
  top_protection_step: number | null;
  top_protection_margin_rp: number | null;
  top_protection_critical_rp: number | null;
  activity_scale: number | null;
  max_daily_cap: number | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Camel-cased overrides as the rest of the app consumes them. */
export interface BotTuningOverrides {
  version: number;
  ceilingMargin: number | null;
  topBandTargetWinrate: number | null;
  midLadderTargetWinrate: number | null;
  governorStep: number | null;
  topProtectionStep: number | null;
  topProtectionMarginRp: number | null;
  topProtectionCriticalRp: number | null;
  activityScale: number | null;
  maxDailyCap: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Column name for each override field, for the partial-update builder. */
const OVERRIDE_COLUMNS = {
  ceilingMargin: 'ceiling_margin',
  topBandTargetWinrate: 'top_band_target_winrate',
  midLadderTargetWinrate: 'mid_ladder_target_winrate',
  governorStep: 'governor_step',
  topProtectionStep: 'top_protection_step',
  topProtectionMarginRp: 'top_protection_margin_rp',
  topProtectionCriticalRp: 'top_protection_critical_rp',
  activityScale: 'activity_scale',
  maxDailyCap: 'max_daily_cap',
} as const;

export type OverrideField = keyof typeof OVERRIDE_COLUMNS;

const num = (value: number | null): number | null => (value == null ? null : Number(value));

function toOverrides(row: BotTuningOverridesRow): BotTuningOverrides {
  return {
    version: Number(row.version),
    ceilingMargin: num(row.ceiling_margin),
    topBandTargetWinrate: num(row.top_band_target_winrate),
    midLadderTargetWinrate: num(row.mid_ladder_target_winrate),
    governorStep: num(row.governor_step),
    topProtectionStep: num(row.top_protection_step),
    topProtectionMarginRp: num(row.top_protection_margin_rp),
    topProtectionCriticalRp: num(row.top_protection_critical_rp),
    activityScale: num(row.activity_scale),
    maxDailyCap: num(row.max_daily_cap),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** One row of the CMS roster table. */
export interface RosterOverviewRow {
  botUserId: string;
  nickname: string | null;
  tier: string | null;
  rp: number | null;
  status: string;
  selectionFrozen: boolean;
  winrateEma: number | null;
  winrateSamples: number;
  governorAdjustment: number;
  matchesToday: number;
  dailyCap: number;
  lastSelectedAt: string | null;
}

export interface RosterOverviewPage {
  rows: RosterOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const tuningRepo = {
  /**
   * The overrides singleton.
   *
   * A PURE READ. An earlier version used INSERT..ON CONFLICT DO UPDATE to be
   * defensive about a missing row, but DO UPDATE fires the version-bump
   * trigger — so every cache miss and every CMS GET minted a fictitious new
   * config version, destroying the provenance the version exists to provide.
   * The migration seeds the row; a missing one is a broken deploy, and the
   * ON CONFLICT DO NOTHING below repairs it without touching the version.
   */
  async getOverrides(): Promise<BotTuningOverrides> {
    const select = () => sql<BotTuningOverridesRow[]>`
      SELECT
        version, ceiling_margin, top_band_target_winrate, mid_ladder_target_winrate,
        governor_step, top_protection_step, top_protection_margin_rp,
        top_protection_critical_rp, activity_scale, max_daily_cap,
        updated_at, updated_by
      FROM bot_tuning_overrides WHERE id = true
    `;
    const [row] = await select();
    if (row) return toOverrides(row);

    // Singleton missing (rolled-back seed / fresh DB): recreate WITHOUT bumping.
    await sql`INSERT INTO bot_tuning_overrides (id) VALUES (true) ON CONFLICT (id) DO NOTHING`;
    const [seeded] = await select();
    return toOverrides(seeded);
  },

  /**
   * Apply a PARTIAL update. `fields` carries only the keys the caller wants to
   * change; an explicit null clears the override back to the code constant.
   *
   * `version` is bumped by the DB trigger on every update, so the returned row
   * carries the new version that gets stamped into subsequent match pins.
   */
  async updateOverrides(
    fields: Partial<Record<OverrideField, number | null>>,
    updatedBy: string | null,
  ): Promise<BotTuningOverrides> {
    const entries = Object.entries(fields) as Array<[OverrideField, number | null]>;
    // Build the SET list from the supplied keys only. Column names come from the
    // OVERRIDE_COLUMNS map (never from caller input), so this cannot be injected.
    const assignments = entries.map(
      ([field, value]) => sql`${sql(OVERRIDE_COLUMNS[field])} = ${value}`,
    );
    const [row] = await sql<BotTuningOverridesRow[]>`
      UPDATE bot_tuning_overrides
        SET ${assignments.length > 0 ? sql`${assignments.flatMap((a, i) => (i === 0 ? [a] : [sql`, `, a]))},` : sql``}
            updated_by = ${updatedBy},
            updated_at = now()
      WHERE id = true
      RETURNING
        version, ceiling_margin, top_band_target_winrate, mid_ladder_target_winrate,
        governor_step, top_protection_step, top_protection_margin_rp,
        top_protection_critical_rp, activity_scale, max_daily_cap,
        updated_at, updated_by
    `;
    return toOverrides(row);
  },

  /**
   * Paginated roster overview. Sort keys are mapped from a closed enum to fixed
   * SQL fragments — never interpolated from caller input.
   */
  async getRosterOverview(params: {
    page: number;
    pageSize: number;
    search?: string;
    frozen?: boolean;
    sort: 'rp' | 'winrate' | 'matches_today' | 'nickname';
    direction: 'asc' | 'desc';
  }): Promise<RosterOverviewPage> {
    return withSpan('db.bots.roster_overview', { 'db.operation.name': 'select' }, async () => {
      const offset = (params.page - 1) * params.pageSize;
      const searchPattern = params.search ? `%${params.search}%` : null;

      const sortColumn = {
        rp: sql`rp.rp`,
        winrate: sql`p.winrate_ema`,
        matches_today: sql`p.matches_today`,
        nickname: sql`u.nickname`,
      }[params.sort];
      const direction = params.direction === 'asc' ? sql`ASC` : sql`DESC`;

      const whereClause = sql`
        WHERE u.ai_kind = 'persistent'
          AND (${searchPattern}::text IS NULL OR u.nickname ILIKE ${searchPattern})
          AND (${params.frozen ?? null}::boolean IS NULL OR p.selection_frozen = ${params.frozen ?? null})
      `;

      const rows = await sql<Array<{
        bot_user_id: string;
        nickname: string | null;
        tier: string | null;
        rp: number | null;
        status: string;
        selection_frozen: boolean;
        winrate_ema: number | null;
        winrate_samples: number;
        governor_adjustment: number;
        matches_today: number;
        daily_cap: number;
        last_selected_at: string | null;
        total: number;
      }>>`
        SELECT
          p.user_id            AS bot_user_id,
          u.nickname           AS nickname,
          rp.tier              AS tier,
          rp.rp                AS rp,
          p.status             AS status,
          p.selection_frozen   AS selection_frozen,
          p.winrate_ema        AS winrate_ema,
          p.winrate_samples    AS winrate_samples,
          p.governor_adjustment AS governor_adjustment,
          p.matches_today      AS matches_today,
          p.daily_cap          AS daily_cap,
          p.last_selected_at   AS last_selected_at,
          COUNT(*) OVER ()::int AS total
        FROM synthetic_player_profiles p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN ranked_profiles rp ON rp.user_id = p.user_id
        ${whereClause}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, p.user_id ASC
        LIMIT ${params.pageSize} OFFSET ${offset}
      `;

      return {
        rows: rows.map((row) => ({
          botUserId: row.bot_user_id,
          nickname: row.nickname,
          tier: row.tier,
          rp: num(row.rp),
          status: row.status,
          selectionFrozen: row.selection_frozen,
          winrateEma: num(row.winrate_ema),
          winrateSamples: Number(row.winrate_samples) || 0,
          governorAdjustment: Number(row.governor_adjustment) || 0,
          matchesToday: Number(row.matches_today) || 0,
          dailyCap: Number(row.daily_cap) || 0,
          lastSelectedAt: row.last_selected_at,
        })),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        page: params.page,
        pageSize: params.pageSize,
      };
    });
  },

  /**
   * Freeze or unfreeze one bot. Returns null when no persistent-bot profile
   * exists for the id, so the controller can answer 404 rather than silently
   * succeeding on a typo'd uuid.
   */
  async setSelectionFrozen(botUserId: string, frozen: boolean): Promise<{ botUserId: string; selectionFrozen: boolean } | null> {
    const [row] = await sql<Array<{ user_id: string; selection_frozen: boolean }>>`
      UPDATE synthetic_player_profiles
        SET selection_frozen = ${frozen}, updated_at = now()
      WHERE user_id = ${botUserId}
      RETURNING user_id, selection_frozen
    `;
    return row ? { botUserId: row.user_id, selectionFrozen: row.selection_frozen } : null;
  },

  /**
   * EMERGENCY: clear BOOSTING governor offsets across the roster.
   *
   * WEAKER-ONLY. Only POSITIVE offsets are zeroed. A negative offset is a
   * safety NERF the governor applied (usually top-protection pushing a bot away
   * from the human top 10), and zeroing it would make that bot immediately
   * STRONGER — turning the emergency button into a roster-wide buff, the exact
   * be#175 failure mode. Clearing an over-boosted roster is the incident this
   * endpoint exists for; use the kill switch to disable the governor wholesale.
   *
   * Deliberately does NOT touch winrate_ema / winrate_samples: the observation
   * history stays honest so the governor resumes from a warm estimate rather
   * than a cold start, exactly as the kill switch does.
   *
   * governor_updated_at is re-stamped so the cooldown starts from now, which
   * stops the loop from immediately re-applying a large step on the next match.
   */
  async zeroGovernorOffsets(): Promise<number> {
    const rows = await sql<Array<{ user_id: string }>>`
      UPDATE synthetic_player_profiles
        SET governor_adjustment = 0,
            governor_updated_at = now(),
            governor_samples_at_adjustment = winrate_samples,
            updated_at = now()
      WHERE status <> 'retired'
        AND governor_adjustment > 0
      RETURNING user_id
    `;
    return rows.length;
  },
};
