import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import {
  syntheticBotsRepo,
  type RenameCandidateRow,
} from '../synthetic-bots/synthetic-bots.repo.js';
import { isWithinScheduleWindow } from '../synthetic-bots/activity-window.js';
import {
  NICKNAME_COOLDOWN_DAYS,
  NICKNAME_FREE_CHANGES,
  usersRepo,
} from '../users/users.repo.js';
import { findBannedNicknameTerm } from '../moderation/text-moderation.js';
import { buildEvolvedNickname, rngFromKey } from './bot-name-evolution.js';

/**
 * Occasional roster-bot renames (PERSISTENT-BOTS-PLAN §1.12).
 *
 * Real players rename now and then; a roster whose 1,000 handles are frozen
 * for a whole season is a population-level tell. Target: ~10-15% of bots rename
 * at least once over a season, which is what the per-bot `rename_propensity`
 * assigned at generation encodes.
 *
 * ORGANIC TIMING. The worker ticks hourly, and each tick gives each eligible
 * bot an independent, tiny chance to rename. Renames therefore trickle out one
 * at a time across the season instead of arriving in a visible batch. Three
 * things keep it from ever looking synchronized:
 *   - the per-bot probability is derived from that bot's own hourly seed, so
 *     bots never fire together;
 *   - the bot must be inside its own activity window (§1.3), so renames land
 *     during that bot's plausible waking hours;
 *   - reserved (mid-match) bots are excluded in SQL, so a name never changes
 *     under a live opponent.
 *
 * SAME PIPELINE AS HUMANS. The write goes through `usersRepo.changeNicknameInTx`
 * — the exact call a human's PUT /users/me makes. That means: a real
 * `nickname_history` row, `counted: true` against the 2-free allowance, the
 * 30-day cooldown enforced in SQL, and a public "previously known as" entry
 * indistinguishable from a human's. Bots hold 0 coins, so once the 2 free
 * changes are spent they are gated by cooldown exactly like a broke human.
 * Nothing here bypasses the quota — a gated bot simply gets null back.
 */

export const BOT_RENAME_TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Per-eligible-bot chance of renaming in a single hourly tick, BEFORE the bot's
 * own rename_propensity scales it.
 *
 * Sizing: a bot is in-window roughly 18h/day, so it sees ~18 eligible ticks a
 * day. The repo's 30-day minimum-interval filter caps one bot at ~540 eligible
 * ticks per window and at most ~3 windows in a 90-day season. At 4e-4 a
 * propensity-1.0 bot renames with probability ~1-(1-4e-4)^540 ≈ 19% per window;
 * the generator's propensity distribution (most bots at/near 0) scales the
 * roster-wide figure down to the ~10-15% season target from §1.12.
 *
 * Deliberately conservative: renaming too rarely is invisible, while renaming
 * too often is a population-level tell that no amount of per-bot jitter hides.
 */
export const BOT_RENAME_HOURLY_BASE_RATE = 4e-4;

/** Uniqueness retries before giving up on this bot for this tick. */
const MAX_NAME_ATTEMPTS = 6;

export interface BotRenameTickResult {
  scanned: number;
  outOfWindow: number;
  notDrawn: number;
  attempted: number;
  renamed: number;
  quotaGated: number;
  noCandidateName: number;
  /** Skipped at write time: reserved for a match, or renamed by another replica. */
  raced: number;
  failed: number;
}

interface BotRenameDependencies {
  listRenameCandidates: () => Promise<RenameCandidateRow[]>;
  isNicknameTaken: (nickname: string, excludeUserId: string) => Promise<boolean>;
  isNicknameReserved: (nickname: string, requesterUserId: string) => Promise<boolean>;
  /**
   * Atomic rename: preconditions + quota gate + history row + users update in
   * ONE transaction under the users row lock. Not a plain changeNicknameInTx —
   * see synthetic-bots.repo.renameBotAtomically for why the bot path needs the
   * reservation/recency checks inside the same lock.
   */
  renameBot: (params: {
    userId: string;
    oldNickname: string | null;
    newNickname: string;
  }) => Promise<'renamed' | 'raced' | 'quota_gated'>;
  now: () => Date;
  /**
   * Per-tick draw rate before per-bot propensity scaling. Overridable ONLY so
   * tests can force the draw deterministically; production always uses
   * BOT_RENAME_HOURLY_BASE_RATE.
   */
  baseRate: number;
}

let timer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<void> | null = null;

/** The tick bucket a moment belongs to — the unit of per-bot draw stability. */
function tickBucket(now: Date): number {
  return Math.floor(now.getTime() / BOT_RENAME_TICK_INTERVAL_MS);
}

/**
 * Deterministic per-(bot, tick) rename draw.
 *
 * Keyed on the bot's personality seed and the tick bucket, so a given bot's
 * decision for a given hour is stable — a replica restart mid-hour, or two
 * replicas ticking the same hour, cannot produce a different answer or double
 * the effective rate.
 */
export function shouldRenameThisTick(
  bot: Pick<RenameCandidateRow, 'user_id' | 'personality_seed' | 'rename_propensity'>,
  now: Date,
  baseRate = BOT_RENAME_HOURLY_BASE_RATE
): boolean {
  const propensity = Number(bot.rename_propensity);
  if (!Number.isFinite(propensity) || propensity <= 0) return false;
  const rng = rngFromKey(`rename:${bot.user_id}:${bot.personality_seed}:${tickBucket(now)}`);
  return rng() < baseRate * propensity;
}

