import { getRedisClient } from '../../realtime/redis.js';

/**
 * Shared (Redis) budgets for the guest friend-lobby paths — the express
 * MemoryStore limits on the HTTP routes are per process and cannot bound a
 * fleet. Falls back to a per-process map when Redis is down, same as the
 * Football Grid limiter it mirrors.
 */
export type GuestOperation = 'socket_admission' | 'lobby_create' | 'principal';

const RULES: Record<GuestOperation, { limit: number; windowSec: number }> = {
  /** Handshakes per IP bucket before any identity or geo work. */
  socket_admission: { limit: 60, windowSec: 60 },
  /** Rooms a single guest may open per hour. */
  lobby_create: { limit: 5, windowSec: 3_600 },
  /** Principal resolutions per IP bucket per hour. */
  principal: { limit: 120, windowSec: 3_600 },
};

const local = new Map<string, { count: number; resetAt: number }>();

export async function allowGuestOperation(subject: string, operation: GuestOperation): Promise<boolean> {
  const rule = RULES[operation];
  const bucket = Math.floor(Date.now() / (rule.windowSec * 1_000));
  const key = `guest:rate:${operation}:${subject}:${bucket}`;
  const redis = getRedisClient();
  if (redis?.isOpen) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, rule.windowSec + 5);
    return count <= rule.limit;
  }
  const now = Date.now();
  const current = local.get(key);
  const next = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + rule.windowSec * 1_000 }
    : { ...current, count: current.count + 1 };
  local.set(key, next);
  if (local.size > 10_000) {
    for (const [entryKey, value] of local) if (value.resetAt <= now) local.delete(entryKey);
  }
  return next.count <= rule.limit;
}

/** Test hook: forget the in-process buckets. */
export function resetGuestRateLimitsForTests(): void {
  local.clear();
}
