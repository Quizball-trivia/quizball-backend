import { getRandom } from '../../core/rng.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { getRedisClient } from '../../realtime/redis.js';
import type { RankedProfileRow } from '../ranked/ranked.types.js';
import { selectionTargetRpForHuman } from '../ranked/ranked.service.js';
import { syntheticBotsRepo, type EligibleBotRow } from './synthetic-bots.repo.js';
import { reservationService } from './reservation.service.js';
import { isWithinScheduleWindow } from './activity-window.js';
import { loadBotTuning } from '../bots/tuning/tuning-config.service.js';
import { MAX_DAILY_CAP } from '../bots/tuning/tuning.schemas.js';

/**
 * Live persistent-bot selection for the ranked AI-fallback seam (PR7).
 *
 * Contract (PERSISTENT-BOTS-PLAN §1.3 / §1.7):
 *   - Flag gated: caller only reaches here when PERSISTENT_BOTS_ENABLED is on.
 *   - Nearest-RP to the human's SELECTION TARGET (placement anchor for unplaced,
 *     current RP for placed), widening ±150 → ±BOT_PAIRING_MAX_RP_GAP (300) and
 *     then STOPPING. There is deliberately no unbounded tail: no bot inside the
 *     ceiling → null → ephemeral fallback, rather than a lopsided pairing.
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
// Inner parity band. Prod evidence (2026-07-31): at a gap ≤150 RP bots win ~32%
// of matches; beyond it the human is overwhelmingly the stronger side (77% of
// bot matches paired a human 150+ RP above the bot, which bots won 4.5% of).
const INNER_BAND_RP = 150;

/**
 * Widening bands, tightest first, capped by BOT_PAIRING_MAX_RP_GAP. Read per
 * selection so an env change takes effect on the next match without a deploy.
 * The cap's floor (150) equals the inner band, so a fully-tightened config
 * collapses to a single ±150 band rather than producing an empty ladder.
 */
function wideningBands(): number[] {
  const maxGap = config.BOT_PAIRING_MAX_RP_GAP;
  return maxGap <= INNER_BAND_RP ? [maxGap] : [INNER_BAND_RP, maxGap];
}
// Cap total acquire (ON CONFLICT DO NOTHING) attempts across the whole eligibility
// ladder for one selection. Each attempt is a DB round-trip; under heavy
// contention many candidates may be concurrently reserved, so bound the work and
// fall back to ephemeral rather than hammering the DB across a large roster.
const MAX_ACQUIRE_ATTEMPTS = 12;

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

// A bot "prefers" to be playing right now: it is within its active schedule
// window AND either continuing a live session (last_session_at within the
// session-gap window) or has no recent session (fresh start in-window). This is
// the STRICTEST eligibility rung — dropped first when the pool is empty.
const SESSION_GAP_MS = 20 * 60 * 1000; // matches the 20-min session segmentation used to learn archetypes.
function prefersSessionNow(bot: EligibleBotRow, now: Date): boolean {
  if (!isWithinScheduleWindow(bot.schedule, now)) return false;
  const schedule = bot.schedule as { last_session_at?: unknown } | null;
  const lastRaw = schedule?.last_session_at;
  const lastMs = typeof lastRaw === 'string' ? Date.parse(lastRaw) : NaN;
  if (Number.isNaN(lastMs)) return true; // in-window, no recent session → fresh start is a preference
  return now.getTime() - lastMs <= SESSION_GAP_MS; // continuing an active session
}

interface EligibilityLevel {
  /** Soft constraints STILL enforced at this level (dropped as we relax). */
  respectSessionPreference: boolean;
  respectRecentlyFaced: boolean;
  respectDailyCap: boolean;
  respectSchedule: boolean;
  relaxationLabel: string;
}

