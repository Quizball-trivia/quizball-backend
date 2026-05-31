import { getRedisClient } from './redis.js';
import { logger } from '../core/logger.js';

/**
 * Site-wide "online now" presence via lightweight heartbeat pings.
 *
 * Distinct from the in-game `presence:online_users` socket counter: this counts
 * EVERY visitor on the site (anonymous + logged-in) who pinged recently, without
 * holding a WebSocket open per visitor. Powers the "X online" badge.
 *
 * Backed by a single Redis sorted set: member = anonymous cookie id
 * (`anon:<cookieId>`), score = last-seen epoch ms. A ping is a ZADD; the count
 * trims stale members then reads ZCARD. Self-cleaning, no `KEYS *`, no per-key
 * TTL bookkeeping.
 */

export const PRESENCE_PING_KEY = 'presence:ping_z';
export const PRESENCE_PING_TTL_MS = 60_000;

/** Record a visitor as currently online (or refresh their last-seen time). */
export async function recordPing(member: string, nowMs: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  try {
    await redis.zAdd(PRESENCE_PING_KEY, { score: nowMs, value: member });
  } catch (error) {
    logger.warn({ error, member }, 'Failed to record presence ping');
  }
}

/** Trim members older than the TTL, then return how many are still online. */
export async function getOnlineCount(nowMs: number): Promise<number> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return 0;
  try {
    await redis.zRemRangeByScore(PRESENCE_PING_KEY, 0, nowMs - PRESENCE_PING_TTL_MS);
    return await redis.zCard(PRESENCE_PING_KEY);
  } catch (error) {
    logger.warn({ error }, 'Failed to get online presence count');
    return 0;
  }
}
