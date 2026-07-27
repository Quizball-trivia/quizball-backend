import { getRandom } from '../../core/rng.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { getRedisClient } from '../../realtime/redis.js';
import type { RankedProfileRow } from '../ranked/ranked.types.js';
import { selectionTargetRpForHuman } from '../ranked/ranked.service.js';
import { syntheticBotsRepo, type EligibleBotRow } from './synthetic-bots.repo.js';
import { reservationService } from './reservation.service.js';

/**
 * Live persistent-bot selection for the ranked AI-fallback seam (PR7).
 *
 * Contract (PERSISTENT-BOTS-PLAN §1.3 / §1.7):
 *   - Flag gated: caller only reaches here when PERSISTENT_BOTS_ENABLED is on.
 *   - Nearest-RP to the human's SELECTION TARGET (placement anchor for unplaced,
 *     current RP for placed), widening ±100 → ±250 → ±500 → closest.
 *   - Eligibility ladder relaxes SOFT constraints in fixed order:
 *       session preference → recently-faced → daily cap → schedule window.
 *     HARD constraints (status='active', not reserved) are enforced in SQL and
 *     NEVER relaxed. reserved is additionally guaranteed by the acquire race.
 *   - On a hit: acquire the reservation (ON CONFLICT DO NOTHING). If the acquire
 *     loses the race (another selection grabbed the same bot), try the next
 *     candidate; exhausting candidates → null (ephemeral fallback).
 *   - Empty roster / no eligible bot / all acquires lost → null → the caller
 *     runs the unchanged ephemeral path. Matchmaking never fails here.
 *
 * Telemetry: every terminal outcome increments persistentBotSelections tagged
 * with { outcome, relaxation } so PR9 can build alerting on it.
 */

const RESERVATION_TTL_SEC = 180; // lobby-lifetime lease; heartbeated across the match.
const RECENTLY_FACED_LIMIT = 5;
const WIDENING_BANDS = [100, 250, 500] as const;

function recentlyFacedKey(humanUserId: string): string {
  return `ranked:persistent:recent:${humanUserId}`;
}

/** The human's last N persistent-bot opponents (most-recent first). Best-effort. */
async function getRecentlyFaced(humanUserId: string): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return [];
  try {
    return await redis.lRange(recentlyFacedKey(humanUserId), 0, RECENTLY_FACED_LIMIT - 1);
  } catch (err) {
    logger.warn({ err, humanUserId }, 'persistent-bot recently-faced read failed');
    return [];
  }
}

/**
 * Record a persistent bot as a recent opponent for the human (LRU, capped at
 * RECENTLY_FACED_LIMIT). Called by the caller after a successful transfer so
 * the exclusion reflects matches that actually started. Best-effort.
 */
export async function recordRecentlyFaced(humanUserId: string, botUserId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  try {
    const key = recentlyFacedKey(humanUserId);
    await redis.lPush(key, botUserId);
    await redis.lTrim(key, 0, RECENTLY_FACED_LIMIT - 1);
    // No permanent memory of who a player has ever faced — only a short window.
    await redis.expire(key, 60 * 60 * 24 * 7);
  } catch (err) {
    logger.warn({ err, humanUserId, botUserId }, 'persistent-bot recently-faced write failed');
  }
}

/** Roster day (Tbilisi, 07:00 boundary) matching the repo's SQL bump semantics. */
function currentRosterDay(now = new Date()): string {
  // Shift back 7h so 06:59 Tbilisi still belongs to the previous roster day,
  // then take the Tbilisi calendar date. Computed via the en-CA locale which
  // yields YYYY-MM-DD.
  const shifted = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return shifted.toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
}

/** A bot's matches-today, correcting a stale matches_day to a fresh 0. */
function effectiveMatchesToday(bot: EligibleBotRow, rosterDay: string): number {
  return bot.matches_day === rosterDay ? bot.matches_today : 0;
}

