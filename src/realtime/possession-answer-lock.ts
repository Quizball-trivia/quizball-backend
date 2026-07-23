import { acquireLock, extendLock, releaseLock } from './locks.js';
import { getRedisClient } from './redis.js';
import type { QuizballSocket } from './socket-server.js';

const ANSWER_LOCK_TTL_MS = 2000;
const ANSWER_LOCK_RENEW_MS = Math.floor(ANSWER_LOCK_TTL_MS / 2);
const ANSWER_LOCK_WAIT_MS = 500;
const ANSWER_LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireAnswerLock(lockKey: string): Promise<Awaited<ReturnType<typeof acquireLock>>> {
  const deadline = Date.now() + ANSWER_LOCK_WAIT_MS;
  do {
    const lock = await acquireLock(lockKey, ANSWER_LOCK_TTL_MS);
    if (lock.acquired && lock.token) return lock;
    if (Date.now() >= deadline) return { acquired: false };
    await sleep(Math.min(ANSWER_LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { acquired: false };
}

export async function withAnswerLock<T>(
  matchId: string,
  lockSuffix: string,
  onBusy: () => void,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const lockKey = `lock:match:${matchId}:${lockSuffix}`;
  // Two players normally submit within the same answer window. A single NX
  // attempt made the loser surface MATCH_BUSY and drop an otherwise valid
  // answer. Wait briefly for the tiny critical section to finish; the bound is
  // deliberately far below the 2s lease and the question's answer window.
  const lock = await acquireAnswerLock(lockKey);
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
