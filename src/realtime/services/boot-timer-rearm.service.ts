import type { QuizballServer } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { ensurePartyQuizActiveTimer } from '../party-quiz-match-flow.js';
import { ensurePossessionActiveTimers } from '../possession-question-dispatch.js';
import { getRedisClient } from '../redis.js';
import { matchPauseKey } from '../match-keys.js';

// Give the durable timer scheduler / Redis adapter a moment to come up before
// touching live matches, and bound the scan so a pathological backlog can't
// stall boot work.
const BOOT_REARM_DELAY_MS = 3_000;
const BOOT_REARM_BATCH = 200;

let bootRearmTimer: NodeJS.Timeout | null = null;

/**
 * Re-arm round-driving timers for every active match after a restart.
 *
 * Most match timers are durable (question deadlines, AI answers, halftime,
 * disconnect grace) and survive restarts via the Redis scheduler. But a few
 * round-transition steps are in-process only — the goal-transition /
 * party-quiz ready-ack gates and the inter-question dispatch delay. A deploy
 * landing inside one of those windows used to freeze the match (no timer left
 * to drive the next round) until a player rejoin happened to run the ensure
 * path or the 15-minute stale sweeper caught it.
 *
 * The boot sweep closes that gap with the same proven primitives the rejoin
 * path uses:
 * - possession: `ensurePossessionActiveTimers` — re-arms a live deadline,
 *   immediately force-resolves an expired one (which also un-sticks a match
 *   frozen between rounds), and re-schedules halftime timers. Idempotent for
 *   healthy matches: re-arming a durable timer is a same-member zAdd and the
 *   AI answer timer is checked before scheduling.
 * - party quiz: `ensurePartyQuizActiveTimer` — same contract, and skips
 *   paused matches itself.
 *
 * Paused matches (disconnect-grace flow) are skipped: the durable
 * `match_disconnect_forfeit` timer owns their lifecycle.
 */
export async function rearmActiveMatchTimersOnBoot(io: QuizballServer): Promise<{
  scanned: number;
  rearmed: number;
  skippedPaused: number;
  failed: number;
}> {
  const summary = { scanned: 0, rearmed: 0, skippedPaused: 0, failed: 0 };

  let active;
  try {
    // olderThanMs=0 → every active match, oldest first.
    active = await matchesRepo.listStaleActiveMatches(0, BOOT_REARM_BATCH);
  } catch (error) {
    logger.warn({ error }, 'Boot timer re-arm scan failed');
    return summary;
  }
  summary.scanned = active.length;
  if (active.length === 0) return summary;

  const redis = getRedisClient();
  for (const match of active) {
    try {
      if (redis?.isOpen && (await redis.exists(matchPauseKey(match.id))) === 1) {
        // Disconnect-grace flow owns paused matches via durable timers.
        summary.skippedPaused += 1;
        continue;
      }
      const variant = resolveMatchVariant(match.state_payload, match.mode);
      const ensured = variant === 'friendly_party_quiz'
        ? await ensurePartyQuizActiveTimer(io, match.id)
        : await ensurePossessionActiveTimers(io, match.id);
      if (ensured) summary.rearmed += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn({ error, matchId: match.id }, 'Boot timer re-arm failed for match');
    }
  }

  logger.info(summary, 'Boot timer re-arm completed for active matches');
  return summary;
}

export function scheduleBootMatchTimerRearm(io: QuizballServer): void {
  if (bootRearmTimer) clearTimeout(bootRearmTimer);
  bootRearmTimer = setTimeout(() => {
    bootRearmTimer = null;
    void rearmActiveMatchTimersOnBoot(io).catch((error) => {
      logger.warn({ error }, 'Boot timer re-arm crashed');
    });
  }, BOOT_REARM_DELAY_MS);
  bootRearmTimer.unref?.();
}

export function cancelBootMatchTimerRearm(): void {
  if (bootRearmTimer) {
    clearTimeout(bootRearmTimer);
    bootRearmTimer = null;
  }
}
