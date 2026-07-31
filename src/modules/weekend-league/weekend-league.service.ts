import { getOrLoadJson } from '../../core/json-cache.js';
import { weekendLeagueRepo, type WlTournamentRow } from './weekend-league.repo.js';
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

function launchEditionOf(tournament: WlTournamentRow | null): boolean {
  const raw = tournament?.config?.['launch_edition'];
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
    qualified: launchEditionOf(tournament) || balance >= target,
  };
}

export const weekendLeagueService = {
  async current(userId: string): Promise<WlCurrentResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    if (!tournament) {
      return { tournament: null, you: null };
    }

    const [counts, entry, qp] = await Promise.all([
      getOrLoadJson(
        `wl:counts:${tournament.id}`,
        COUNTS_CACHE_TTL_SECONDS,
        () => weekendLeagueRepo.getCounts(tournament.id)
      ),
      weekendLeagueRepo.getEntry(tournament.id, userId),
      loadQp(tournament, userId),
    ]);

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
        registered_count: counts.registered,
        checked_in_count: counts.checkedIn,
        launch_edition: launchEditionOf(tournament),
        qp_target: qpTargetOf(tournament),
      },
      you: {
        entered: entry != null,
        state: entry?.state ?? null,
        checked_in: entry?.checked_in_at != null,
        final_checked_in: entry?.final_checked_in_at != null,
        qp,
      },
    };
  },

  async qp(userId: string): Promise<WlQpResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
    return loadQp(tournament, userId);
  },

  async enter(userId: string): Promise<WlEnterResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
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

  async checkin(userId: string): Promise<WlCheckinResponse> {
    const tournament = await weekendLeagueRepo.getCurrentTournament();
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
