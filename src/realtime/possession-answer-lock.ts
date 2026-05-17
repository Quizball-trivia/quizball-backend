import { acquireLock, releaseLock } from './locks.js';
import { getRedisClient } from './redis.js';
import type { QuizballSocket } from './socket-server.js';

const ANSWER_LOCK_TTL_MS = 2000;

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
  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, lock.token);
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
