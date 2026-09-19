import { getOrLoadJson } from '../../core/json-cache.js';
import { sql } from '../../db/index.js';
import { tierFromRp } from '../ranked/season-rp-formula.js';
import { weekendLeagueRepo, type WlTournamentRow } from './weekend-league.repo.js';
import { wlConfigFrom } from './wl-config.js';
import { WL_FINAL_GAME_INDEX } from './wl-rules.js';
import { weekKeyFor, WL_QP_TARGET } from './wl-week.js';
import type {
  WlCheckinResponse,
  WlCurrentResponse,
  WlEnterResponse,
  WlQpResponse,
} from './weekend-league.schemas.js';

const COUNTS_CACHE_TTL_SECONDS = 5;
/** The hall of fame only changes when an event completes — once a week. */
const HALL_OF_FAME_CACHE_TTL_SECONDS = 300;
/** Bounded history — the payload must not grow with every season played. */
const HALL_OF_FAME_MAX_EDITIONS = 12;

// These parsers MUST stay semantically identical to the SQL predicates in
// weekend-league.repo.enter() — the SQL authorizes, these only report. Both
// treat launch_edition as true only for JSON true / "true", and qp_target as
// an integer (number or all-digit string), defaulting to WL_QP_TARGET.
function qpTargetOf(tournament: WlTournamentRow | null): number {
  const raw = tournament?.config?.['qp_target'];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 999_999) return raw;
  if (typeof raw === 'string' && /^[0-9]{1,6}$/.test(raw)) return parseInt(raw, 10);
  return WL_QP_TARGET;
}