// Relaxation ladder in the plan's fixed order (§1.3):
//   session preference → recently-faced → daily cap → schedule window.
// Each step drops exactly one soft constraint (strictest first).
const ELIGIBILITY_LADDER: EligibilityLevel[] = [
  { respectSessionPreference: true, respectRecentlyFaced: true, respectDailyCap: true, respectSchedule: true, relaxationLabel: 'strict' },
  { respectSessionPreference: false, respectRecentlyFaced: true, respectDailyCap: true, respectSchedule: true, relaxationLabel: 'relax_session_preference' },
  { respectSessionPreference: false, respectRecentlyFaced: false, respectDailyCap: true, respectSchedule: true, relaxationLabel: 'relax_recently_faced' },
  { respectSessionPreference: false, respectRecentlyFaced: false, respectDailyCap: false, respectSchedule: true, relaxationLabel: 'relax_daily_cap' },
  { respectSessionPreference: false, respectRecentlyFaced: false, respectDailyCap: false, respectSchedule: false, relaxationLabel: 'relax_schedule' },
];

/**
 * The OPERATOR cap on a bot's matches today: the generated per-bot cap scaled
 * by the activity knob and clamped to the roster-wide ceiling (PR10).
 *
 * Enforced as a HARD constraint in passesLevel — never relaxed by the
 * eligibility ladder. Floors at 0 rather than 1 so activityScale = 0 genuinely
 * idles the roster, which is the point of the knob during an incident.
 */
export function operatorDailyCap(
  dailyCap: number,
  tuning: { activityScale: number; maxDailyCap: number },
): number {
  const scaled = Math.floor(dailyCap * tuning.activityScale);
  return Math.max(0, Math.min(scaled, tuning.maxDailyCap));
}

/**
 * Has the operator actually throttled the roster? Only then does the cap above
 * become a hard constraint — at defaults (scale 1, cap at the rail) the
 * generated daily_cap keeps its original SOFT, ladder-relaxable behaviour.
 */
export function isThrottled(tuning: { activityScale: number; maxDailyCap: number }): boolean {
  return tuning.activityScale < 1 || tuning.maxDailyCap < MAX_DAILY_CAP;
}

function passesLevel(
  bot: EligibleBotRow,
  level: EligibilityLevel,
  ctx: {
    recentlyFaced: Set<string>;
    rosterDay: string;
    now: Date;
    tuning: { activityScale: number; maxDailyCap: number };
  },
): boolean {
  const matchesToday = effectiveMatchesToday(bot, ctx.rosterDay);

  // HARD, never relaxed: the OPERATOR activity cap, but ONLY where the operator
  // has actually throttled the roster (activityScale < 1 or a tightened
  // maxDailyCap). The generated per-bot daily_cap below stays a SOFT realism
  // constraint the ladder may drop when the pool runs thin — untouched
  // behaviour when no override is set.
  //
  // Both halves matter. If the operator cap were relaxable, activityScale = 0
  // would still hand out matches at the relax_daily_cap rung and "idle the
  // roster" would be a lie. If it applied unconditionally it would silently
  // promote the soft generated cap into a hard one, changing PR7 selection
  // semantics for every deployment that never touches the knob.
  if (isThrottled(ctx.tuning) && matchesToday >= operatorDailyCap(bot.daily_cap, ctx.tuning)) {
    return false;
  }

  if (level.respectSessionPreference && !prefersSessionNow(bot, ctx.now)) return false;
  if (level.respectRecentlyFaced && ctx.recentlyFaced.has(bot.user_id)) return false;
  if (level.respectDailyCap && matchesToday >= bot.daily_cap) return false;
  if (level.respectSchedule && !isWithinScheduleWindow(bot.schedule, ctx.now)) return false;
  return true;
}

/**
 * Order candidates by nearest RP to the target using the widening bands. Bots
 * outside the widest band are DROPPED, not appended: pairing a human with the
 * "closest" bot at any distance is what produced the 77%/4.5% mismatch, and a
 * lopsided match is worse for the player than the ephemeral opponent they would
 * have got before the roster existed. Ties within a band are shuffled to avoid
 * always picking the same bot (spreads load + avoids a detectable pattern).
 */
