import { acquireLock, extendLock, releaseLock } from './locks.js';
import { getRedisClient } from './redis.js';
import type { QuizballSocket } from './socket-server.js';

const ANSWER_LOCK_TTL_MS = 2000;
const ANSWER_LOCK_RENEW_MS = Math.floor(ANSWER_LOCK_TTL_MS / 2);

export async function withAnswerLock<T>(
  matchId: string,
  lockSuffix: string,
  onBusy: () => void,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const lockKey = `lock:match:${matchId}:${lockSuffix}`;
  const lock = await acquireLock(lockKey, ANSWER_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    onBusy();
    return undefined;
  }
  // Renew the lock at half the TTL so a slow fn() can't run past expiry
  // and let a concurrent handler in. Stops on release in finally.
  const token = lock.token;
  const renew = setInterval(() => {
    void extendLock(lockKey, token, ANSWER_LOCK_TTL_MS).catch(() => {});
  }, ANSWER_LOCK_RENEW_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await releaseLock(lockKey, token);
  }
}

export function emitMatchBusy(socket: QuizballSocket): void {
  socket.emit('error', {
    code: 'MATCH_BUSY',
    message: 'Match is busy. Please retry answer submission.',
  });
}

export function isRedisAvailable(): boolean {
  const redis = getRedisClient();
  return !!redis && redis.isOpen;
}

export function emitRedisUnavailable(socket: QuizballSocket, questionLabel: string): void {
  socket.emit('error', {
    code: 'MATCH_UNAVAILABLE',
    message: `${questionLabel} questions require Redis-backed realtime state.`,
  });
}
