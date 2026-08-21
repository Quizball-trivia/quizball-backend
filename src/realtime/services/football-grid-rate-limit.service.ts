import { getRedisClient } from '../redis.js';

type Operation = 'search' | 'command' | 'resync' | 'rematch' | 'report' | 'heartbeat';

const RULES: Record<Operation, { limit: number; windowSec: number }> = {
  search: { limit: 10, windowSec: 60 },
  command: { limit: 40, windowSec: 60 },
  resync: { limit: 20, windowSec: 60 },
  rematch: { limit: 10, windowSec: 60 },
  report: { limit: 5, windowSec: 86_400 },
  heartbeat: { limit: 30, windowSec: 60 },
};

const local = new Map<string, { count: number; resetAt: number }>();

export async function allowFootballGridOperation(userId: string, operation: Operation): Promise<boolean> {
  const rule = RULES[operation];
  const bucket = Math.floor(Date.now() / (rule.windowSec * 1_000));
  const key = `football_grid:rate:${operation}:${userId}:${bucket}`;
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
