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
 *   - The rollout flag still gates optional auction use. Ranked is persistent-
 *     only and therefore selects/reserves from the roster even when the legacy
 *     rollout flag is off; there is no ephemeral ranked path to fall back to.
 *   - Nearest-RP to the human's SELECTION TARGET (placement anchor for unplaced,
 *     current RP for placed), widening ±150 → ±BOT_PAIRING_MAX_RP_GAP (300).
 *     Ranked callers may then fall through to the highest lower-RP persistent
 *     bot (or the closest higher bot when no lower bot exists). Auction keeps
 *     the bounded band because it still owns a separate ephemeral seat fallback.
 *   - Eligibility ladder relaxes SOFT constraints in fixed order:
 *       session preference → recently-faced → daily cap → schedule.
 *     Ranked first removes rotation-excluded identities — the last
 *     BOT_RANKED_RECENT_WINDOW distinct opponents plus any bot this human has
 *     already faced BOT_RANKED_PAIR_WEEKLY_CAP times in the trailing 7 days —
 *     from its normal and out-of-band pools, so a fresh identity further down
 *     the ladder beats repeating a closer-RP one. Only after every fresh
 *     candidate is exhausted may it retry the least-recent opponent, so
 *     rotation never becomes an outage.
 *     HARD constraints (status='active', not reserved) are enforced in SQL and
 *     NEVER relaxed. reserved is additionally guaranteed by the acquire race.
 *   - On a hit: acquire the reservation (ON CONFLICT DO NOTHING). If the acquire
 *     loses the race (another selection grabbed the same bot), try the next
 *     candidate; exhausting candidates → null. Auction may then create an
 *     ephemeral seat; ranked reports an unavailable roster and never does.
 *
 * Telemetry: every terminal outcome increments persistentBotSelections tagged
 * with { outcome, relaxation } so PR9 can build alerting on it.
 */

const RESERVATION_TTL_SEC = 180; // lobby-lifetime lease; heartbeated across the match.
// Auction (and any future optional caller) keeps the original short soft
// window; ranked uses the wider env-tunable BOT_RANKED_RECENT_WINDOW so a
// player above the roster's RP ceiling rotates through ~window+1 identities
// instead of the ~6 that a 5-window allowed.
const RECENTLY_FACED_LIMIT = 5;

/** The identity window ranked keeps out of its fresh pools. */
function rankedRecentWindow(): number {
  return config.BOT_RANKED_RECENT_WINDOW;
}

/** Redis stores the widest window any caller reads. */
function storedRecentLimit(): number {
  return Math.max(RECENTLY_FACED_LIMIT, rankedRecentWindow());
}
// Inner parity band. Prod evidence (2026-07-31): at a gap ≤150 RP bots win ~32%
// of matches; beyond it the human is overwhelmingly the stronger side (77% of
// bot matches paired a human 150+ RP above the bot, which bots won 4.5% of).
const INNER_BAND_RP = 150;

/**
 * Widening bands, tightest first, capped by BOT_PAIRING_MAX_RP_GAP. The ceiling
 * is an env var parsed at process start, so retuning it takes a restart/redeploy
 * of the env — not a code change. The cap's floor (150) equals the inner band,
 * so a fully-tightened config collapses to a single ±150 band rather than
 * producing an empty ladder.
 */
function wideningBands(): number[] {
  const maxGap = config.BOT_PAIRING_MAX_RP_GAP;
  return maxGap <= INNER_BAND_RP ? [maxGap] : [INNER_BAND_RP, maxGap];
}
// Cap total acquire (ON CONFLICT DO NOTHING) attempts across the whole eligibility
// ladder for one selection. Each attempt is a DB round-trip; under heavy
// contention many candidates may be concurrently reserved, so bound the work and
// stop rather than hammering the DB across a large roster.
const MAX_ACQUIRE_ATTEMPTS = 12;

function recentlyFacedKey(humanUserId: string): string {
  return `ranked:persistent:recent:${humanUserId}`;
}

interface RecentOpponentState {
  /** Last N distinct persistent-bot opponents, most-recent first. */
  recentlyFacedList: string[];
  /** Bots this human already faced >= BOT_RANKED_PAIR_WEEKLY_CAP times in 7 days. */
  weeklyCappedIds: string[];
  /**
   * FULL recency order (most-recent first), unsliced — every identity in the
   * exclusion pools appears here, so emergency re-entry can pick the genuinely
   * least-recent opponent even among bots that fell off the window.
   */
  recentOrder: string[];
}

