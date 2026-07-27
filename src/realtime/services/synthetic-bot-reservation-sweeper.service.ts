import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { config } from '../../core/config.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';

/**
 * Reconciliation sweeper for stranded persistent-bot reservations (Appendix A).
 *
 * A reservation should only outlive its lobby/match when a process crashed
 * between two steps of the lifecycle. This periodic job (same worker family as
 * the stale-match sweeper) reconciles EXPIRED reservations against ground truth:
 *
 *   - reservation carries match_id:
 *       match still active  → LIVE, extend heartbeat, never reclaim.
 *       match terminal/gone → release (a terminal hook was missed).
 *   - reservation is lobby-keyed (match_id NULL):
 *       lobby still exists                         → LIVE, extend, never reclaim.
 *       lobby gone BUT an active match exists for
 *         that lobby (crash between creation and
 *         transfer)                                → RE-KEY onto the match
 *                                                    (recover via matches.lobby_id
 *                                                    lineage), never release.
 *       lobby gone AND no active match             → release.
 *
 * The invariant "never reclaim while the referenced lobby/match is live" is
 * enforced by only ever acting on EXPIRED rows and re-checking liveness here.
 * Live reservations are heartbeated by the match lifecycle, so a healthy match's
 * reservation never expires under the sweeper in the first place.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 100;
const LIVE_HEARTBEAT_EXTENSION_SEC = 180;

let sweepTimer: NodeJS.Timeout | null = null;

async function reconcileOne(reservation: {
  bot_user_id: string;
  lobby_id: string;
  match_id: string | null;
}): Promise<void> {
  const { bot_user_id: botUserId, lobby_id: lobbyId, match_id: matchId } = reservation;

  if (matchId) {
    const match = await matchesRepo.getMatch(matchId);
    if (match && match.status === 'active') {
      // Live match whose reservation expired (heartbeat gap) — extend, keep.
      await syntheticBotsRepo.heartbeatReservation({
        botUserId,
        expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
      });
      appMetrics.persistentBotSweeperActions.add(1, { action: 'skipped_live' });
      return;
    }
    // Match terminal/gone — a completion/forfeit/sweep hook was missed.
    const released = await syntheticBotsRepo.releaseReservationByMatch(matchId);
    appMetrics.persistentBotSweeperActions.add(1, { action: 'release' });
    logger.info({ botUserId, matchId, released: released != null }, 'reservation sweeper released terminal-match reservation');
    return;
  }

  // Lobby-keyed reservation (no match_id yet). Recover a crash between match
  // creation and the reservation transfer FIRST, via matches.lobby_id lineage —
  // the lobby row may still exist at this point (transfer hadn't run), so the
  // active-match check must come before the lobby-existence check to avoid
  // stranding a reservation whose match already exists.
  const activeMatch = await matchesRepo.getActiveMatchForLobby(lobbyId);
  if (activeMatch) {
    const rekeyed = await syntheticBotsRepo.rekeyReservationToMatch({
      botUserId,
      lobbyId,
      matchId: activeMatch.id,
    });
    await syntheticBotsRepo.heartbeatReservation({
      botUserId,
      expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
    });
    appMetrics.persistentBotSweeperActions.add(1, { action: 'rekey' });
    logger.info({ botUserId, lobbyId, matchId: activeMatch.id, rekeyed }, 'reservation sweeper re-keyed stranded lobby reservation onto live match');
    return;
  }

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (lobby) {
    // Lobby still exists, no match yet — the pre-match flow may simply be slow
    // (or wedged shorter than a teardown hook can fire). Extend, never reclaim.
    await syntheticBotsRepo.heartbeatReservation({
      botUserId,
      expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
    });
    appMetrics.persistentBotSweeperActions.add(1, { action: 'skipped_live' });
    return;
  }

  // Lobby gone AND no active match — genuinely stranded, release.
  const released = await syntheticBotsRepo.releaseReservationByLobby(lobbyId);
  appMetrics.persistentBotSweeperActions.add(1, { action: 'release' });
  logger.info({ botUserId, lobbyId, released: released != null }, 'reservation sweeper released stranded lobby reservation');
}

export async function runReservationSweep(): Promise<void> {
  if (!config.PERSISTENT_BOTS_ENABLED) return;
  let expired: Awaited<ReturnType<typeof syntheticBotsRepo.listExpiredReservations>>;
  try {
    expired = await syntheticBotsRepo.listExpiredReservations(new Date(), SWEEP_BATCH_SIZE);
  } catch (err) {
    logger.warn({ err }, 'reservation sweeper query failed');
    return;
  }
  if (expired.length === 0) return;
  logger.info({ count: expired.length }, 'reservation sweeper found expired reservations');
  for (const reservation of expired) {
    try {
      await reconcileOne(reservation);
    } catch (err) {
      logger.warn({ err, botUserId: reservation.bot_user_id }, 'reservation sweeper failed to reconcile one reservation');
    }
  }
}

export function startReservationSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    void runReservationSweep();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  // One sweep shortly after boot recovers reservations stranded by the deploy
  // that just restarted the process.
  void runReservationSweep();
}

export function stopReservationSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
