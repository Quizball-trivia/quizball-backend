/**
 * Host-run events: a live quiz night (e.g. the Orshabatoba podcast) that has
 * no scheduled kickoff. Players register on the Events tab; ONE named account
 * (config.host_email) presses Start; everyone registered is checked in and
 * the same WL live engine kicks the game off after a 1-minute countdown, so the
 * whole room gets the same question at the same moment.
 *
 * The row is an is_test tournament (free entry, single game, public bank,
 * no badges / QP / emails) carrying host_email in its config.
 */

import { logger } from '../../core/logger.js';
import { AuthorizationError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { weekendLeagueRepo } from './weekend-league.repo.js';
import { wlHostEmailOf } from './wl-config.js';
import { wlOrchestratorRepo } from './wl-orchestrator.repo.js';
import { applyWeeklyShowPack, getWlOrchestratorIo, wlAdvanceOneTournament, WL_MIN_FIELD } from './wl-orchestrator.js';
import { wlRedisNowMs } from './wl-redis.js';
import { scheduleWlTick } from './wl-timer.js';

/** The countdown between Start and the first question. Registration stays
 *  open through it (late registrants are seated at once) and closes at 0. */
export const WL_HOST_COUNTDOWN_MS = 60_000;

export type WlHostStartResult = {
  started: boolean;
  reason: 'ok' | 'already_started' | 'not_enough_players' | 'not_open' | 'questions_updating' | 'questions_invalid' | 'wrong_event';
  kickoff_at_ms: number | null;
  registered: number;
};

export async function wlHostStart(
  user: { id: string; email?: string | null },
  /** The event the host's screen shows; a Start for any other event is refused. */
  tournamentId: string
): Promise<WlHostStartResult> {
  const t = await weekendLeagueRepo.getCurrentTournament();
  const hostEmail = t?.is_test ? wlHostEmailOf(t.config) : null;
  if (!t || hostEmail == null) throw new NotFoundError('No host-run event');
  if ((user.email ?? '').trim().toLowerCase() !== hostEmail) {
    throw new AuthorizationError('Only the event host can start this event');
  }
  if (tournamentId !== t.id) {
    const { registered } = await weekendLeagueRepo.getCounts(t.id);
    return { started: false, reason: 'wrong_event', kickoff_at_ms: null, registered };
  }

  // The hosts play too: their Start registers them first (a no-op if already in; the window is still open here).
  if (t.status === 'entry_open') {
    const { weekendLeagueService } = await import('./weekend-league.service.js');
    await weekendLeagueService.enter(user.id, t.id).catch((error) => {
      logger.warn({ err: error, tournamentId: t.id, hostUserId: user.id }, 'WL host start: host self-entry failed');
    });
  }

  const kickoffOf = (iso: string | null): number | null => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const { registered } = await weekendLeagueRepo.getCounts(t.id);

  if (['entry_closed', 'checkin', 'game_live', 'break', 'final_live'].includes(t.status)) {
    return { started: false, reason: 'already_started', kickoff_at_ms: kickoffOf(t.qualifier_starts_at), registered };
  }
  if (t.status !== 'entry_open') {
    // scheduled / content_pending / ready: questions are still being drawn.
    throw new BadRequestError(`Event is not open yet (status ${t.status})`);
  }
  if (registered < WL_MIN_FIELD) {
    return { started: false, reason: 'not_enough_players', kickoff_at_ms: null, registered };
  }

  // Swap in a just-loaded pack now rather than waiting up to one orchestrator tick.
  const eventDate = typeof t.config?.['event_date'] === 'string' ? t.config['event_date'] : null;
  if (eventDate) {
    await applyWeeklyShowPack(t.id, eventDate).catch((error) => {
      logger.warn({ err: error, tournamentId: t.id }, 'WL host start: pack apply before start failed');
    });
  }

  const redisNow = await wlRedisNowMs();
  const kickoffAtMs = redisNow + WL_HOST_COUNTDOWN_MS;
  const { moved, questions } = await weekendLeagueRepo.hostStartClock(t.id, kickoffAtMs);
  if (questions !== 'ok') {
    return { started: false, reason: questions === 'updating' ? 'questions_updating' : 'questions_invalid', kickoff_at_ms: null, registered };
  }
  if (!moved) {
    const fresh = await weekendLeagueRepo.getTournamentById(t.id);
    return {
      started: false,
      reason: fresh && fresh.status !== 'entry_open' ? 'already_started' : 'not_open',
      kickoff_at_ms: kickoffOf(fresh?.qualifier_starts_at ?? null),
      registered,
    };
  }

  // Phase events for every client (CAS — the orchestrator may win either
  // step on its own now that the clock fields are due; the loser no-ops).
  const closed = await wlOrchestratorRepo.transition({
    tournamentId: t.id, from: 'entry_open', to: 'entry_closed', redisTimeMs: redisNow,
    eventPayload: { host_start: true },
  });
  if (!closed) {
    // The orchestrator may have moved it first (fine); anything but a pre-game phase means it did not start.
    const fresh = await weekendLeagueRepo.getTournamentById(t.id);
    if (!fresh || !['entry_closed', 'checkin', 'game_live'].includes(fresh.status)) {
      logger.error({ tournamentId: t.id, status: fresh?.status }, 'WL host start: kickoff claimed but the event left the pre-game phases');
      return { started: false, reason: 'not_open', kickoff_at_ms: null, registered };
    }
  }
  await wlOrchestratorRepo.transition({
    tournamentId: t.id, from: 'entry_closed', to: 'checkin', redisTimeMs: redisNow,
    eventPayload: { host_start: true, kickoff_at_ms: kickoffAtMs },
  });
  logger.warn({ tournamentId: t.id, hostUserId: user.id, kickoffAtMs, registered }, 'WL host start');

  // Wake-ups at kickoff on the durable timer (the loop also covers it).
  await scheduleWlTick(t.id, kickoffAtMs + 50).catch(() => {});
  await scheduleWlTick(t.id, kickoffAtMs + 1_500).catch(() => {});
  const io = getWlOrchestratorIo();
  if (io) {
    await wlAdvanceOneTournament(io, t.id).catch((error) => {
      logger.warn({ err: error, tournamentId: t.id }, 'WL host start: immediate advance failed');
    });
  }
  return { started: true, reason: 'ok', kickoff_at_ms: kickoffAtMs, registered };
}
