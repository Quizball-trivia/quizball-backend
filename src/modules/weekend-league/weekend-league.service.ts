import { getOrLoadJson } from '../../core/json-cache.js';
import { sql } from '../../db/index.js';
import { tierFromRp } from '../ranked/season-rp-formula.js';
import { weekendLeagueRepo, type WlTournamentRow } from './weekend-league.repo.js';
import { wlConfigFrom } from './wl-config.js';
import { weekKeyFor, WL_QP_TARGET } from './wl-week.js';
import type {
  WlCheckinResponse,
  WlCurrentResponse,
  WlEnterResponse,
  WlQpResponse,
} from './weekend-league.schemas.js';

const COUNTS_CACHE_TTL_SECONDS = 5;

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
   * Public qualifier standings for the CURRENT tournament: cumulative board
   * of the newest game that has results (rank, points, advanced), joined with
   * nickname/avatar/country and the ranked tier. Empty before any game ends.
   * Feeds the Weekend League tab's standings table (it launched with a
   * hardcoded [] — owner report the morning after).
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
    const rows = await sql<Array<{
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


  async current(userId: string): Promise<WlCurrentResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    if (!tournament) {
      return { tournament: null, you: null };
    }

    const [counts, entry, qp, lastGameRank] = await Promise.all([
      getOrLoadJson(
        `wl:counts:${tournament.id}`,
        COUNTS_CACHE_TTL_SECONDS,
        () => weekendLeagueRepo.getCounts(tournament.id)
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