function currentGameIndexOf(t: WlTournamentRow): number {
  const n = Number((t.stage ?? {})['current_game']);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Break deadline for the public payload. Stays non-null through the
 *  spectator-shifted deadline (break end + stream delay): spectators run that
 *  far behind live, and nulling at real break end would kill their countdown
 *  with the delay still to run. */
function breakUntilMsOf(t: WlTournamentRow, spectatorDelayMs: number): number | null {
  const ms = Number((t.stage ?? {})['break_until_ms']);
  if (!Number.isFinite(ms) || ms + spectatorDelayMs <= Date.now()) return null;
  return Math.floor(ms);
}

function launchEditionOf(tournament: WlTournamentRow | null): boolean {
  const raw = tournament?.config?.['launch_edition'];
  return raw === true || raw === 'true';
}

function freeEntryOf(tournament: WlTournamentRow | null): boolean {
  const raw = tournament?.config?.['free_entry'];
  return raw === true || raw === 'true';
}

/**
 * The week whose QP we surface: the active tournament's week when one exists,
 * else the calendar week accruing right now (null on weekends between events).
 */
function activeWeekKey(tournament: WlTournamentRow | null): string | null {
  return tournament?.week_key ?? weekKeyFor(new Date());
}

async function loadQp(
  tournament: WlTournamentRow | null,
  userId: string
): Promise<WlQpResponse> {
  // QP economy v2: the RUNNING BALANCE (awards since the player's latest
  // ticket purchase) gates qualification — not this week's counter.
  const target = qpTargetOf(tournament);
  const { balance, wins, losses } = await weekendLeagueRepo.getQpBalance(userId);
  return {
    week_key: activeWeekKey(tournament),
    points: balance,
    wins,
    losses,
    target,
    qualified: (tournament?.is_test === true && freeEntryOf(tournament)) || balance >= target,
  };
}

export const weekendLeagueService = {
  /**
   * Public standings for the CURRENT tournament. During the qualifier this is
   * the CUMULATIVE board — total points across all qualifier games, faster
   * total time breaking ties, `advanced` = made the top-24 cut (owner report
   * 2026-08-29: the tab showed only game 3's scores, which read as the whole
   * qualifier). Once the final has results, the final's own board takes over —
   * the championship is decided by that single game. Empty before any game
   * ends. Feeds the Weekend League tab's standings table.
   */
  async standings(): Promise<{
    tournament_id: string | null;
    game_index: number | null;
    entries: Array<{
      user_id: string; nickname: string | null; avatar_url: string | null;
      country: string | null; tier: string; rank: number; points: number;
      advanced: boolean;
    }>;
  }> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    if (!tournament) return { tournament_id: null, game_index: null, entries: [] };
    const [latest] = await sql<Array<{ game_index: number }>>`
      SELECT max(game_index)::int AS game_index FROM wl_game_results
      WHERE tournament_id = ${tournament.id}
    `;
    if (latest?.game_index == null) {
      return { tournament_id: tournament.id, game_index: null, entries: [] };
    }
    const isFinalBoard = latest.game_index >= WL_FINAL_GAME_INDEX;
    const rows = isFinalBoard
      ? await sql<Array<{
          user_id: string; nickname: string | null; avatar_url: string | null;
          country: string | null; rp: number | null; rank: number; score: number;
          advanced: boolean;
        }>>`
          SELECT r.user_id, u.nickname, u.avatar_url, u.country,
                 p.rp::int AS rp, r.rank, r.score, r.advanced
          FROM wl_game_results r
          JOIN users u ON u.id = r.user_id
          LEFT JOIN ranked_profiles p ON p.user_id = r.user_id
          WHERE r.tournament_id = ${tournament.id} AND r.game_index = ${latest.game_index}
          ORDER BY r.rank
          LIMIT 100
        `
      : await sql<Array<{
          user_id: string; nickname: string | null; avatar_url: string | null;
          country: string | null; rp: number | null; rank: number; score: number;
          advanced: boolean;
        }>>`
          WITH agg AS (
            SELECT user_id,
                   sum(score)::int AS total,
                   sum(time_ms_total)::bigint AS total_time
            FROM wl_game_results
            WHERE tournament_id = ${tournament.id}
              AND game_index < ${WL_FINAL_GAME_INDEX}
            GROUP BY user_id
          ),
          alive AS (
            SELECT user_id, advanced FROM wl_game_results
            WHERE tournament_id = ${tournament.id} AND game_index = ${latest.game_index}
          )
          SELECT a.user_id, u.nickname, u.avatar_url, u.country,
                 p.rp::int AS rp,
                 rank() OVER (ORDER BY a.total DESC, a.total_time ASC)::int AS rank,
                 a.total AS score,
                 coalesce(al.advanced, false) AS advanced
          FROM agg a
          JOIN users u ON u.id = a.user_id
          LEFT JOIN ranked_profiles p ON p.user_id = a.user_id
          LEFT JOIN alive al ON al.user_id = a.user_id
          ORDER BY rank
          LIMIT 100
        `;
    return {
      tournament_id: tournament.id,
      game_index: latest.game_index,
      entries: rows.map((r) => ({
        user_id: r.user_id,
        nickname: r.nickname,
        avatar_url: r.avatar_url,
        country: r.country,
        tier: tierFromRp(Number(r.rp ?? 0)),
        rank: r.rank,
        points: r.score,
        advanced: r.advanced,
      })),
    };
  },

  /**
   * Past champions + the all-time medal table, for the events page.
   *
   * Ranked by MEDALS, never by summed points: the 2026-08-25 ranked-parity
   * rework roughly 2.4x'd per-game scores, so totals across editions are not
   * comparable. Points are shown per edition only, where they mean something.
   * Bots are excluded — a roster bot must never appear in the hall of fame.
   */
  async hallOfFame(): Promise<{
    editions: Array<{
      week_key: string;
      podium: Array<{ rank: number; nickname: string | null; avatar_url: string | null; points: number }>;
      entrants: number;
    }>;
    all_time: Array<{
      nickname: string | null; avatar_url: string | null;
      gold: number; silver: number; bronze: number; finals_played: number;
    }>;
  }> {
    return getOrLoadJson('wl:hall-of-fame', HALL_OF_FAME_CACHE_TTL_SECONDS, async () => {
      // Entrant counts are grouped ONCE per edition, not re-counted per podium
      // row; the two independent statements run concurrently. `editions` is
      // bounded so the payload cannot grow without limit as seasons accumulate.
      const podiumsQuery = sql<Array<{
        week_key: string; rank: number; nickname: string | null;
        avatar_url: string | null; score: number; entrants: number;
      }>>`
        WITH recent AS (
          SELECT id, week_key FROM wl_tournaments
          WHERE is_test = false AND status = 'completed'
          ORDER BY week_key DESC
          LIMIT ${HALL_OF_FAME_MAX_EDITIONS}
        ),
        entrant_counts AS (
          SELECT e.tournament_id, count(*)::int AS entrants
          FROM wl_entries e
          WHERE e.tournament_id IN (SELECT id FROM recent)
          GROUP BY e.tournament_id
        )
        SELECT rc.week_key::text, r.rank, u.nickname, u.avatar_url, r.score,
               COALESCE(ec.entrants, 0) AS entrants
        FROM wl_game_results r
        JOIN recent rc ON rc.id = r.tournament_id
        JOIN users u ON u.id = r.user_id
        LEFT JOIN entrant_counts ec ON ec.tournament_id = r.tournament_id
        WHERE r.game_index = ${WL_FINAL_GAME_INDEX} AND r.rank <= 3
        ORDER BY rc.week_key DESC, r.rank
      `;
      const allTimeQuery = sql<Array<{
        nickname: string | null; avatar_url: string | null;
        gold: number; silver: number; bronze: number; finals_played: number;
      }>>`
        SELECT u.nickname, u.avatar_url,
               count(*) FILTER (WHERE r.rank = 1)::int AS gold,
               count(*) FILTER (WHERE r.rank = 2)::int AS silver,
               count(*) FILTER (WHERE r.rank = 3)::int AS bronze,
               count(*)::int AS finals_played
        FROM wl_game_results r
        JOIN wl_tournaments t ON t.id = r.tournament_id
        JOIN users u ON u.id = r.user_id
        WHERE t.is_test = false AND t.status = 'completed'
          AND r.game_index = ${WL_FINAL_GAME_INDEX} AND u.is_ai = false
        GROUP BY u.nickname, u.avatar_url
        HAVING count(*) FILTER (WHERE r.rank <= 3) > 0
        ORDER BY gold DESC, silver DESC, bronze DESC, finals_played DESC
        LIMIT 10
      `;
      const [podiumRows, allTimeRows] = await Promise.all([podiumsQuery, allTimeQuery]);

      const byWeek = new Map<string, { week_key: string; entrants: number; podium: Array<{ rank: number; nickname: string | null; avatar_url: string | null; points: number }> }>();
      for (const row of podiumRows) {
        const edition = byWeek.get(row.week_key)
          ?? { week_key: row.week_key, entrants: row.entrants, podium: [] };
        edition.podium.push({
          rank: row.rank, nickname: row.nickname,
          avatar_url: row.avatar_url, points: row.score,
        });
        byWeek.set(row.week_key, edition);
      }
      return { editions: [...byWeek.values()], all_time: allTimeRows };
    });
  },


  async current(userId: string): Promise<WlCurrentResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    if (!tournament) {
      return { tournament: null, you: null };
    }

    // Sunday phases count finalists against final check-ins; the qualifier
    // counts otherwise. Distinct cache keys — a phase flip must not serve the
    // other phase's cached numbers for the TTL tail.
    const finalPhase = tournament.status === 'final_checkin' || tournament.status === 'final_live';
    const [counts, entry, qp, lastGameRank] = await Promise.all([
      getOrLoadJson(
        finalPhase ? `wl:final-counts:${tournament.id}` : `wl:counts:${tournament.id}`,
        COUNTS_CACHE_TTL_SECONDS,
        () => (finalPhase
          ? weekendLeagueRepo.getFinalCounts(tournament.id)
          : weekendLeagueRepo.getCounts(tournament.id))
      ),
      weekendLeagueRepo.getEntry(tournament.id, userId),
      loadQp(tournament, userId),
      weekendLeagueRepo.getLastGameRank(tournament.id, userId),
    ]);

    const tournamentCfg = wlConfigFrom(tournament.config);
    const spectatorDelayMs = tournamentCfg.spectator_delay_ms;
    // Advertise the FILLED field before the bots actually enter: the roster
    // tops the field up to bot_fill_min_field at the check-in cutoff, so a
    // 3-human entry screen on a 93-floor event reads "93 joined", not "3".
    // Post-fill the real entry count includes the bots, so the max is a no-op.
    const preFill = ['scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed', 'checkin']
      .includes(tournament.status);
    const advertisedRegistered = preFill
      ? Math.max(counts.registered, tournamentCfg.bot_fill_min_field)
      : counts.registered;
    return {
      tournament: {
        id: tournament.id,
        week_key: tournament.week_key,
        status: tournament.status,
        is_test: tournament.is_test,
        entry_opens_at: tournament.entry_opens_at,
        entry_closes_at: tournament.entry_closes_at,
        qualifier_starts_at: tournament.qualifier_starts_at,
        final_starts_at: tournament.final_starts_at,
        registered_count: advertisedRegistered,
        checked_in_count: counts.checkedIn,
        launch_edition: launchEditionOf(tournament),
        qp_target: qpTargetOf(tournament),
        current_game_index: currentGameIndexOf(tournament),
        break_until_ms: breakUntilMsOf(tournament, spectatorDelayMs),
        spectator_delay_ms: spectatorDelayMs,
        server_now_ms: Date.now(),
      },
      you: {
        entered: entry != null,
        state: entry?.state ?? null,
        checked_in: entry?.checked_in_at != null,
        final_checked_in: entry?.final_checked_in_at != null,
        last_game_rank: entry != null ? lastGameRank : null,
        qp,
      },
    };
  },

  async qp(userId: string): Promise<WlQpResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    return loadQp(tournament, userId);
  },

  /**
   * Resolve the tournament an enter/checkin call targets. Normally the
   * CURRENT tournament; an explicit id is honored ONLY when it names an
   * is_test tournament — the load/e2e harness must be able to target its
   * compressed test event while a real weekly event owns /current, and a
   * client can never use this to enter a real event out of band.
   */
  async resolveTarget(tournamentId?: string) {
    if (tournamentId) {
      const explicit = await weekendLeagueRepo.getTournamentById(tournamentId);
      return explicit?.is_test ? explicit : null;
    }
    return weekendLeagueRepo.getCurrentTournament();
  },

  async enter(userId: string, tournamentId?: string): Promise<WlEnterResponse> {
    const tournament = await this.resolveTarget(tournamentId);
    if (!tournament) {
      return { entered: false, already_entered: false, reason: 'no_tournament' };
    }

    const inserted = await weekendLeagueRepo.enter(tournament.id, userId);
    if (inserted) {
      return { entered: true, already_entered: false, reason: 'ok' };
    }

    // The conditional INSERT declined — classify for the client from FRESH
    // committed state (a phase transition may have landed after our first
    // read; reporting only, the statement above is the sole authorization
    // point).
    const entry = await weekendLeagueRepo.getEntry(tournament.id, userId);
    if (entry) {
      return { entered: true, already_entered: true, reason: 'ok' };
    }
    const fresh = await weekendLeagueRepo.getTournamentById(tournament.id) ?? tournament;
    const now = Date.now();
    const windowOpen = fresh.status === 'entry_open'
      && fresh.entry_opens_at != null
      && new Date(fresh.entry_opens_at).getTime() <= now
      && fresh.entry_closes_at != null
      && new Date(fresh.entry_closes_at).getTime() > now;
    if (!windowOpen) {
      return { entered: false, already_entered: false, reason: 'window_closed' };
    }
    return { entered: false, already_entered: false, reason: 'not_qualified' };
  },

  async checkin(userId: string, tournamentId?: string): Promise<WlCheckinResponse> {
    const tournament = await this.resolveTarget(tournamentId);
    if (!tournament) {
      return { checked_in: false, already_checked_in: false, reason: 'no_tournament' };
    }

    const isFinalWindow = tournament.status === 'final_checkin';
    let updated = isFinalWindow
      ? await weekendLeagueRepo.finalCheckin(tournament.id, userId)
      : await weekendLeagueRepo.checkin(tournament.id, userId);
    // Late-join grace: the scheduled window declined, but the game may have
    // started moments ago. Deliberately NOT gated on the status read above —
    // it can be stale across the kickoff boundary (read 'checkin', kickoff
    // lands, checkin() declines, and a status gate would skip the very path
    // built for that moment). Each repo call re-authorizes everything
    // (state, status, grace deadline) in its own SQL, so blind fallthrough
    // is safe.
    if (!updated) {
      updated = await weekendLeagueRepo.lateCheckinQualifier(tournament.id, userId);
    }
    if (!updated) {
      updated = await weekendLeagueRepo.lateCheckinFinal(tournament.id, userId);
    }
    if (updated) {
      return { checked_in: true, already_checked_in: false, reason: 'ok' };
    }

    const entry = await weekendLeagueRepo.getEntry(tournament.id, userId);
    if (!entry) {
      return { checked_in: false, already_checked_in: false, reason: 'not_entered' };
    }
    // Classification below reads fresh state for the same reason as enter().
    if (isFinalWindow && entry.state !== 'finalist') {
      return { checked_in: false, already_checked_in: false, reason: 'not_finalist' };
    }
    const already = isFinalWindow
      ? entry.final_checked_in_at != null
      : entry.checked_in_at != null;
    if (already) {
      return { checked_in: true, already_checked_in: true, reason: 'ok' };
    }
    return { checked_in: false, already_checked_in: false, reason: 'window_closed' };
  },
};
