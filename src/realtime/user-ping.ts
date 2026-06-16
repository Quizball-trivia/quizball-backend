import { getRedisClient } from './redis.js';

/**
 * Latest measured connection RTT per user, so a match can show the OPPONENT's
 * ping (the client only knows its own RTT). The client reports its measured
 * value via `connection:rtt`; we keep the most recent reading with a short TTL
 * and surface the opponent's value in the match/showdown payload.
 *
 * Short TTL (90s): a stale reading from a previous session must not leak into a
 * new match. If a user hasn't reported recently, the opponent simply sees no
 * ping pill — which is the correct, honest fallback.
 */

const USER_PING_TTL_SEC = 90;

// Defensive clamp: ignore absurd/garbage client values so a bad report can't
// render "999999 ms" on the opponent's screen.
const MIN_RTT_MS = 0;
const MAX_RTT_MS = 5000;

function userPingKey(userId: string): string {
  return `user:ping_ms:${userId}`;
}

export async function setUserPingMs(userId: string, rttMs: number): Promise<void> {
  if (!userId) return;
  if (!Number.isFinite(rttMs)) return;
  const clamped = Math.round(Math.max(MIN_RTT_MS, Math.min(MAX_RTT_MS, rttMs)));
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  try {
    await redis.set(userPingKey(userId), String(clamped), { EX: USER_PING_TTL_SEC });
  } catch {
    // Best-effort: ping telemetry should never break socket/event handling.
  }
}

export async function getUserPingMs(userId: string): Promise<number | null> {
  if (!userId) return null;
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  // Best-effort: a failed read must degrade to null, never throw — this runs
  // while assembling the opponent payload and must not break it.
  let raw: string | null;
  try {
    raw = await redis.get(userPingKey(userId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