/** The human's recent persistent-bot opponent state. Best-effort. */
async function getRecentlyFaced(humanUserId: string, includeDurable: boolean): Promise<RecentOpponentState> {
  const window = includeDurable ? rankedRecentWindow() : RECENTLY_FACED_LIMIT;
  const redis = getRedisClient();
  const [cached, history] = await Promise.all([
    redis?.isOpen
      ? redis.lRange(recentlyFacedKey(humanUserId), 0, window - 1).catch((err) => {
          logger.warn({ err, humanUserId }, 'persistent-bot recently-faced cache read failed');
          return [] as string[];
        })
      : Promise.resolve([] as string[]),
    includeDurable
      ? syntheticBotsRepo.listRankedPersistentOpponentHistory(humanUserId).catch((err) => {
          logger.warn({ err, humanUserId }, 'persistent-bot recently-faced durable read failed');
          return [] as { bot_user_id: string; matches_count: number }[];
        })
      : Promise.resolve([] as { bot_user_id: string; matches_count: number }[]),
  ]);
  // The durable history is computed straight from started matches, so for
  // ranked it is the authoritative recency order — neither a stale-but-full
  // Redis list nor lingering cross-mode (auction) identities may push a
  // durably-recorded ranked opponent off the window. Redis-only identities
  // (auction opponents, or a transfer recorded ahead of match visibility) fill
  // whatever window room the ranked history leaves. The effective window is
  // always exactly N, never N from each source (which would silently double
  // the exclusion pool).
  const durableIds = history.map((row) => row.bot_user_id);
  const durableSet = new Set(durableIds);
  const cacheOnly = cached.filter((id) => !durableSet.has(id));
  const recentOrder = [...new Set([...durableIds, ...cacheOnly])];
  const recentlyFacedList = recentOrder.slice(0, window);
  const weeklyCap = config.BOT_RANKED_PAIR_WEEKLY_CAP;
  const weeklyCappedIds = weeklyCap > 0
    ? history.filter((row) => row.matches_count >= weeklyCap).map((row) => row.bot_user_id)
    : [];
  return { recentlyFacedList, weeklyCappedIds, recentOrder };
}

/**
 * Record a persistent bot as a recent opponent for the human (LRU, capped at
 * the widest caller window). Called by the caller after a successful transfer
 * so the exclusion reflects matches that actually started. Best-effort.
 */
