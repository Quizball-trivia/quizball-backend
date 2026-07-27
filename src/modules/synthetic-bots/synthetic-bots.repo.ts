import { sql, type TransactionSql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';

/**
 * Pure-data repo for the persistent-bot roster tables:
 *   synthetic_bot_reservations  one-concurrent-match invariant (lobby-keyed, fenced)
 *   synthetic_player_profiles   hidden ability + identity + activity schedule
 *
 * All reads/writes are inert until the roster ships (PR5). PR7 only reads the
 * roster and drives the reservation lifecycle; the schema (PR1) already exists
 * on every env, so an empty roster is a no-op selection, not an error.
 *
 * Concurrency contract (see PERSISTENT-BOTS-PLAN §1.7 + Appendix A):
 *   - acquire is INSERT ... ON CONFLICT (bot_user_id) DO NOTHING — exactly one
 *     winner under a concurrent race; the loser gets null and falls back.
 *   - transfer sets match_id in the SAME transaction as match creation.
 *   - release is owner-qualified (holder + fence): a stale holder can never
 *     release a reservation the bot has since re-acquired under a newer fence.
 *   - terminal teardown sites that only know the lobby/match id release by
 *     lobby/match (any holder) — the reservation is being torn down, not
 *     handed off, so the fence guard would only strand it for the TTL.
 */

export interface SyntheticBotReservationRow {
  bot_user_id: string;
  lobby_id: string;
  match_id: string | null;
  holder: string;
  fence: number;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface SyntheticPlayerProfileRow {
  user_id: string;
  status: 'active' | 'resting' | 'retired' | string;
  base_skill: number;
  consistency: number;
  speed_offset: number;
  category_affinities: unknown;
  schedule: unknown;
  daily_cap: number;
  matches_today: number;
  matches_day: string | null;
  home_city: string | null;
  home_lat: number | null;
  home_lng: number | null;
  favorite_club: string | null;
  rename_propensity: number;
  personality_seed: number;
  governor_adjustment: number;
  winrate_ema: number | null;
  winrate_samples: number;
  governor_updated_at: string | null;
  last_selected_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A roster bot joined with the ranked profile fields selection reads. */
export interface EligibleBotRow extends SyntheticPlayerProfileRow {
  rp: number;
  tier: string;
  placement_status: string;
  nickname: string | null;
  avatar_url: string | null;
  avatar_customization: unknown;
  country: string | null;
}

export const syntheticBotsRepo = {
  /**
   * Acquire a reservation for one roster bot. INSERT ... ON CONFLICT DO NOTHING
   * on the bot_user_id PK: if another selection already holds this bot (or it
   * holds a live reservation from a prior lobby), the insert returns no row and
   * the caller moves on to the next candidate. Returns the fresh fence on a win.
   */
  async acquireReservation(params: {
    botUserId: string;
    lobbyId: string;
    holder: string;
    expiresAt: Date;
  }): Promise<SyntheticBotReservationRow | null> {
    const [row] = await sql<SyntheticBotReservationRow[]>`
      INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
      VALUES (${params.botUserId}, ${params.lobbyId}, ${params.holder}, ${params.expiresAt})
      ON CONFLICT (bot_user_id) DO NOTHING
      RETURNING *
    `;
    return row ?? null;
  },

  /**
   * Transfer a lobby-keyed reservation onto its match, atomically with match
   * creation (caller passes the SAME tx that inserted the match row). Guarded on
   * lobby_id + match_id IS NULL so a re-acquired reservation (different lobby) or
   * an already-transferred one is never clobbered. Returns the updated row, or
   * null if nothing matched (no reservation for this lobby — the common
   * ephemeral case, or a race the caller treats as "not persistent").
   */
  async transferReservationToMatch(
    tx: TransactionSql,
    params: { botUserId: string; lobbyId: string; matchId: string },
  ): Promise<SyntheticBotReservationRow | null> {
    const rows = await tx.unsafe<SyntheticBotReservationRow[]>(
      `UPDATE synthetic_bot_reservations
         SET match_id = $1, heartbeat_at = now()
       WHERE bot_user_id = $2 AND lobby_id = $3 AND match_id IS NULL
       RETURNING *`,
      [params.matchId, params.botUserId, params.lobbyId],
    );
    return rows[0] ?? null;
  },

  /**
   * Owner-qualified release: delete only if the caller still holds the exact
   * reservation it acquired (holder + fence). Used by the pre-match-lobby
   * teardown sites that own the acquiring holder token.
   */
  async releaseReservationOwned(params: {
    botUserId: string;
    holder: string;
    fence: number;
  }): Promise<boolean> {
    const rows = await sql<{ bot_user_id: string }[]>`
      DELETE FROM synthetic_bot_reservations
      WHERE bot_user_id = ${params.botUserId}
        AND holder = ${params.holder}
        AND fence = ${params.fence}
      RETURNING bot_user_id
    `;
    return rows.length > 0;
  },

  /**
   * Terminal release keyed by lobby (any holder). The lobby is being torn down
   * before a match ever existed; whoever holds the reservation, it must go.
   * Returns the released bot id (if any) for telemetry.
   */
  async releaseReservationByLobby(lobbyId: string): Promise<string | null> {
    const rows = await sql<{ bot_user_id: string }[]>`
      DELETE FROM synthetic_bot_reservations
      WHERE lobby_id = ${lobbyId}
      RETURNING bot_user_id
    `;
    return rows[0]?.bot_user_id ?? null;
  },

  /**
   * Terminal release keyed by match (any holder). The match reached a terminal
   * state (completion after settlement, forfeit, disconnect, orphan, sweep).
   */
  async releaseReservationByMatch(matchId: string): Promise<string | null> {
    const rows = await sql<{ bot_user_id: string }[]>`
      DELETE FROM synthetic_bot_reservations
      WHERE match_id = ${matchId}
      RETURNING bot_user_id
    `;
    return rows[0]?.bot_user_id ?? null;
  },

  /**
   * Re-key a stranded lobby-keyed reservation onto its live match (sweeper
   * recovery for a crash between match creation and transfer). Never touches a
   * reservation that already carries a match_id.
   */
  async rekeyReservationToMatch(params: {
    botUserId: string;
    lobbyId: string;
    matchId: string;
  }): Promise<boolean> {
    const rows = await sql<{ bot_user_id: string }[]>`
      UPDATE synthetic_bot_reservations
        SET match_id = ${params.matchId}, heartbeat_at = now()
      WHERE bot_user_id = ${params.botUserId}
        AND lobby_id = ${params.lobbyId}
        AND match_id IS NULL
      RETURNING bot_user_id
    `;
    return rows.length > 0;
  },

  /** Reservations past their expiry, oldest first — the sweeper's work list. */
  async listExpiredReservations(now: Date, limit: number): Promise<SyntheticBotReservationRow[]> {
    return sql<SyntheticBotReservationRow[]>`
      SELECT * FROM synthetic_bot_reservations
      WHERE expires_at < ${now}
      ORDER BY expires_at ASC
      LIMIT ${limit}
    `;
  },

  /** Extend a live reservation's heartbeat/expiry (kept alive across a match). */
  async heartbeatReservation(params: { botUserId: string; expiresAt: Date }): Promise<void> {
    await sql`
      UPDATE synthetic_bot_reservations
        SET heartbeat_at = now(), expires_at = ${params.expiresAt}
      WHERE bot_user_id = ${params.botUserId}
    `;
  },

  async getReservationByBot(botUserId: string): Promise<SyntheticBotReservationRow | null> {
    const [row] = await sql<SyntheticBotReservationRow[]>`
      SELECT * FROM synthetic_bot_reservations WHERE bot_user_id = ${botUserId}
    `;
    return row ?? null;
  },

  /**
   * Eligible roster bots for selection, joined to their ranked profile + user
   * identity. HARD filters applied in SQL (never relaxed): status='active', not
   * currently reserved (no reservation row). SOFT constraints (recently-faced,
   * daily cap, schedule) are applied in the selection service so the relaxation
   * ladder can widen without another round trip.
   *
   * Returns every active, unreserved bot with its real RP/tier/identity; the
   * roster is ~1,000 rows so a full scan per selection is acceptable and avoids
   * per-band query churn. Empty roster → empty array → ephemeral fallback.
   */
  async listEligibleBots(): Promise<EligibleBotRow[]> {
    return withSpan('db.synthetic_bots.list_eligible', {
      'db.operation.name': 'select',
    }, async () => {
      return sql<EligibleBotRow[]>`
        SELECT
          p.*,
          rp.rp AS rp,
          rp.tier AS tier,
          rp.placement_status AS placement_status,
          u.nickname AS nickname,
          u.avatar_url AS avatar_url,
          u.avatar_customization AS avatar_customization,
          u.country AS country
        FROM synthetic_player_profiles p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN ranked_profiles rp ON rp.user_id = p.user_id
        WHERE p.status = 'active'
          AND u.ai_kind = 'persistent'
          AND NOT EXISTS (
            SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = p.user_id
          )
      `;
    });
  },

  /**
   * On a successful transfer, bump the bot's daily match counter and stamp
   * last_selected_at.
   *
   * Georgia-day semantics with a 07:00 Tbilisi reset (schema comment): the
   * "roster day" is the Tbilisi calendar date AFTER shifting the clock back 7
   * hours, so a match at 06:59 Tbilisi still counts toward the previous day and
   * the counter rolls over at 07:00. Computed entirely in SQL to avoid any
   * JS/DB timezone drift; the counter resets lazily when the current roster day
   * differs from the stored matches_day (no 07:00 cron zeroing 1,000 rows).
   */
  async bumpMatchesTodayAndSelectedAt(botUserId: string): Promise<string | null> {
    const rows = await sql<{ matches_day: string | null }[]>`
      UPDATE synthetic_player_profiles
        SET
          matches_today = CASE
            WHEN matches_day IS DISTINCT FROM (
              (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date
            ) THEN 1
            ELSE matches_today + 1
          END,
          matches_day = (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date,
          last_selected_at = now(),
          updated_at = now()
      WHERE user_id = ${botUserId}
      RETURNING matches_day
    `;
    return rows[0]?.matches_day ?? null;
  },
};
