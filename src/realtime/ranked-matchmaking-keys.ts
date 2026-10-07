export const RANKED_MM_QUEUE_KEY = 'ranked:mm:queue';
export const RANKED_MM_TIMEOUTS_KEY = 'ranked:mm:timeouts';
export const RANKED_MM_USER_MAP_KEY = 'ranked:mm:user';
export const RANKED_MM_SEARCH_KEY_PREFIX = 'ranked:mm:search:';

export function rankedSearchKey(searchId: string): string {
  return `${RANKED_MM_SEARCH_KEY_PREFIX}${searchId}`;
}

export function rankedCancelKey(userId: string): string {
  return `ranked:mm:cancel:${userId}`;
}

export function rankedJoinDebounceKey(userId: string): string {
  return `ranked:mm:join_debounce:${userId}`;
}

export function rankedLeaveGuardKey(userId: string): string {
  return `ranked:mm:leave_guard:${userId}`;
}

export function rankedPairingInFlightKey(userId: string): string {
  return `ranked:mm:pairing:${userId}`;
}

/**
 * Ranked matchmaking pools. Quizball members play in the public pool; a partner's players only ever meet each other
 * (or a bot), so each partner environment gets its own queue and timeouts. The user map and search hashes stay
 * shared: user and search ids are unique across pools and a user holds at most one ranked search.
 */
export const PUBLIC_RANKED_POOL = 'public';
export type RankedPool = string;

export interface RankedPoolKeys {
  queue: string;
  timeouts: string;
}

export function rankedPoolKeys(pool: RankedPool): RankedPoolKeys {
  if (pool === PUBLIC_RANKED_POOL) return { queue: RANKED_MM_QUEUE_KEY, timeouts: RANKED_MM_TIMEOUTS_KEY };
  return { queue: `ranked:mm:pool:${pool}:queue`, timeouts: `ranked:mm:pool:${pool}:timeouts` };
}
