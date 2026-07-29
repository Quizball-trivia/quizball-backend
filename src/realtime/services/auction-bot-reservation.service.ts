import { createHash } from 'node:crypto';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import { AUCTION_SEAT_COUNT } from '../../modules/auction/auction.constants.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';

/**
 * Reservation keying for persistent bots in AUCTION mode.
 *
 * Why auction cannot reuse the ranked lobby→match transfer
 * --------------------------------------------------------
 * `synthetic_bot_reservations.match_id` is UNIQUE and an auction seats up to TWO
 * bots in ONE match, so two reservations can never both carry the same match id.
 * Ranked's "acquire lobby-keyed → transfer onto match id" therefore cannot
 * represent an auction match at all.
 *
 * Instead auction reservations stay LOBBY-KEYED for their whole life, under a
 * per-seat SYNTHETIC lobby id deterministically derived from (matchId, seatIndex).
 * `lobby_id` is UNIQUE and carries no foreign key, so a derived uuid is a legal,
 * collision-free key — and because it is a pure function of the match id, ANY
 * teardown path can recompute the full key set from the match id alone, with no
 * extra state to persist or lose. That is what makes the terminal hooks and the
 * TTL sweeper able to reap these reservations without a match row existing.
 *
 * Why releases here are not settlement-gated
 * ------------------------------------------
 * The ranked settlement gate treats "no `matches` row" as proof that settlement
 * finished. Auction has NO `matches` row until the match finishes, so that
 * predicate is inverted for us: it would free a bot that is still bidding.
 * Auction liveness is a Redis fact instead, so callers gate on Redis (a finished
 * or vanished match state) and the delete itself is unconditional.
 */

// Namespace uuid for deriving per-seat reservation keys. Any fixed uuid works;
// this one is arbitrary and constant so derivation is stable across replicas and
// restarts (a changed namespace would orphan in-flight reservations).
const AUCTION_RESERVATION_NAMESPACE = '7f3a1c02-4d5b-4e18-9a6c-2b8e5d0f7a31';

/**
 * Deterministic RFC-4122-shaped v5-style uuid from (namespace, name).
 * Node has no built-in uuidv5 and the project has no `uuid` dependency, so this
 * derives one from a SHA-1 digest with the version/variant bits set — the same
 * construction uuidv5 uses, which is all we need for a stable unique key.
 */
function deriveUuid(name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(AUCTION_RESERVATION_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The reservation key for one bot seat of an auction match. */
export function auctionReservationKey(matchId: string, seatIndex: number): string {
  return deriveUuid(`auction:${matchId}:${seatIndex}`);
}

/**
 * EVERY reservation key an auction match could possibly hold. Derived purely
 * from the match id, so a teardown path never needs to know how many bots were
 * actually seated (or be able to read the state at all) to reap them.
 */
export function allAuctionReservationKeys(matchId: string): string[] {
  return Array.from({ length: AUCTION_SEAT_COUNT }, (_, index) => auctionReservationKey(matchId, index));
}

/**
 * Release every persistent-bot reservation held by an auction match.
 *
 * Idempotent and never throws: a stranded reservation is self-healed by the
 * sweeper, and a terminal teardown must never fail because of a bookkeeping
 * write. Safe to call for matches that had no persistent bots (deletes nothing).
 *
 * NOT flag-gated (kill-switch safety): reservations acquired while the flag was
 * on must still be released after it is turned off.
 */
export async function releaseAuctionReservations(
  matchId: string,
  path: 'finish' | 'forfeit_finish' | 'sweeper' | 'seating_failed',
): Promise<void> {
  try {
    const released = await syntheticBotsRepo.releaseAuctionReservations(allAuctionReservationKeys(matchId));
    if (released.length === 0) return;
    appMetrics.persistentBotReservationReleases.add(released.length, { path: `auction_${path}` });
    logger.info({ matchId, botUserIds: released, path }, 'auction persistent-bot reservations released');
  } catch (err) {
    logger.warn({ err, matchId, path }, 'auction persistent-bot reservation release failed');
  }
}

/** True when the match state has at least one persistent (userId-bearing) bot seat. */
export function hasPersistentBotSeat(state: AuctionMatchState): boolean {
  return state.seats.some((seat) => seat.isBot && Boolean(seat.userId));
}
