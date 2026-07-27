import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
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

// Beyond this age a lobby-keyed reservation whose lobby is still around but has
// produced no match is treated as wedged and released — an unbounded "lobby row
// exists → extend forever" would strand a bot permanently.
const MAX_LOBBY_KEYED_AGE_MS = 15 * 60 * 1000;
// A terminal (completed/abandoned) match's reservation is not released by the
// sweeper until its terminal transition is at least this old, so a release never
// races an in-flight RP settlement (status flips to completed before RP settles).
const SETTLEMENT_GRACE_MS = 2 * 60 * 1000;

async function reconcileOne(reservation: {
  bot_user_id: string;
  lobby_id: string;
  match_id: string | null;
  fence: number;
  acquired_at: string;
}): Promise<void> {
  const { bot_user_id: botUserId, lobby_id: lobbyId, match_id: matchId, fence } = reservation;

  if (matchId) {
    const match = await matchesRepo.getMatch(matchId);
    if (match && match.status === 'active') {
      // Live match whose reservation expired (heartbeat gap) — extend (fenced),
      // keep. A stale snapshot (fence mismatch) simply extends nothing.
      const extended = await syntheticBotsRepo.heartbeatReservationFenced({
        botUserId,
        expectedFence: fence,
        expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
      });
      appMetrics.persistentBotSweeperActions.add(1, { action: extended ? 'skipped_live' : 'stale_snapshot' });
      return;
    }
    // Match terminal/gone — a completion/forfeit/sweep hook was missed. Respect
    // a settlement grace: a match flips to 'completed' BEFORE RP settles, so
    // releasing immediately could free the bot while its profile is mid-write and
    // let a second match read a stale RP. Only release once the terminal
    // transition is safely older than settlement can take; otherwise wait for the
    // next sweep (the completion choke point normally releases it first anyway).
    const endedAtMs = match?.ended_at ? new Date(match.ended_at).getTime() : null;
    if (match && endedAtMs != null && Date.now() - endedAtMs < SETTLEMENT_GRACE_MS) {
      appMetrics.persistentBotSweeperActions.add(1, { action: 'settlement_grace' });
      logger.info({ botUserId, matchId }, 'reservation sweeper deferring release: settlement grace');
      return;
    }
    const released = await syntheticBotsRepo.releaseReservationByMatch(matchId);
    appMetrics.persistentBotSweeperActions.add(1, { action: 'release' });
    logger.info({ botUserId, matchId, released: released != null }, 'reservation sweeper released terminal-match reservation');
    return;
  }

  // Lobby-keyed reservation (no match_id yet). Recover a crash between match
  // creation and the reservation transfer FIRST, via matches.lobby_id lineage —
  // the lobby row may still exist at this point (transfer hadn't run), so the
  // active-match check must come before the lobby-existence check to avoid
  // stranding a reservation whose match already exists. Re-key is bot-qualified
  // (the reserved bot must be a match_player) so a duplicate-creation state
  // cannot re-key onto the wrong match.
  const activeMatch = await matchesRepo.getActiveMatchForLobby(lobbyId);
  if (activeMatch) {
    const rekeyed = await syntheticBotsRepo.rekeyReservationToMatch({
      botUserId,
      lobbyId,
      matchId: activeMatch.id,
      expectedFence: fence,
    });
    if (rekeyed) {
      appMetrics.persistentBotSweeperActions.add(1, { action: 'rekey' });
      logger.info({ botUserId, lobbyId, matchId: activeMatch.id }, 'reservation sweeper re-keyed stranded lobby reservation onto live match');
    } else {
      // Bot not a player of that match (wrong-match duplicate) OR a newer fence:
      // do NOT heartbeat — never extend a reservation we did not just re-key.
      appMetrics.persistentBotSweeperActions.add(1, { action: 'rekey_skipped' });
      logger.info({ botUserId, lobbyId, matchId: activeMatch.id }, 'reservation sweeper skipped re-key (bot not a player, or fence moved)');
    }
    return;
  }

  const lobbyLive =
    (await lobbiesRepo.getById(lobbyId)) != null &&
    (await syntheticBotsRepo.lobbyHasMembers(lobbyId));
  const ageMs = Date.now() - new Date(reservation.acquired_at).getTime();
  if (lobbyLive && ageMs < MAX_LOBBY_KEYED_AGE_MS) {
    // Lobby genuinely live (exists + has members) and not yet wedged — the
    // pre-match flow may simply be slow. Extend (fenced), never reclaim.
    const extended = await syntheticBotsRepo.heartbeatReservationFenced({
      botUserId,
      expectedFence: fence,
      expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
    });
    appMetrics.persistentBotSweeperActions.add(1, { action: extended ? 'skipped_live' : 'stale_snapshot' });
    return;
  }

  // Lobby gone / empty / wedged AND no active match — genuinely stranded,
  // release (fenced so a stale snapshot can't delete a newer reservation).
  const released = await syntheticBotsRepo.releaseReservationByLobbyFenced(lobbyId, fence);
  appMetrics.persistentBotSweeperActions.add(1, { action: 'release' });
  logger.info({ botUserId, lobbyId, ageMs, released: released != null }, 'reservation sweeper released stranded lobby reservation');
}

export async function runReservationSweep(): Promise<void> {
  // NOT flag-gated (kill-switch safety): reservations created while the flag was
  // on must still be reconciled after it is turned off.
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
