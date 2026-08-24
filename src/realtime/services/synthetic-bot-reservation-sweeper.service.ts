import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import { isAuctionReservationHolder } from '../../modules/synthetic-bots/reservation.service.js';
import { auctionStateStore } from '../../modules/auction/auction-state.store.js';
import { allAuctionReservationKeys } from './auction-bot-reservation.service.js';

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

/**
 * Is an AUCTION reservation's match still live?
 *
 * Called only for rows already identified as auction-owned by their `holder`
 * tag, so this decides liveness alone:
 *   - `true`  → the match is still in Redis (keep + heartbeat).
 *   - `false` → its Redis state is gone (finished/TTL-expired) → safe to reap.
 *
 * Recognition RECOMPUTES the derived key set for every currently-active auction
 * match, because auction keys are derived rather than stored. The active-match
 * set is small (concurrent auctions only) and this runs once a minute over
 * EXPIRED rows, so it is cheap and needs no schema change.
 *
 * Fails CLOSED: if Redis is unreachable we cannot prove the match is gone, so we
 * report the reservation as live and let a later sweep decide. Releasing on a
 * Redis blip would free a bot in the middle of a match.
 */
async function isAuctionReservationLive(lobbyId: string): Promise<boolean> {
  try {
    const activeMatchIds = await auctionStateStore.listActiveMatchIds();
    return activeMatchIds.some((matchId) => allAuctionReservationKeys(matchId).includes(lobbyId));
  } catch (err) {
    logger.warn({ err, lobbyId }, 'auction reservation liveness check failed; treating as live');
    return true;
  }
}

async function reconcileOne(reservation: {
  bot_user_id: string;
  lobby_id: string;
  match_id: string | null;
  holder: string;
  fence: number;
  acquired_at: string;
}): Promise<void> {
  const { bot_user_id: botUserId, lobby_id: lobbyId, match_id: matchId, fence } = reservation;

  // AUCTION reservations are reconciled FIRST and by their own rules, identified
  // exactly by their holder tag. They stay lobby-keyed for life under a uuid
  // derived from the auction match id (auction-bot-reservation.service.ts) and
  // have NO lobbies row and NO matches row while live, so every ranked branch
  // below would misread them — the lobby lookup finds nothing and the row would
  // be released while the bot is still bidding. Auction liveness is a REDIS fact.
  if (isAuctionReservationHolder(reservation.holder)) {
    if (await isAuctionReservationLive(lobbyId)) {
      // Live auction match still in Redis — extend (fenced), never reclaim.
      const extended = await syntheticBotsRepo.heartbeatReservationFenced({
        botUserId,
        expectedFence: fence,
        expiresAt: new Date(Date.now() + LIVE_HEARTBEAT_EXTENSION_SEC * 1000),
      });
      appMetrics.persistentBotSweeperActions.add(1, { action: extended ? 'skipped_live' : 'stale_snapshot' });
      return;
    }
    // The auction match's Redis state is gone (finished + cleared, or TTL-expired)
    // and no terminal hook freed this bot — reap it.
    const released = await syntheticBotsRepo.releaseAuctionReservations([lobbyId]);
    appMetrics.persistentBotSweeperActions.add(1, { action: released.length > 0 ? 'release' : 'skipped_live' });
    if (released.length > 0) {
      logger.info({ botUserId, lobbyId }, 'reservation sweeper released stranded auction reservation (match state gone)');
    }
    return;
  }

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

  // Lobby gone / empty / wedged, and (via the checks above, OUTSIDE the lock) no
  // active match at snapshot time — likely a draft that CRASHED after activation.
  // We pass teardown-intent (uncommitFirst), but the AUTHORITATIVE decision is
  // the DYNAMIC live-match check INSIDE abortRankedAiLobbyLocked's advisory-locked
  // tx: if a reconnect activated + created a match between our snapshot and the
  // lock acquisition, that in-lock check sees it and no-ops (never clears the
  // fresh commit). Only a genuinely-stranded reservation (no match under the
  // lock) is reclaimed.
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
