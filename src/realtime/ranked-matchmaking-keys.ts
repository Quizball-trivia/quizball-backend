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
