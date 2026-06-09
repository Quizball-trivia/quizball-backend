import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { deleteMatchCache } from '../match-cache.js';
import { acquireLock, releaseLock } from '../locks.js';

export type AbandonMatchWithCompleteLockResult = {
  abandoned: boolean;
  reason?: 'lock_not_acquired' | 'not_active';
};

export async function abandonMatchWithCompleteLock(
  matchId: string
): Promise<AbandonMatchWithCompleteLockResult> {
  const lockKey = `lock:match:${matchId}:complete`;
  const lock = await acquireLock(lockKey, 15_000);
  if (!lock.acquired || !lock.token) {
    return { abandoned: false, reason: 'lock_not_acquired' };
  }

  try {
    const activeMatch = await matchesRepo.getMatch(matchId);
    if (!activeMatch || activeMatch.status !== 'active') {
      return { abandoned: false, reason: 'not_active' };
    }

    const abandoned = await matchesRepo.abandonMatch(matchId);
    if (abandoned) {
      await deleteMatchCache(matchId);
    }
    return { abandoned };
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