/**
 * Pick a fresh, evolution-biased name for one bot.
 *
 * Applies exactly the checks a human rename passes: the banned-term filter, the
 * global uniqueness check, and the vacated-name reservation window. Returns
 * null when no attempt produced a usable name.
 */
async function pickNewNickname(
  bot: RenameCandidateRow,
  deps: BotRenameDependencies,
  now: Date
): Promise<string | null> {
  const current = bot.nickname?.trim();
  if (!current) return null;

  const rng = rngFromKey(`rename-name:${bot.user_id}:${bot.personality_seed}:${tickBucket(now)}`);

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    // buildEvolvedNickname already enforces the 50-char cap and strips
    // leading/trailing separators, returning null instead of a bad name.
    const candidate = buildEvolvedNickname(rng, current, attempt);
    if (!candidate) continue;
    // Same moderation filter the human path applies (users.service.ts).
    if (findBannedNicknameTerm(candidate)) continue;
    if (await deps.isNicknameTaken(candidate, bot.user_id)) continue;
    // Vacated-name reservation: a bot must not squat a name a real user just
    // released, exactly as a human cannot.
    if (await deps.isNicknameReserved(candidate, bot.user_id)) continue;
    return candidate;
  }

  return null;
}

export async function runBotRenameTick(
  overrides: Partial<BotRenameDependencies> = {}
): Promise<BotRenameTickResult> {
  const deps: BotRenameDependencies = {
    listRenameCandidates: () => syntheticBotsRepo.listRenameCandidates(),
    isNicknameTaken: (nickname, excludeUserId) => usersRepo.isNicknameTaken(nickname, excludeUserId),
    isNicknameReserved: (nickname, requesterUserId) =>
      usersRepo.isNicknameReserved(nickname, requesterUserId),
    renameBot: ({ userId, oldNickname, newNickname }) =>
      syntheticBotsRepo.renameBotAtomically({
        botUserId: userId,
        oldNickname,
        newNickname,
        // The human allowance, applied verbatim to bots.
        freeChanges: NICKNAME_FREE_CHANGES,
        cooldownDays: NICKNAME_COOLDOWN_DAYS,
      }),
    now: () => new Date(),
    baseRate: BOT_RENAME_HOURLY_BASE_RATE,
    ...overrides,
  };

  const now = deps.now();
  const candidates = await deps.listRenameCandidates();
  const result: BotRenameTickResult = {
    scanned: candidates.length,
    outOfWindow: 0,
    notDrawn: 0,
    attempted: 0,
    renamed: 0,
    quotaGated: 0,
    noCandidateName: 0,
    raced: 0,
    failed: 0,
  };

  for (const bot of candidates) {
    // Activity window first: a rename at 04:00 by a bot that never plays then
    // is exactly the kind of off-hours action that reads as automation.
    if (!isWithinScheduleWindow(bot.schedule, now)) {
      result.outOfWindow++;
      continue;
    }

    if (!shouldRenameThisTick(bot, now, deps.baseRate)) {
      result.notDrawn++;
      continue;
    }

    result.attempted++;
    try {
      const newNickname = await pickNewNickname(bot, deps, now);
      if (!newNickname) {
        result.noCandidateName++;
        continue;
      }

      // The scan's predicates were a snapshot; renameBot re-evaluates them
      // under the users row lock in the same transaction as the write, so a
      // concurrent replica or a mid-flight match reservation loses cleanly.
      const outcome = await deps.renameBot({
        userId: bot.user_id,
        oldNickname: bot.nickname?.trim() ?? null,
        newNickname,
      });

      if (outcome === 'raced') {
        result.raced++;
        continue;
      }
      if (outcome === 'quota_gated') {
        // Quota spent and cooldown not elapsed — the same answer a human gets.
        result.quotaGated++;
        continue;
      }

      result.renamed++;
      logger.info(
        { userId: bot.user_id, from: bot.nickname, to: newNickname },
        'Roster bot renamed'
      );
    } catch (error) {
      result.failed++;
      logger.warn({ error, userId: bot.user_id }, 'Roster bot rename failed');
    }
  }

  return result;
}

function scheduleTick(): void {
  if (inFlightTick) return;
  const tick = (async () => {
    try {
      await runBotRenameTick();
    } catch (error) {
      logger.error({ error }, 'Bot rename tick failed');
    } finally {
      inFlightTick = null;
    }
  })();
  inFlightTick = tick;
}

export function startBotRenameWorker(): void {
  if (timer) return;
  if (!config.PERSISTENT_BOTS_ENABLED) {
    logger.info('Bot rename worker disabled (PERSISTENT_BOTS_ENABLED off)');
    return;
  }
  timer = setInterval(scheduleTick, BOT_RENAME_TICK_INTERVAL_MS);
  timer.unref?.();
  // Deliberately NOT ticking immediately on boot: a deploy restarts every
  // replica at once, and an immediate tick would concentrate renames around
  // deploy time. The first tick lands one interval in.
  logger.info('Bot rename worker started');
}

export async function stopBotRenameWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const activeTick = inFlightTick;
  if (activeTick) {
    await activeTick;
  }
}