function orderByNearestRp(bots: EligibleBotRow[], targetRp: number): EligibleBotRow[] {
  // Deterministic, stable sort by |rp - target| ONLY. Do NOT randomize inside the
  // comparator — a non-deterministic comparator violates the sort contract
  // (inconsistent/unstable results). Tie randomization is applied separately by
  // the per-band Fisher-Yates shuffle below.
  const byDistance = [...bots].sort((a, b) => Math.abs(a.rp - targetRp) - Math.abs(b.rp - targetRp));
  const ordered: EligibleBotRow[] = [];
  const used = new Set<string>();
  for (const band of wideningBands()) {
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
    /** Tags the acquired reservation so the sweeper reconciles it by mode. */
    mode?: 'auction';
    /** Bots already seated in THIS match, excluded so one match never seats the same bot twice. */
    excludeBotUserIds?: readonly string[];
  }): Promise<SelectedPersistentBot | null> {
    if (!reservationService.isEnabled()) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'flag_off', relaxation: 'none' });
      return null;
    }

    const now = new Date();
    const rosterDay = currentRosterDay(now);
    const targetRp = selectionTargetRpForHuman(params.humanProfile);

    const [eligible, recentlyFacedList, tuning] = await Promise.all([
      syntheticBotsRepo.listEligibleBots(),
      getRecentlyFaced(params.humanUserId),
      loadBotTuning(),
    ]);

    if (eligible.length === 0) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'ephemeral_fallback', relaxation: 'empty_roster' });
      logger.info({ humanUserId: params.humanUserId, targetRp }, 'persistent-bot selection: empty roster, ephemeral fallback');
      return null;
    }

    const recentlyFaced = new Set(recentlyFacedList);
    // HARD exclusion: a bot already seated in this same match must not be picked
    // for a second seat. The reservations table's bot_user_id PK would reject the
    // duplicate acquire anyway, but filtering here avoids burning acquire
    // attempts (MAX_ACQUIRE_ATTEMPTS) on candidates that cannot possibly win.
    const excluded = new Set(params.excludeBotUserIds ?? []);
    const selectable = excluded.size > 0
      ? eligible.filter((bot) => !excluded.has(bot.user_id))
      : eligible;
    const ordered = orderByNearestRp(selectable, targetRp);

    // No bot within the pairing ceiling of this human (typically a strong active
    // above the roster's top RP). Take the ephemeral fallback rather than pairing
    // them down against a bot they would beat ~95% of the time.
    if (ordered.length === 0) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'ephemeral_fallback', relaxation: 'no_bot_in_rp_band' });
      logger.info(
        {
          humanUserId: params.humanUserId,
          targetRp,
          eligibleCount: selectable.length,
          maxRpGap: config.BOT_PAIRING_MAX_RP_GAP,
        },
        'persistent-bot selection: no bot within RP band, ephemeral fallback',
      );
      return null;
    }

    let acquireAttempts = 0;
    for (const level of ELIGIBILITY_LADDER) {
      const candidates = ordered.filter((bot) => passesLevel(bot, level, { recentlyFaced, rosterDay, now, tuning }));
      for (const bot of candidates) {
        if (acquireAttempts >= MAX_ACQUIRE_ATTEMPTS) {
          appMetrics.persistentBotSelections.add(1, { outcome: 'ephemeral_fallback', relaxation: 'acquire_cap' });
          logger.info(
            { humanUserId: params.humanUserId, targetRp, acquireAttempts },
            'persistent-bot selection: acquire attempt cap reached, ephemeral fallback',
          );
          return null;
        }
        acquireAttempts++;
        const reservation = await reservationService.acquire({
          botUserId: bot.user_id,
          lobbyId: params.lobbyId,
          ttlSec: RESERVATION_TTL_SEC,
          mode: params.mode,
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
