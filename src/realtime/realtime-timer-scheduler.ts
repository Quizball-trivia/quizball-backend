import { logger } from '../core/logger.js';
import { acquireLock, releaseLock } from './locks.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer } from './socket-server.js';

const TIMER_ZSET_KEY = 'realtime:timers';
const TIMER_PAYLOAD_PREFIX = 'realtime:timer:payload:';
const TIMER_LOCK_PREFIX = 'lock:realtime_timer:';
const TIMER_PAYLOAD_TTL_SEC = 60 * 60 * 6;
const TIMER_POLL_INTERVAL_MS = 500;
const TIMER_BATCH_SIZE = 100;

export type RealtimeTimerKind =
  | 'draft_ai_ban'
  | 'draft_auto_ban'
  | 'draft_grace_expiry'
  | 'match_disconnect_forfeit'
  | 'party_question'
  | 'possession_ai_answer'
  | 'possession_halftime'
  | 'possession_question';

export type RealtimeTimerPayload =
  | { kind: 'draft_ai_ban'; lobbyId: string; aiUserId: string }
  | { kind: 'draft_auto_ban'; lobbyId: string }
  | { kind: 'draft_grace_expiry'; lobbyId: string; disconnectedUserId: string }
  | { kind: 'match_disconnect_forfeit'; matchId: string; disconnectedUserId: string }
  | { kind: 'party_question'; matchId: string; qIndex: number }
  | { kind: 'possession_ai_answer'; matchId: string; qIndex: number; plannedAnswerTimeMs: number; plannedClueIndex: number | null }
  | { kind: 'possession_halftime'; matchId: string }
  | { kind: 'possession_question'; matchId: string; qIndex: number };

export type RealtimeTimerHandler = (
  io: QuizballServer,
  payload: RealtimeTimerPayload
) => Promise<void>;

export type RealtimeTimerHandlers = Partial<Record<RealtimeTimerKind, RealtimeTimerHandler>>;

let activeIo: QuizballServer | null = null;
let activeHandlers: RealtimeTimerHandlers = {};
let pollTimer: NodeJS.Timeout | null = null;
const localFallbackTimers = new Map<string, NodeJS.Timeout>();

function timerMember(kind: RealtimeTimerKind, key: string): string {
  return `${kind}:${key}`;
}

function timerPayloadKey(member: string): string {
  return `${TIMER_PAYLOAD_PREFIX}${member}`;
}

function timerLockKey(member: string): string {
  return `${TIMER_LOCK_PREFIX}${member}`;
}

function parseTimerMember(member: string): { kind: RealtimeTimerKind; key: string } | null {
  const separator = member.indexOf(':');
  if (separator <= 0) return null;
  const kind = member.slice(0, separator) as RealtimeTimerKind;
  const key = member.slice(separator + 1);
  if (!key) return null;
  if (
    kind !== 'draft_ai_ban'
    && kind !== 'draft_auto_ban'
    && kind !== 'draft_grace_expiry'
    && kind !== 'match_disconnect_forfeit'
    && kind !== 'party_question'
    && kind !== 'possession_ai_answer'
    && kind !== 'possession_halftime'
    && kind !== 'possession_question'
  ) {
    return null;
  }
  return { kind, key };
}

function clearLocalFallbackTimer(member: string): void {
  const timer = localFallbackTimers.get(member);
  if (!timer) return;
  clearTimeout(timer);
  localFallbackTimers.delete(member);
}

function scheduleLocalFallback(member: string, dueAtMs: number, payload: RealtimeTimerPayload): void {
  clearLocalFallbackTimer(member);
  if (!activeIo) return;
  const delayMs = Math.max(0, dueAtMs - Date.now());
  const timer = setTimeout(() => {
    localFallbackTimers.delete(member);
    void handleTimerPayload(member, payload).catch((error) => {
      logger.error({ error, member }, 'Realtime fallback timer handler failed');
    });
  }, delayMs);
  timer.unref?.();
  localFallbackTimers.set(member, timer);
}

async function handleTimerPayload(member: string, payload: RealtimeTimerPayload): Promise<void> {
  if (!activeIo) return;
  const handler = activeHandlers[payload.kind];
  if (!handler) {
    logger.warn({ kind: payload.kind, member }, 'No realtime timer handler registered');
    return;
  }

  await handler(activeIo, payload);
}

