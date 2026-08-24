import { logger } from '../../core/logger.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { syntheticBotSelectionService } from '../../modules/synthetic-bots/synthetic-bot-selection.service.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import { generateRankedAiAvatarUrl } from '../ai-ranked.constants.js';
import { tierFromRp } from '../../modules/ranked/season-rp-formula.js';
import { auctionReservationKey, releaseAuctionReservations } from './auction-bot-reservation.service.js';
import type { AuctionBotProfile } from './auction-bot-profile.js';

/**
 * Seat payload for one auction bot. `userId` is set only for PERSISTENT roster
 * bots; ephemeral bots keep the historical `userId: null` shape.
 */
export interface AuctionBotSeatProfile {
  userId?: string | null;
  displayName: string;
  avatarUrl: string | null;
  botProfile?: AuctionBotProfile | null;
  tier?: string | null;
  rp?: number | null;
}

function stableNameHash(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

/**
 * Plausible ranked identity for a bot's showdown card, deterministic per name
 * so the same bot always shows the same tier/RP. Bots must read as ordinary
 * players (product rule), so an empty frame is not an option.
 */
export function fabricatedRankedIdentity(displayName: string): { tier: string; rp: number } {
  const hash = stableNameHash(displayName);
  const rp = 350 + (hash % 1400);
  return { tier: tierFromRp(rp), rp };
}

/**
 * Give an ephemeral fallback bot a stable personality instead of routing every
 * fallback seat through one shared behaviour. Persistent roster bots keep their
 * real stored profiles; this only covers flag-off, thin-roster and degraded-DB
 * matches.
 *
 * The independent name hashes deliberately span weak-to-smart, erratic-to-
 * consistent and conservative-to-aggressive behaviour. `resolveAuctionBotBehaviour`
 * turns these three inputs into willingness, jump frequency, pace, chemistry
 * awareness and budget discipline, so a nickname keeps the same recognizable
 * style across matches without revealing that it is automated.
 */
export function fabricatedAuctionBotProfile(displayName: string): AuctionBotProfile {
  const skillTrait = stableNameHash(`skill:${displayName}`) / 0xffffffff;
  const consistencyTrait = stableNameHash(`consistency:${displayName}`) / 0xffffffff;
  const personalitySeed = stableNameHash(`personality:${displayName}`) || 1;

  return {
    baseSkill: 0.15 + skillTrait * 0.75,
    consistency: 0.2 + consistencyTrait * 0.7,
    personalitySeed,
  };
}

/**
 * Reserve up to `count` persistent roster bots for an auction match.
 *
 * Mirrors lobby-ranked-ai.service.ts (persistent first, ephemeral fallback, all
 * gated on PERSISTENT_BOTS_ENABLED), with three auction-specific differences:
 *
 *  1. Reservations are keyed by a per-seat SYNTHETIC uuid derived from the match
 *     id, NOT by a lobby id that later transfers onto the match. `match_id` is
 *     UNIQUE and an auction can seat TWO bots in one match, so the ranked
 *     transfer shape cannot represent it. See auction-bot-reservation.service.ts.
 *  2. Selection runs at MATCH-CREATION time (the match id already exists), so no
 *     "queue anchor" reservation is ever held during the staged pre-match
 *     backfill. The queue's staged backfill only ever increments a COUNT for the
 *     client's search animation — it never needs a bot identity — so anchoring
 *     early would hold roster bots hostage for the whole search with nothing to
 *     show for it, and would strand them whenever a search is cancelled.
 *  3. The daily counter is bumped right after a successful acquire rather than
 *     inside a match-creation transaction, because auction creates no `matches`
 *     row until the match finishes.
 *
 * PARTIAL results are intentional and safe: seats we could not reserve fall back
 * to ephemeral profiles, so a thin roster degrades seat-by-seat instead of
 * failing the match. Returns [] when the flag is off or nothing could be
 * reserved — the caller then generates ephemeral profiles exactly as before.
 *
 * Never throws: any failure degrades to the ephemeral path (a match must never
 * fail to start because the roster is unavailable).
 */
export async function reserveAuctionPersistentBots(params: {
  matchId: string;
  count: number;
  humanUserIds: readonly string[];
}): Promise<AuctionBotSeatProfile[]> {
  const { matchId, count, humanUserIds } = params;
  if (count <= 0 || !reservationService.isEnabled()) return [];

  const primaryHumanId = humanUserIds[0];
  if (!primaryHumanId) return [];

  const seats: AuctionBotSeatProfile[] = [];
  try {
    // Anchor selection on the primary human's ranked profile so auction opponents
    // are drawn from the same RP neighbourhood ranked would pick — the roster has
    // no separate auction rating.
    const humanProfile = await rankedService.ensureProfile(primaryHumanId);

    for (let seatIndex = 0; seatIndex < count; seatIndex++) {
      const selected = await syntheticBotSelectionService.selectAndReserve({
        humanUserId: primaryHumanId,
        humanProfile,
        // The per-seat derived key IS the reservation's lobby_id for its whole
        // life; it is never transferred.
        lobbyId: auctionReservationKey(matchId, seatIndex),
        mode: 'auction',
        excludeBotUserIds: seats.map((seat) => seat.userId as string),
      });
      if (!selected) break; // Roster exhausted → remaining seats go ephemeral.

      const { bot } = selected;
      seats.push({
        userId: bot.user_id,
        displayName: bot.nickname ?? 'Player',
        avatarUrl: bot.avatar_url ?? generateRankedAiAvatarUrl(96),
        botProfile: {
          baseSkill: bot.base_skill,
          consistency: bot.consistency,
          personalitySeed: Number(bot.personality_seed) || 0,
        },
        // Stable card identity; roster bots have real ranked presence but the
        // fabricated pair avoids an extra profile query per seat and stays
        // consistent for the same bot across matches.
        ...fabricatedRankedIdentity(bot.nickname ?? bot.user_id),
      });

      // Daily-cap accounting is SHARED with ranked: an auction seating consumes
      // one of the bot's matches for the Georgia day, so a bot cannot play ranked
      // and auction around the clock. Best-effort — a failed bump must not strand
      // an already-acquired reservation or block the match.
      await syntheticBotsRepo.bumpMatchesTodayForAuction(bot.user_id).catch((err) => {
        logger.warn({ err, botUserId: bot.user_id, matchId }, 'auction persistent-bot daily bump failed');
      });

      // Best-effort recent-opponent memory, same as ranked, so the same human
      // does not face the same bot repeatedly.
      void syntheticBotSelectionService
        .recordRecentlyFaced(primaryHumanId, bot.user_id)
        .catch(() => undefined);
    }
  } catch (err) {
    logger.warn({ err, matchId }, 'auction persistent-bot selection failed; falling back to ephemeral');
    // Release anything acquired before the throw so no bot is stranded by a
    // half-finished selection.
    if (seats.length > 0) {
      await releaseAuctionReservations(matchId, 'seating_failed');
      return [];
    }
  }

  if (seats.length > 0) {
    logger.info(
      { matchId, persistentSeats: seats.length, requested: count },
      'auction seated persistent bots',
    );
  }
  return seats;
}
