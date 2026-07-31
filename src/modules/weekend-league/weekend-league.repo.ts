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
    const rows = await sql<{ user_id: string }[]>`
      INSERT INTO wl_entries (tournament_id, user_id, qp_at_entry)
      SELECT t.id, ${userId}, COALESCE(q.points, 0)
      FROM wl_tournaments t
      LEFT JOIN wl_qp q ON q.week_key = t.week_key AND q.user_id = ${userId}
      WHERE t.id = ${tournamentId}
        AND t.status = 'entry_open'
        AND t.entry_opens_at IS NOT NULL
        AND NOW() >= t.entry_opens_at
        AND t.entry_closes_at IS NOT NULL
        AND NOW() < t.entry_closes_at
        AND (
          COALESCE(t.config->>'launch_edition', 'false') = 'true'
          OR COALESCE(q.points, 0) >= (
            CASE WHEN t.config->>'qp_target' ~ '^[0-9]{1,6}$'
                 THEN (t.config->>'qp_target')::int ELSE 200 END
          )
        )
      ON CONFLICT (tournament_id, user_id) DO NOTHING
      RETURNING user_id
    `;
    return rows.length > 0;
  },

  /** Saturday check-in window: [qualifier_starts_at − 10min, qualifier_starts_at). */
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
        AND NOW() >= t.qualifier_starts_at - interval '10 minutes'
        AND NOW() < t.qualifier_starts_at
      RETURNING e.user_id
    `;
    return rows.length > 0;
  },

  /** Sunday final check-in — finalists only, same 10-minute window shape. */
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
        AND NOW() >= t.final_starts_at - interval '10 minutes'
        AND NOW() < t.final_starts_at
      RETURNING e.user_id
    `;
    return rows.length > 0;
  },
};
