import { getRedisClient } from '../redis.js';

export type DuelOperation = 'command' | 'sync' | 'start' | 'start_ip' | 'report';

const RULES: Record<DuelOperation, { limit: number; windowSec: number }> = {
  /** Picks, guesses, passes, ready, forfeit: generous for play, bounded for scripts. */
  command: { limit: 60, windowSec: 10 },
  /** Resyncs (focus, reconnect). */
  sync: { limit: 30, windowSec: 10 },
  /** Duels a person may start per hour, rematches included (a guest's room creations are budgeted separately). */
  start: { limit: 30, windowSec: 3_600 },
  /** ...and per IP bucket, so many guest pairs behind one address cannot start without bound. */
  start_ip: { limit: 120, windowSec: 3_600 },
  /** "That was right" reports from the word games: a rare tap. */
  report: { limit: 6, windowSec: 60 },
};

const local = new Map<string, { count: number; resetAt: number }>();

/** `subject` is a user id, or an IP bucket for the `_ip` rules. Room games share the rules under their own keys. */
export async function allowDuelOperation(subject: string, operation: DuelOperation, namespace: 'duel' | 'room' = 'duel'): Promise<boolean> {
  const rule = RULES[operation];
  const bucket = Math.floor(Date.now() / (rule.windowSec * 1_000));
  const key = `${namespace}:rate:${operation}:${subject}:${bucket}`;
  const redis = getRedisClient();
  if (redis?.isOpen) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, rule.windowSec + 5);
    return count <= rule.limit;
  }
  const now = Date.now();
  const current = local.get(key);
  const next = !current || current.resetAt <= now ? { count: 1, resetAt: now + rule.windowSec * 1_000 } : { ...current, count: current.count + 1 };
  local.set(key, next);
  if (local.size > 10_000) for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
  return next.count <= rule.limit;
}
