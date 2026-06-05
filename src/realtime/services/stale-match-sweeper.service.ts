import type { QuizballServer } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { acquireLock, releaseLock } from '../locks.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { deleteMatchCache } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import {
  matchDisconnectKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import type { MatchRow } from '../../modules/matches/matches.types.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import { finalizeMatchAsForfeit } from './match-forfeit.service.js';

// How long a match may sit in 'active' with no state write before it is
// considered orphaned. Must be comfortably larger than every legitimate idle
// window (60s disconnect grace, halftime ban deadline, resume countdown) so a
// live match is never swept.
const STALE_AGE_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH_SIZE = 50;
const SWEEP_LOCK_TTL_MS = 30_000;

let sweepTimer: NodeJS.Timeout | null = null;

function staleSweepLockKey(matchId: string): string {
  return `lock:stale_sweep:${matchId}`;
}

/** Best-effort cleanup of the per-match Redis keys a normal resolution would clear. */
async function cleanupMatchRedisKeys(matchId: string, userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  const keys = [
    matchPauseKey(matchId),
    matchGraceKey(matchId),
    matchResumeCountdownKey(matchId),
    rankedAiMatchKey(matchId),
    ...userIds.flatMap((userId) => [
      matchDisconnectKey(matchId, userId),
      matchPresenceKey(matchId, userId),
      matchReconnectCountKey(matchId, userId),
    ]),
  ];
  await redis.del(keys).catch((error) => {
    logger.warn({ error, matchId }, 'Stale sweeper Redis cleanup failed');
  });
}

/**
 * Resolve one orphaned match. Forfeits the absent human when a counterpart is
 * still around (the present human / the AI wins); abandons it outright when no
 * one is reachable. Reuses the shared finalize/abandon paths, both of which
 * re-check `status='active'` and are therefore idempotent.
 */
async function resolveStaleMatch(io: QuizballServer, match: MatchRow): Promise<void> {
  const roster = await matchPlayersRepo.listMatchPlayers(match.id);
  if (roster.length === 0) {
    // No participants at all (pure dead row) — just close it.
    await matchesRepo.abandonMatch(match.id);
    await deleteMatchCache(match.id);
    logger.info({ matchId: match.id, mode: match.mode }, 'Stale sweeper abandoned playerless match');
    return;
  }

  const userIds = roster.map((player) => player.user_id);
  const usersById = await usersRepo.getByIds(userIds);
  const redis = getRedisClient();

  // A player counts as "present" if they are AI (server-driven, always around)
  // or still have a live presence key. Everyone else is treated as absent.
  const presence = await Promise.all(
    roster.map(async (player) => {
      const user = usersById.get(player.user_id);
      if (user?.is_ai) return true;
      if (!redis || !redis.isOpen) return false;
      return (await redis.exists(matchPresenceKey(match.id, player.user_id))) === 1;
    })
  );
  const absentPlayers = roster.filter((_, index) => !presence[index]);
  const presentPlayers = roster.filter((_, index) => presence[index]);

  // Party quiz has bespoke dropout-continuation rules and N players; the 1v1
  // forfeit helper (which only excludes a single user from standings) would
  // resolve it wrong. A stale party match is already dead — abandon it safely
  // rather than fabricate a winner.
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (variant === 'friendly_party_quiz') {
    await matchesService.abandonMatch(match.id);
    await deleteMatchCache(match.id);
    await cleanupMatchRedisKeys(match.id, userIds);
    logger.info(
      { matchId: match.id, mode: match.mode, rosterSize: roster.length },
      'Stale sweeper abandoned orphaned party-quiz match'
    );
    return;
  }

  if (absentPlayers.length === 0 || presentPlayers.length === 0) {
    // Nobody clearly absent, or nobody present to credit — abandon cleanly.
    await matchesService.abandonMatch(match.id);
    await deleteMatchCache(match.id);
    await cleanupMatchRedisKeys(match.id, userIds);
    logger.info(
      { matchId: match.id, mode: match.mode, rosterSize: roster.length },
      'Stale sweeper abandoned orphaned match (no present counterpart)'
    );
    return;
  }

  // One side is absent and a counterpart is still around: forfeit the absent
  // player so the present side (human or AI) is credited the win.
  const forfeitingUserId = absentPlayers[0].user_id;
  const finalized = await finalizeMatchAsForfeit({
    matchId: match.id,
    forfeitingUserId,
    activeMatch: match,
    cleanupRedisKeys: [
      matchPauseKey(match.id),
      matchGraceKey(match.id),
      matchResumeCountdownKey(match.id),
      rankedAiMatchKey(match.id),
      ...userIds.flatMap((userId) => [
        matchDisconnectKey(match.id, userId),
        matchPresenceKey(match.id, userId),
        matchReconnectCountKey(match.id, userId),
      ]),
    ],
  });

  if (!finalized.completed) {
    // Couldn't finalize (already resolved or lock contention) — leave it; the
    // next sweep retries.
    return;
  }

  const finalPayload = await buildFinalResultsPayload(match.id, finalized.resultVersion);
  if (finalPayload) {
    await emitFinalResultsToMatchParticipants(io, match.id, finalPayload);
  }
  logger.info(
    {
      matchId: match.id,
      mode: match.mode,
      forfeitingUserId,
      winnerId: finalized.winnerId,
    },
    'Stale sweeper forfeited orphaned match'
  );
}

