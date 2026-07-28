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
    // Terminal-looking match. Release ONLY when settlement is provably done —
    // checked by DIRECT FACTS, never by age, and gated on THIS BOT's own ledger
    // row (settlement supports partial ledgers). Uses the same atomic,
    // settlement-gated DELETE as every terminal release site — race-free w.r.t. a
    // concurrent settlement commit, and a no-op while the bot is unsettled (left
    // for a later sweep). Only 'active' matches were handled above; a completed
    // match whose bot ledger hasn't landed simply isn't freed here.
    const released = await syntheticBotsRepo.releaseReservationByMatchIfSettled(matchId);
    if (released) {
      appMetrics.persistentBotSweeperActions.add(1, { action: 'release' });
      logger.info({ botUserId, matchId }, 'reservation sweeper released terminal-match reservation (settlement confirmed)');
    } else {
      appMetrics.persistentBotSweeperActions.add(1, { action: 'settlement_pending' });
      logger.info({ botUserId, matchId }, 'reservation sweeper deferring release: settlement not yet committed for this bot');
    }
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

  // Lobby gone / empty / wedged AND no active match — genuinely stranded. We
  // have already ruled out a live match (returned above) and a live lobby
  // (returned above), so if this reservation is COMMITTED it is a draft that
  // CRASHED after activation (Sol point 4): uncommitFirst clears the commit flag
  // in the SAME locked tx as the abort so the bot is reclaimed atomically. The
  // advisory lock still serializes with any concurrent activation.
  const result = await syntheticBotsRepo.abortRankedAiLobbyLocked(lobbyId, { uncommitFirst: true });
  appMetrics.persistentBotSweeperActions.add(1, { action: result.aborted ? 'release' : 'skipped_live' });
  logger.info(
    { botUserId, lobbyId, ageMs, aborted: result.aborted, released: result.botReleased != null, lobbyDeleted: result.lobbyDeleted },
    'reservation sweeper resolved stranded lobby reservation via locked abort',
  );
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