export async function recordRecentlyFaced(humanUserId: string, botUserId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  try {
    const key = recentlyFacedKey(humanUserId);
    // Keep DISTINCT identities. Without LREM, repeat entries consume the
    // whole list and collapse the effective rotation window back to one bot.
    await redis.lRem(key, 0, botUserId);
    await redis.lPush(key, botUserId);
    await redis.lTrim(key, 0, storedRecentLimit() - 1);
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

/** Ranked-only tail after the bounded RP bands are exhausted. */
function orderOutOfBandFallback(
  bots: EligibleBotRow[],
  targetRp: number,
  inBandUserIds: Set<string>,
): EligibleBotRow[] {
  // Prefer the strongest available bot at or below the human's RP. This makes a
  // 6080-RP human face the roster leader rather than a temporary 2700-RP
  // identity. If the roster has no lower bot (bottom edge), use the closest
  // higher bot so any non-empty roster can still match.
  const lower = bots
    .filter((bot) => !inBandUserIds.has(bot.user_id) && bot.rp <= targetRp)
    .sort((a, b) => b.rp - a.rp);
  const higher = bots
    .filter((bot) => !inBandUserIds.has(bot.user_id) && bot.rp > targetRp)
    .sort((a, b) => a.rp - b.rp);
  return [...lower, ...higher];
}

/**
 * Stable oldest-first ordering within an already RP-scoped candidate list.
 * A bot absent from the recency list (possible for a weekly-capped bot whose
 * last match predates the recent-identity window) was faced longest ago of
 * all, so it sorts FIRST, ahead of every listed identity.
 */
function orderByLeastRecentlyFaced(
  bots: EligibleBotRow[],
  recentlyFacedList: readonly string[],
): EligibleBotRow[] {
  const recency = new Map(recentlyFacedList.map((userId, index) => [userId, index]));
  const indexOf = (bot: EligibleBotRow): number =>
    recency.get(bot.user_id) ?? Number.MAX_SAFE_INTEGER;
  return [...bots].sort((a, b) => indexOf(b) - indexOf(a));
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
   * Returns the selected bot (with its held reservation) or null when the roster
   * is empty, operator-throttled, or lost every bounded acquire race.
   */
  async selectAndReserve(params: {
    humanUserId: string;
    humanProfile: RankedProfileRow;
    lobbyId: string;
    /** Tags the acquired reservation so the sweeper reconciles it by mode. */
    mode?: 'auction';
    /** Bots already seated in THIS match, excluded so one match never seats the same bot twice. */
    excludeBotUserIds?: readonly string[];
    /** Ranked-only: use a persistent bot outside the RP ceiling instead of legacy AI. */
    allowOutOfBandFallback?: boolean;
  }): Promise<SelectedPersistentBot | null> {
    const rankedPersistentOnly = params.allowOutOfBandFallback === true;
    if (!rankedPersistentOnly && !reservationService.isEnabled()) {
      appMetrics.persistentBotSelections.add(1, { outcome: 'flag_off', relaxation: 'none' });
      return null;
    }

    const now = new Date();
    const rosterDay = currentRosterDay(now);
    const targetRp = selectionTargetRpForHuman(params.humanProfile);
    const unavailableOutcome = rankedPersistentOnly ? 'unavailable' : 'ephemeral_fallback';

    const [eligible, recentState, tuning] = await Promise.all([
      syntheticBotsRepo.listEligibleBots(),
      getRecentlyFaced(params.humanUserId, rankedPersistentOnly),
      loadBotTuning(),
    ]);
    const { recentlyFacedList, weeklyCappedIds, recentOrder } = recentState;

    if (eligible.length === 0) {
      appMetrics.persistentBotSelections.add(1, { outcome: unavailableOutcome, relaxation: 'empty_roster' });
      logger.info({ humanUserId: params.humanUserId, targetRp, rankedPersistentOnly }, 'persistent-bot selection: empty roster');
      return null;
    }

    // Rotation exclusion: the recent-identity window plus any bot this human
    // has already faced BOT_RANKED_PAIR_WEEKLY_CAP times in the trailing 7
    // days. weeklyCappedIds is only populated on the ranked path, so this is
    // exactly the old recently-faced set for auction.
    const recentlyFaced = new Set([...recentlyFacedList, ...weeklyCappedIds]);
    // HARD exclusion: a bot already seated in this same match must not be picked
    // for a second seat. The reservations table's bot_user_id PK would reject the
    // duplicate acquire anyway, but filtering here avoids burning acquire
    // attempts (MAX_ACQUIRE_ATTEMPTS) on candidates that cannot possibly win.
    const excluded = new Set(params.excludeBotUserIds ?? []);
    const unseated = eligible.filter((bot) => !excluded.has(bot.user_id));
    // Ranked keeps rotation-excluded identities out of both normal pools — a
    // fresh identity further down the RP ladder beats repeating a closer one.
    // Auction retains the original soft ladder, including relax_recently_faced.
    const selectable = rankedPersistentOnly
      ? unseated.filter((bot) => !recentlyFaced.has(bot.user_id))
      : unseated;
    const inBand = orderByNearestRp(selectable, targetRp);
    const inBandUserIds = new Set(inBand.map((bot) => bot.user_id));
    const outOfBand = rankedPersistentOnly
      ? orderOutOfBandFallback(selectable, targetRp, inBandUserIds)
      : [];
    const recentPool = rankedPersistentOnly
      ? unseated.filter((bot) => recentlyFaced.has(bot.user_id))
      : [];
    const recentInBand = orderByLeastRecentlyFaced(
      orderByNearestRp(recentPool, targetRp),
      recentOrder,
    );
    const recentInBandUserIds = new Set(recentInBand.map((bot) => bot.user_id));
    const recentOutOfBand = orderByLeastRecentlyFaced(
      orderOutOfBandFallback(recentPool, targetRp, recentInBandUserIds),
      recentOrder,
    );

    // Auction remains bounded and may hand unfilled seats to its own ephemeral
    // fallback. Ranked appends outOfBand above, so this branch means the roster
    // is genuinely unavailable after hard exclusions (recent, seated, reserved).
    //
    // Distinguish the two ways this can happen so the metric means one thing:
    // 'all_excluded' is a multi-seat auction that already seated every in-band
    // bot (expected on a thin roster, NOT an RP-coverage hole), while
    // 'no_bot_in_rp_band' is a genuine gap in roster coverage at this RP — the
    // signal to widen BOT_PAIRING_MAX_RP_GAP or extend the roster's top end.
    if (inBand.length === 0 && outOfBand.length === 0 && recentPool.length === 0) {
      // Was the band actually populated before this match's own seats were
      // excluded? If so the roster covers this RP fine and the miss is purely
      // exclusion, not coverage.
      const inBandBeforeExclusion = excluded.size > 0
        ? orderByNearestRp(eligible, targetRp).length
        : 0;
      const relaxation = inBandBeforeExclusion > 0
          ? 'all_excluded'
          : 'no_bot_in_rp_band';
      appMetrics.persistentBotSelections.add(1, { outcome: unavailableOutcome, relaxation });
      logger.info(
        {
          humanUserId: params.humanUserId,
          targetRp,
          eligibleCount: eligible.length,
          selectableCount: selectable.length,
          excludedCount: excluded.size,
          recentlyFacedCount: recentlyFaced.size,
          weeklyCappedCount: weeklyCappedIds.length,
          recentWindow: rankedPersistentOnly ? rankedRecentWindow() : RECENTLY_FACED_LIMIT,
          maxRpGap: config.BOT_PAIRING_MAX_RP_GAP,
        },
        'persistent-bot selection: no candidate available',
      );
      return null;
    }

    let acquireAttempts = 0;
    const attempted = new Set<string>();
    const acquireCandidate = async (
      bot: EligibleBotRow,
      level: EligibilityLevel,
      rpScope: 'in_band' | 'out_of_band_fallback',
    ): Promise<SelectedPersistentBot | null> => {
      acquireAttempts++;
      attempted.add(bot.user_id);
      const reservation = await reservationService.acquire({
        botUserId: bot.user_id,
        lobbyId: params.lobbyId,
        ttlSec: RESERVATION_TTL_SEC,
        mode: params.mode,
        requirePersistent: rankedPersistentOnly,
      });
      if (!reservation) return null;

      appMetrics.persistentBotSelections.add(1, {
        outcome: 'hit',
        relaxation: level.relaxationLabel,
        rp_scope: rpScope,
      });
      logger.info(
        {
          humanUserId: params.humanUserId,
          botUserId: bot.user_id,
          lobbyId: params.lobbyId,
          targetRp,
          botRp: bot.rp,
          rpScope,
          relaxation: level.relaxationLabel,
          recentlyFacedCount: recentlyFaced.size,
          weeklyCappedCount: weeklyCappedIds.length,
        },
        'persistent-bot selected + reserved',
      );
      return { bot, reservation, relaxationLevel: level.relaxationLabel, targetRp };
    };

    const acquireCapReached = (): boolean => {
      if (acquireAttempts < MAX_ACQUIRE_ATTEMPTS) return false;
      appMetrics.persistentBotSelections.add(1, { outcome: unavailableOutcome, relaxation: 'acquire_cap' });
      logger.info(
        { humanUserId: params.humanUserId, targetRp, acquireAttempts },
        'persistent-bot selection: acquire attempt cap reached',
      );
      return true;
    };

    // Preserve the existing realism policy inside the normal RP bands: prefer
    // schedule/session/cap eligibility, then relax those soft constraints.
    for (const level of ELIGIBILITY_LADDER) {
      const candidates = inBand.filter(
        (bot) => !attempted.has(bot.user_id) && passesLevel(bot, level, { recentlyFaced, rosterDay, now, tuning }),
      );
      for (const bot of candidates) {
        if (acquireCapReached()) return null;
        const selected = await acquireCandidate(bot, level, 'in_band');
        if (selected) return selected;
        // Lost the acquire race — this bot is now reserved by someone else; try
        // the next candidate at this level.
      }
    }

    // Outside the band, RP order is the product requirement: fully relax a
    // candidate's soft constraints before moving down from the roster leader.
    // Operator throttles remain hard and can skip a bot entirely.
    for (const bot of outOfBand) {
      const level = ELIGIBILITY_LADDER.find((candidateLevel) =>
        passesLevel(bot, candidateLevel, { recentlyFaced, rosterDay, now, tuning }),
      );
      if (!level) continue;
      if (acquireCapReached()) return null;
      const selected = await acquireCandidate(bot, level, 'out_of_band_fallback');
      if (selected) return selected;
    }

    // Availability wins only after rotation has been exhausted. Re-enter the RP
    // policy with the least-recent identity first, and only at a ladder level
    // that explicitly relaxes the recent-opponent preference. This prevents the
    // same-bot loop without making a thin roster unmatchable.
    for (const [rpScope, candidates] of [
      ['in_band', recentInBand],
      ['out_of_band_fallback', recentOutOfBand],
    ] as const) {
      for (const bot of candidates) {
        const level = ELIGIBILITY_LADDER.find((candidateLevel) =>
          !candidateLevel.respectRecentlyFaced
          && passesLevel(bot, candidateLevel, { recentlyFaced, rosterDay, now, tuning }),
        );
        if (!level) continue;
        if (acquireCapReached()) return null;
        const selected = await acquireCandidate(bot, level, rpScope);
        if (selected) return selected;
      }
    }

    appMetrics.persistentBotSelections.add(1, { outcome: unavailableOutcome, relaxation: 'ladder_exhausted' });
    logger.info(
      { humanUserId: params.humanUserId, targetRp, eligibleCount: eligible.length },
      'persistent-bot selection: ladder exhausted',
    );
    return null;
  },
};
