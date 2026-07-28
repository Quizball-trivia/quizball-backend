import { randomUUID } from 'node:crypto';
import type { TransactionSql } from '../../db/index.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { syntheticBotsRepo } from './synthetic-bots.repo.js';

/**
 * Reservation lifecycle facade for the persistent-bot roster.
 *
 * Every teardown site in Appendix A routes its release through here so the
 * telemetry, flag-gating, and error isolation live in one place. All calls are
 * no-ops when PERSISTENT_BOTS_ENABLED is off OR when no reservation row exists
 * for the given lobby/match (the ephemeral case) — a release hook never has to
 * know whether the opponent was a persistent bot.
 *
 * A DB error here is always swallowed (logged): the durable match/lobby teardown
 * has already happened, and a stranded reservation is self-healed by the
 * reconciliation sweeper. A release must never throw back into a teardown path.
 */

// Per-process holder token. Stable within a replica, unique across replicas and
// restarts, so a crashed/old holder can never owner-qualified-release a
// reservation the bot has since re-acquired under a newer fence.
const HOLDER_ID = `persistent-bot:${process.pid}:${randomUUID().slice(0, 8)}`;

export type ReservationReleasePath =
  | 'abort_before_match_creation'
  | 'abort_start_for_tickets'
  | 'cleanup_superseded_lobby'
  | 'auto_leave_lobby'
  | 'close_pre_match_lobby'
  | 'remove_user_from_lobby'
  | 'match_found_cancel'
  | 'draft_start_cancel'
  | 'draft_start_error'
  | 'self_forfeit'
  | 'no_contest'
  | 'disconnect_terminal'
  | 'orphan_resolver'
  | 'stale_sweeper'
  | 'completion'
  | 'pre_match_abandon';

function persistentBotsEnabled(): boolean {
  return config.PERSISTENT_BOTS_ENABLED === true;
}