async function readPayload(member: string): Promise<RealtimeTimerPayload | null> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return null;
  const raw = await redis.get(timerPayloadKey(member));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RealtimeTimerPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    const memberParts = parseTimerMember(member);
    if (!memberParts || parsed.kind !== memberParts.kind) return null;
    return parsed;
  } catch {
    logger.warn({ member }, 'Invalid realtime timer payload JSON');
    return null;
  }
}

async function processDueMember(member: string): Promise<void> {
  const lock = await acquireLock(timerLockKey(member), 10_000);
  if (!lock.acquired || !lock.token) {
    await rescheduleRedisMember(member, Date.now() + 1000);
    return;
  }

  let handled = false;
  try {
    const payload = await readPayload(member);
    if (!payload) return;
    await handleTimerPayload(member, payload);
    handled = true;
  } catch (error) {
    await rescheduleRedisMember(member, Date.now() + 1000);
    throw error;
  } finally {
    await releaseLock(timerLockKey(member), lock.token).catch(() => {});
    const redis = getRedisClient();
    if (handled && redis?.isOpen) {
      await redis.del(timerPayloadKey(member)).catch((error) => {
        logger.warn({ error, member }, 'Failed to clear realtime timer payload after processing');
      });
    }
  }
}

async function rescheduleRedisMember(member: string, dueAtMs: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  await redis.zAdd(TIMER_ZSET_KEY, [{ score: dueAtMs, value: member }]).catch((error) => {
    logger.warn({ error, member }, 'Failed to reschedule realtime timer');
  });
}

const POP_DUE_TIMERS_SCRIPT = `
  local items = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
  if #items > 0 then
    redis.call("ZREM", KEYS[1], unpack(items))
  end
  return items
`;

async function pollDueTimers(): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;

  let dueMembers: unknown;
  try {
    dueMembers = await redis.eval(POP_DUE_TIMERS_SCRIPT, {
      keys: [TIMER_ZSET_KEY],
      arguments: [String(Date.now()), String(TIMER_BATCH_SIZE)],
    });
  } catch (error) {
    logger.warn({ error }, 'Failed to poll realtime timers from Redis');
    return;
  }

  if (!Array.isArray(dueMembers) || dueMembers.length === 0) return;
  await Promise.all(
    dueMembers
      .filter((member): member is string => typeof member === 'string')
      .map((member) => processDueMember(member).catch((error) => {
        logger.error({ error, member }, 'Failed to process realtime timer');
      }))
  );
}

export function startRealtimeTimerScheduler(
  io: QuizballServer,
  handlers: RealtimeTimerHandlers
): void {
  activeIo = io;
  activeHandlers = handlers;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void pollDueTimers();
  }, TIMER_POLL_INTERVAL_MS);
  pollTimer.unref?.();

  void pollDueTimers();
}

export function stopRealtimeTimerScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const timer of localFallbackTimers.values()) {
    clearTimeout(timer);
  }
  localFallbackTimers.clear();
  activeIo = null;
  activeHandlers = {};
}

export async function scheduleRealtimeTimer(
  kind: RealtimeTimerKind,
  key: string,
  dueAt: Date,
  payload: RealtimeTimerPayload
): Promise<void> {
  const member = timerMember(kind, key);
  clearLocalFallbackTimer(member);

  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    scheduleLocalFallback(member, dueAt.getTime(), payload);
    return;
  }

  await redis.set(timerPayloadKey(member), JSON.stringify(payload), { EX: TIMER_PAYLOAD_TTL_SEC });
  await redis.zAdd(TIMER_ZSET_KEY, [{ score: dueAt.getTime(), value: member }]);
}

/** True if a timer for this kind+key is still scheduled (Redis or local fallback). */
export async function hasPendingRealtimeTimer(kind: RealtimeTimerKind, key: string): Promise<boolean> {
  const member = timerMember(kind, key);
  if (localFallbackTimers.has(member)) return true;
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return false;
  const score = await redis.zScore(TIMER_ZSET_KEY, member);
  return score !== null && !Number.isNaN(score) && score > Date.now();
}

export async function cancelRealtimeTimer(kind: RealtimeTimerKind, key: string): Promise<void> {
  const member = timerMember(kind, key);
  clearLocalFallbackTimer(member);

  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  await Promise.all([
    redis.zRem(TIMER_ZSET_KEY, member),
    redis.del(timerPayloadKey(member)),
  ]);
}

export const __realtimeTimerInternals = {
  TIMER_ZSET_KEY,
  pollDueTimers,
  timerMember,
  timerPayloadKey,
};