// The sweeper's staleness signal (matches.updated_at) is only trustworthy when
// the BEFORE-UPDATE trigger maintaining it is present. If a deploy lands before
// the migration that adds it, updated_at would be frozen at match creation and
// the sweeper could mistake a live match for an orphan. So we verify the trigger
// exists before ANY sweep (including the boot sweep) and no-op until it does.
// Cached after the first positive check; re-probed while still missing.
let updatedAtTriggerVerified = false;

async function ensureUpdatedAtTrigger(): Promise<boolean> {
  if (updatedAtTriggerVerified) return true;
  try {
    updatedAtTriggerVerified = await matchesRepo.hasUpdatedAtTrigger();
  } catch (error) {
    logger.warn({ error }, 'Stale sweeper could not verify matches.updated_at trigger');
    return false;
  }
  if (!updatedAtTriggerVerified) {
    logger.warn(
      {},
      'Stale sweeper disabled: trg_matches_set_updated_at is missing (run the matches updated_at migration). Skipping sweep to avoid touching live matches.'
    );
  }
  return updatedAtTriggerVerified;
}

async function runSweep(io: QuizballServer): Promise<void> {
  if (!(await ensureUpdatedAtTrigger())) return;

  let stale: MatchRow[];
  try {
    stale = await matchesRepo.listStaleActiveMatches(STALE_AGE_MS, SWEEP_BATCH_SIZE);
  } catch (error) {
    logger.warn({ error }, 'Stale sweeper query failed');
    return;
  }
  if (stale.length === 0) return;

  logger.info({ count: stale.length }, 'Stale sweeper found orphaned active matches');

  for (const match of stale) {
    const lock = await acquireLock(staleSweepLockKey(match.id), SWEEP_LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) continue;
    try {
      // Re-fetch under the lock: another worker (or the durable grace timer) may
      // have resolved it between the list query and now.
      const fresh = await matchesRepo.getMatch(match.id);
      if (!fresh || fresh.status !== 'active') continue;
      await resolveStaleMatch(io, fresh);
    } catch (error) {
      logger.warn({ error, matchId: match.id }, 'Stale sweeper failed to resolve match');
    } finally {
      await releaseLock(staleSweepLockKey(match.id), lock.token).catch(() => {});
    }
  }
}

export function startStaleMatchSweeper(io: QuizballServer): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    void runSweep(io);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  // Kick one sweep shortly after boot so a deploy that orphaned matches mid-grace
  // gets cleaned up without waiting a full interval.
  void runSweep(io);
}

export function stopStaleMatchSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export const __staleMatchSweeperInternals = {
  STALE_AGE_MS,
  SWEEP_INTERVAL_MS,
  resolveStaleMatch,
  runSweep,
  resetTriggerCache: () => {
    updatedAtTriggerVerified = false;
  },
};
