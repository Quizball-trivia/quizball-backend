import { sql } from '../../db/index.js';
import type { WlEntryState, WlTournamentStatus } from './weekend-league.schemas.js';

export interface WlTournamentRow {
  id: string;
  week_key: string | null;
  is_test: boolean;
  status: WlTournamentStatus;
  config: Record<string, unknown>;
  entry_opens_at: string | null;
  entry_closes_at: string | null;
  qualifier_starts_at: string | null;
  final_starts_at: string | null;
}

export interface WlEntryRow {
  tournament_id: string;
  user_id: string;
  state: WlEntryState;
  checked_in_at: string | null;
  final_checked_in_at: string | null;
  qp_at_entry: number;
}

export interface WlQpRow {
  week_key: string;
  points: number;
  wins: number;
  losses: number;
}

export const weekendLeagueRepo = {
  /**
   * The one tournament the product surfaces: the CHRONOLOGICALLY applicable
   * non-terminal row — the ongoing/soonest event (earliest final), never
   * simply the newest-created (early creation of next week's row must not
   * shadow the event currently running). Real tournaments win over test rows.
   */
  async getCurrentTournament(): Promise<WlTournamentRow | null> {
    const [row] = await sql<WlTournamentRow[]>`
      SELECT id, week_key::text, is_test, status, config,
             entry_opens_at::text, entry_closes_at::text,
             qualifier_starts_at::text, final_starts_at::text
      FROM wl_tournaments
      WHERE status NOT IN ('completed', 'cancelled', 'voided')
      ORDER BY is_test ASC, final_starts_at ASC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async getTournamentById(id: string): Promise<WlTournamentRow | null> {
    const [row] = await sql<WlTournamentRow[]>`
      SELECT id, week_key::text, is_test, status, config,
             entry_opens_at::text, entry_closes_at::text,
             qualifier_starts_at::text, final_starts_at::text
      FROM wl_tournaments
      WHERE id = ${id}
    `;
    return row ?? null;
  },

  async getEntry(tournamentId: string, userId: string): Promise<WlEntryRow | null> {
    const [row] = await sql<WlEntryRow[]>`
      SELECT tournament_id, user_id, state, checked_in_at, final_checked_in_at, qp_at_entry
      FROM wl_entries
      WHERE tournament_id = ${tournamentId} AND user_id = ${userId}
    `;
    return row ?? null;
  },

  /**
   * QP economy v2: the running balance = awards since the user's latest
   * reset ("buy the ticket, reset, grind again"). Wins/losses from any week
   * accrue; entering a tournament zeroes it via wl_qp_resets.
   */
  async getQpBalance(userId: string): Promise<{ balance: number; wins: number; losses: number }> {
    const [row] = await sql<Array<{ balance: number; wins: number; losses: number }>>`
      SELECT COALESCE(SUM(a.points), 0)::int AS balance,
             COUNT(*) FILTER (WHERE a.result = 'win')::int AS wins,
             COUNT(*) FILTER (WHERE a.result = 'loss')::int AS losses -- grants excluded
      FROM wl_qp_awards a
      WHERE a.user_id = ${userId}
        AND a.created_at > COALESCE(
          (SELECT MAX(r.reset_at) FROM wl_qp_resets r WHERE r.user_id = ${userId}),
          '-infinity'::timestamptz
        )
    `;
    return row ?? { balance: 0, wins: 0, losses: 0 };
  },

  async getQp(weekKey: string, userId: string): Promise<WlQpRow | null> {
    const [row] = await sql<WlQpRow[]>`
      SELECT week_key::text, points, wins, losses
      FROM wl_qp
      WHERE week_key = ${weekKey}::date AND user_id = ${userId}
    `;
    return row ?? null;
  },

  async getCounts(tournamentId: string): Promise<{ registered: number; checkedIn: number }> {
    const [row] = await sql<{ registered: number; checked_in: number }[]>`
      SELECT COUNT(*)::int AS registered,
             COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in
      FROM wl_entries
      WHERE tournament_id = ${tournamentId}
        AND state NOT IN ('withdrawn', 'cancelled', 'disqualified')
    `;
    return { registered: row?.registered ?? 0, checkedIn: row?.checked_in ?? 0 };
  },

  /**
   * Entry as ONE conditional statement: the window, status and qualification
   * checks live in the same INSERT that claims the seat, so a race with the
   * Friday close (or a double-click) cannot produce an invalid entry. Zero
   * rows back means "not entered" — the service classifies why with follow-up
   * reads, which is only reporting, never authorization.
   */
  async enter(tournamentId: string, userId: string): Promise<boolean> {
    // Wallet serialization: the SAME users-row lock the ranked settlement
    // transaction takes (applySettlement's FOR UPDATE) is taken here first,
    // so entries serialize against award writers AND against concurrent
    // entries into other tournaments — a balance can never be spent twice,
    // and an award blocked behind a reset lands (clock_timestamp) after it.
    // Free entry is a TEST-tournament property only; launch is not free.
    let entered = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      await txSql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const rows = await txSql<{ user_id: string }[]>`
      WITH balance AS (
        SELECT COALESCE(SUM(a.points), 0)::int AS points
        FROM wl_qp_awards a
        WHERE a.user_id = ${userId}
          AND a.created_at > COALESCE(
            (SELECT MAX(r.reset_at) FROM wl_qp_resets r WHERE r.user_id = ${userId}),
            '-infinity'::timestamptz
          )
      ),
      claimed AS (
        INSERT INTO wl_entries (tournament_id, user_id, qp_at_entry)
        SELECT t.id, ${userId}, balance.points
        FROM wl_tournaments t, balance
        WHERE t.id = ${tournamentId}
          AND t.status = 'entry_open'
          AND t.entry_opens_at IS NOT NULL
          AND NOW() >= t.entry_opens_at
          AND t.entry_closes_at IS NOT NULL
          AND NOW() < t.entry_closes_at
          AND (
            (t.is_test = true AND COALESCE(t.config->>'free_entry', 'false') = 'true')
            OR balance.points >= (
              CASE WHEN t.config->>'qp_target' ~ '^[0-9]{1,6}$'
                   THEN (t.config->>'qp_target')::int ELSE 200 END
            )
          )
        ON CONFLICT (tournament_id, user_id) DO NOTHING
        RETURNING user_id
      )
      INSERT INTO wl_qp_resets (user_id, tournament_id, balance_spent)
      SELECT claimed.user_id, ${tournamentId}, balance.points
      FROM claimed, balance
      ON CONFLICT (user_id, tournament_id) DO NOTHING
      RETURNING user_id
    `;
      entered = rows.length > 0;
    });
    return entered;
  },

  /** Saturday check-in window: [qualifier_starts_at − config window, start). */
  async checkin(tournamentId: string, userId: string): Promise<boolean> {
    const rows = await sql<{ user_id: string }[]>`
      UPDATE wl_entries e
      SET checked_in_at = NOW()
      FROM wl_tournaments t
      WHERE t.id = e.tournament_id
        AND e.tournament_id = ${tournamentId}
        AND e.user_id = ${userId}
        AND e.checked_in_at IS NULL
        AND e.state = 'entered'
        AND t.status = 'checkin'
        AND t.qualifier_starts_at IS NOT NULL
        AND NOW() >= t.qualifier_starts_at - make_interval(secs => (
          CASE WHEN t.config->>'checkin_window_ms' ~ '^[0-9]{1,9}$'
               THEN (t.config->>'checkin_window_ms')::bigint ELSE 600000 END
        ) / 1000.0)
        AND NOW() < t.qualifier_starts_at
      RETURNING e.user_id
    `;
    return rows.length > 0;
  },

  /** Sunday final check-in — finalists only, same config-window shape. */
  async finalCheckin(tournamentId: string, userId: string): Promise<boolean> {
    const rows = await sql<{ user_id: string }[]>`
      UPDATE wl_entries e
      SET final_checked_in_at = NOW()
      FROM wl_tournaments t
      WHERE t.id = e.tournament_id
        AND e.tournament_id = ${tournamentId}
        AND e.user_id = ${userId}
        AND e.final_checked_in_at IS NULL
        AND e.state = 'finalist'
        AND t.status = 'final_checkin'
        AND t.final_starts_at IS NOT NULL
        AND NOW() >= t.final_starts_at - make_interval(secs => (
          CASE WHEN t.config->>'checkin_window_ms' ~ '^[0-9]{1,9}$'
               THEN (t.config->>'checkin_window_ms')::bigint ELSE 600000 END
        ) / 1000.0)
        AND NOW() < t.final_starts_at
      RETURNING e.user_id
    `;
    return rows.length > 0;
  },
};
