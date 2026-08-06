import { getOrLoadJson } from '../../core/json-cache.js';
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
    const updated = isFinalWindow
      ? await weekendLeagueRepo.finalCheckin(tournament.id, userId)
      : await weekendLeagueRepo.checkin(tournament.id, userId);
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