/** Reads the bot's active-hour window from its schedule jsonb (defensive). */
function isWithinScheduleWindow(bot: EligibleBotRow, now = new Date()): boolean {
  const schedule = bot.schedule as { startHour?: unknown; endHour?: unknown } | null;
  const start = typeof schedule?.startHour === 'number' ? schedule.startHour : null;
  const end = typeof schedule?.endHour === 'number' ? schedule.endHour : null;
  // Missing/malformed schedule → treat as always in-window (schedule is the LAST
  // soft constraint relaxed anyway; a bad schedule must never hard-exclude).
  if (start === null || end === null) return true;
  const hourStr = now.toLocaleString('en-US', {
    timeZone: 'Asia/Tbilisi',
    hour: '2-digit',
    hour12: false,
  });
  const hour = Number.parseInt(hourStr, 10) % 24;
  if (start === end) return true;
  // Window may wrap past midnight (e.g. 22 → 2).
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

interface EligibilityLevel {
  /** Soft constraints STILL enforced at this level (dropped as we relax). */
  respectRecentlyFaced: boolean;
  respectDailyCap: boolean;
  respectSchedule: boolean;
  relaxationLabel: string;
}

// Relaxation ladder: session preference → recently-faced → daily cap → schedule.
// PR7 has no persisted session-preference signal yet (lands with the scheduler
// in a later PR); level 0 is the strictest currently expressible tier. Each step
// drops exactly one soft constraint, in the plan's fixed order.
const ELIGIBILITY_LADDER: EligibilityLevel[] = [
  { respectRecentlyFaced: true, respectDailyCap: true, respectSchedule: true, relaxationLabel: 'strict' },
  { respectRecentlyFaced: false, respectDailyCap: true, respectSchedule: true, relaxationLabel: 'relax_recently_faced' },
  { respectRecentlyFaced: false, respectDailyCap: false, respectSchedule: true, relaxationLabel: 'relax_daily_cap' },
  { respectRecentlyFaced: false, respectDailyCap: false, respectSchedule: false, relaxationLabel: 'relax_schedule' },
];

function passesLevel(
  bot: EligibleBotRow,
  level: EligibilityLevel,
  ctx: { recentlyFaced: Set<string>; rosterDay: string; now: Date },
): boolean {
  if (level.respectRecentlyFaced && ctx.recentlyFaced.has(bot.user_id)) return false;
  if (level.respectDailyCap && effectiveMatchesToday(bot, ctx.rosterDay) >= bot.daily_cap) return false;
  if (level.respectSchedule && !isWithinScheduleWindow(bot, ctx.now)) return false;
  return true;
}

/**
 * Order candidates by nearest RP to the target using the widening bands, then a
 * "closest" tail so the ladder can always fall through to the single nearest
 * eligible bot. Ties within a band are shuffled to avoid always picking the same
 * bot (spreads load + avoids a detectable pattern).
 */
function orderByNearestRp(bots: EligibleBotRow[], targetRp: number): EligibleBotRow[] {
  const byDistance = [...bots].sort((a, b) => {
    const da = Math.abs(a.rp - targetRp);
    const db = Math.abs(b.rp - targetRp);
    if (da !== db) return da - db;
    return getRandom() - 0.5;
  });
  // Bucket into the widening bands, shuffling within each band, then append the
  // remaining (beyond ±500) closest-first tail.
  const ordered: EligibleBotRow[] = [];
  const used = new Set<string>();
  for (const band of WIDENING_BANDS) {
    const inBand = byDistance.filter(
      (bot) => !used.has(bot.user_id) && Math.abs(bot.rp - targetRp) <= band,
    );
    for (let i = inBand.length - 1; i > 0; i--) {
      const j = Math.floor(getRandom() * (i + 1));
      [inBand[i], inBand[j]] = [inBand[j], inBand[i]];
    }
    for (const bot of inBand) {
      ordered.push(bot);
      used.add(bot.user_id);
    }
  }
  for (const bot of byDistance) {
    if (!used.has(bot.user_id)) ordered.push(bot);
  }
  return ordered;
}

export interface SelectedPersistentBot {
  bot: EligibleBotRow;
  reservation: { botUserId: string; lobbyId: string; fence: number };
  relaxationLevel: string;
  targetRp: number;
}

export const syntheticBotSelectionService = {
  RESERVATION_TTL_SEC,
  recordRecentlyFaced,

  /**
   * Select + reserve an eligible roster bot for a human's ranked AI-fallback.
   * Returns the selected bot (with its held reservation) or null → the caller
   * runs the unchanged ephemeral path.
   */
  async selectAndReserve(params: {
    humanUserId: string;
    humanProfile: RankedProfileRow;
    lobbyId: string;
  }): Promise<SelectedPersistentBot | null> {
    if (!reservationService.isEnabled()) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'flag_off', relaxation: 'none' });
      return null;
    }

    const now = new Date();
    const rosterDay = currentRosterDay(now);
    const targetRp = selectionTargetRpForHuman(params.humanProfile);

    const [eligible, recentlyFacedList] = await Promise.all([
      syntheticBotsRepo.listEligibleBots(),
      getRecentlyFaced(params.humanUserId),
    ]);

    if (eligible.length === 0) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'ephemeral_fallback', relaxation: 'empty_roster' });
      logger.info({ humanUserId: params.humanUserId, targetRp }, 'persistent-bot selection: empty roster, ephemeral fallback');
      return null;
    }

    const recentlyFaced = new Set(recentlyFacedList);
    const ordered = orderByNearestRp(eligible, targetRp);

    for (const level of ELIGIBILITY_LADDER) {
      const candidates = ordered.filter((bot) => passesLevel(bot, level, { recentlyFaced, rosterDay, now }));
      for (const bot of candidates) {
        const reservation = await reservationService.acquire({
          botUserId: bot.user_id,
          lobbyId: params.lobbyId,
          ttlSec: RESERVATION_TTL_SEC,
        });
        if (reservation) {
          appMetrics.persistentBotSelections.add(1, { outcome: 'hit', relaxation: level.relaxationLabel });
          logger.info(
            {
              humanUserId: params.humanUserId,
              botUserId: bot.user_id,
              lobbyId: params.lobbyId,
              targetRp,
              botRp: bot.rp,
              relaxation: level.relaxationLabel,
            },
            'persistent-bot selected + reserved',
          );
          return { bot, reservation, relaxationLevel: level.relaxationLabel, targetRp };
        }
        // Lost the acquire race — this bot is now reserved by someone else; try
        // the next candidate at this level.
      }
    }

    appMetrics.persistentBotSelections.add(1, { outcome: 'ephemeral_fallback', relaxation: 'ladder_exhausted' });
    logger.info(
      { humanUserId: params.humanUserId, targetRp, eligibleCount: eligible.length },
      'persistent-bot selection: ladder exhausted, ephemeral fallback',
    );
    return null;
  },
};