export const reservationService = {
  get holderId(): string {
    return HOLDER_ID;
  },

  isEnabled(): boolean {
    return persistentBotsEnabled();
  },

  /**
   * Acquire a reservation for a candidate bot. Returns the acquired row (with
   * its fence) on a win, or null if the bot was already reserved (lost race) or
   * the flag is off. Selection is the only acquirer.
   */
  async acquire(params: {
    botUserId: string;
    lobbyId: string;
    ttlSec: number;
  }): Promise<{ botUserId: string; lobbyId: string; fence: number } | null> {
    if (!persistentBotsEnabled()) return null;
    const expiresAt = new Date(Date.now() + params.ttlSec * 1000);
    try {
      const row = await syntheticBotsRepo.acquireReservation({
        botUserId: params.botUserId,
        lobbyId: params.lobbyId,
        holder: HOLDER_ID,
        expiresAt,
      });
      if (!row) return null;
      return { botUserId: row.bot_user_id, lobbyId: row.lobby_id, fence: row.fence };
    } catch (err) {
      logger.warn({ err, ...params }, 'persistent-bot reservation acquire failed');
      return null;
    }
  },

  /**
   * Transfer a lobby-keyed reservation onto its match, INSIDE the caller's match
   * -creation transaction so the match row and the reservation's match_id commit
   * atomically. Returns whether a row was transferred so the caller can bump the
   * bot's daily counters exactly once.
   *
   * NOT flag-gated (kill-switch safety): a reservation row only exists if the
   * flag was on at acquire time; if the flag flips off mid-match the transfer of
   * the ALREADY-ACQUIRED reservation must still complete, else the row is
   * orphaned. No-op when the lobby has no reservation (ephemeral lobbies).
   */
  async transferInTx(
    tx: TransactionSql,
    params: { botUserId: string; lobbyId: string; matchId: string },
  ): Promise<boolean> {
    const row = await syntheticBotsRepo.transferReservationToMatch(tx, params);
    return row != null;
  },

  // Releases are NEVER flag-gated (kill-switch safety): they operate on existing
  // reservation rows unconditionally and no-op when none exists, so reservations
  // created while the flag was on are still cleaned up after it is turned off.
  //
  // There is deliberately NO owner-qualified lobby-phase release (holder+fence):
  // it would race draft activation like any other lobby-keyed release. Every
  // lobby-phase release goes through abortLobby (advisory-lock serialized). Only
  // by-MATCH releases (post-transfer, match_id set) are unlocked (different key
  // space) — see releaseIfSettled / releaseByMatch below.

  /**
   * The ONE AND ONLY lobby-phase reservation-release path. Closes the abort
   * TOCTOU by delegating to abortRankedAiLobbyLocked, which takes the SHARED
   * per-lobby advisory lock (the same lock draft activation takes), re-reads the
   * lobby status under it, and — only if still 'waiting'/gone — atomically frees
   * the (lobby-keyed) reservation, removes EVERY member, and deletes the lobby.
   * If a concurrent reconnect advanced the lobby waiting→active, this no-ops
   * entirely (no release, no teardown) so the live draft keeps the bot. There is
   * deliberately NO "release the bot but keep the lobby" variant — that would
   * leave a waiting lobby a reconnect could activate with an already-freed bot.
   *
   * Returns { aborted, botReleased, lobbyDeleted, removedMemberIds } so the caller
   * can do the remaining idempotent Redis/socket cleanup outside the transaction.
   */
  async abortLobby(
    lobbyId: string,
    path: ReservationReleasePath,
  ): Promise<{ aborted: boolean; botReleased: string | null; lobbyDeleted: boolean; removedMemberIds: string[] }> {
    try {
      const result = await syntheticBotsRepo.abortRankedAiLobbyLocked(lobbyId);
      if (result.botReleased) {
        appMetrics.persistentBotReservationReleases.add(1, { path });
        logger.info({ botUserId: result.botReleased, lobbyId, path, mode: 'abort_locked' }, 'persistent-bot reservation released (lobby abort, locked)');
      }
      return result;
    } catch (err) {
      logger.warn({ err, lobbyId, path }, 'persistent-bot locked lobby-abort failed');
      return { aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] };
    }
  },

  /**
   * SETTLEMENT-GATED terminal release keyed by match — the SINGLE choke point for
   * every terminal teardown site (completion, forfeit, disconnect, orphan,
   * sweeper). Frees the bot ONLY when its settlement is provably done (its own
   * ranked_rp_changes row exists, OR the match is 'abandoned'/no-contest, OR the
   * match row is gone). A caught-and-swallowed settlement failure therefore can
   * NEVER release the bot early — the reservation stays and a later replay/sweep
   * releases it once the ledger lands. Predicate is evaluated inside the DELETE,
   * so it is race-free w.r.t. a concurrent settlement commit. No-op if the match
   * has no reservation (ephemeral / human-vs-human).
   */
  async releaseIfSettled(matchId: string, path: ReservationReleasePath): Promise<void> {
    try {
      const botUserId = await syntheticBotsRepo.releaseReservationByMatchIfSettled(matchId);
      if (botUserId) {
        appMetrics.persistentBotReservationReleases.add(1, { path });
        logger.info({ botUserId, matchId, path, mode: 'if_settled' }, 'persistent-bot reservation released (settlement confirmed)');
      }
    } catch (err) {
      logger.warn({ err, matchId, path }, 'persistent-bot reservation settlement-gated release failed');
    }
  },

  /**
   * Terminal release keyed by match (any holder), UNCONDITIONAL. Only for
   * NO-SETTLEMENT terminal paths (pre-match abandon before any RP could settle).
   * For any path where a ranked settlement may run, use releaseIfSettled instead.
   */
  async releaseByMatch(matchId: string, path: ReservationReleasePath): Promise<void> {
    try {
      const botUserId = await syntheticBotsRepo.releaseReservationByMatch(matchId);
      if (botUserId) {
        appMetrics.persistentBotReservationReleases.add(1, { path });
        logger.info({ botUserId, matchId, path, mode: 'by_match' }, 'persistent-bot reservation released');
      }
    } catch (err) {
      logger.warn({ err, matchId, path }, 'persistent-bot reservation match-release failed');
    }
  },
};
