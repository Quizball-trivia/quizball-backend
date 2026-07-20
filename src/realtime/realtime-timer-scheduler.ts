import { logger } from '../core/logger.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import { acquireLock, releaseLock } from './locks.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer } from './socket-server.js';

const TIMER_ZSET_KEY = 'realtime:timers';
const TIMER_PAYLOAD_PREFIX = 'realtime:timer:payload:';
const TIMER_LOCK_PREFIX = 'lock:realtime_timer:';
const TIMER_PAYLOAD_TTL_SEC = 60 * 60 * 6;
const TIMER_POLL_INTERVAL_MS = 500;
const TIMER_HARNESS_POLL_INTERVAL_MS = 25;
const TIMER_BATCH_SIZE = 100;
// Timer handlers frequently perform several database operations. Launching an
// entire 100-member Redis batch with Promise.all can instantly overflow the DB
// admission queue even when every query is fast. Keep each replica below the
// 12-slot DB bulkhead while still allowing independent replicas to share work.
const TIMER_HANDLER_CONCURRENCY = 4;

export type RealtimeTimerKind =
  | 'auction_bot_action'
  | 'auction_clue_reveal'
  | 'auction_clue_study'
  | 'auction_disconnect_grace'
  | 'auction_matchmaking_fill'
  | 'auction_resume_countdown'
  | 'auction_solo_pick_timeout'
  | 'auction_turn_timeout'
  | 'draft_ai_ban'
  | 'draft_auto_ban'
  | 'draft_grace_expiry'
  | 'match_disconnect_forfeit'
  | 'match_resume_countdown'
  | 'party_question'
  | 'party_round_transition'
  | 'possession_ai_answer'
  | 'possession_halftime'
  | 'possession_question'
  | 'ranked_draft_start';

export type RealtimeTimerPayload =
  | { kind: 'auction_bot_action'; matchId: string; roundId: string; expectedTurnSeatId: string; stateVersion: number; turnEndsAt: string | null }
  | { kind: 'auction_clue_reveal'; matchId: string; roundId: string; expectedClueIndex: number; stateVersion: number }
  | { kind: 'auction_clue_study'; matchId: string; roundId: string; stateVersion: number }
  | { kind: 'auction_disconnect_grace'; matchId: string; userId: string; seatId: string; disconnectCount: number }
  | { kind: 'auction_matchmaking_fill'; searchId: string }
  | { kind: 'auction_resume_countdown'; matchId: string; userId: string }
  | { kind: 'auction_solo_pick_timeout'; matchId: string; seatId: string; startedAt: string }
  | { kind: 'auction_turn_timeout'; matchId: string; roundId: string; expectedTurnSeatId: string; stateVersion: number; turnEndsAt: string | null }
  | { kind: 'draft_ai_ban'; lobbyId: string; aiUserId: string }
  | { kind: 'draft_auto_ban'; lobbyId: string; requireUiReady?: boolean; forceAtMs?: number | null }
  | { kind: 'draft_grace_expiry'; lobbyId: string; disconnectedUserId: string }
  | { kind: 'match_disconnect_forfeit'; matchId: string; disconnectedUserId: string; disconnectMarkerMs?: number }
  | { kind: 'match_resume_countdown'; matchId: string; pauseStartedAtMs: number | null }
  | { kind: 'party_question'; matchId: string; qIndex: number }
  | { kind: 'party_round_transition'; matchId: string; resolvedQIndex: number; nextQIndex: number }
  | { kind: 'possession_ai_answer'; matchId: string; qIndex: number; plannedAnswerTimeMs: number; plannedClueIndex: number | null; plannedIsCorrect?: boolean }
  | { kind: 'possession_halftime'; matchId: string }
  | { kind: 'possession_question'; matchId: string; qIndex: number }
  | { kind: 'ranked_draft_start'; lobbyId: string; userAId: string; userBId: string };

export type RealtimeTimerHandler = (
  io: QuizballServer,
  payload: RealtimeTimerPayload
) => Promise<void>;

export type RealtimeTimerHandlers = Partial<Record<RealtimeTimerKind, RealtimeTimerHandler>>;

let activeIo: QuizballServer | null = null;
let activeHandlers: RealtimeTimerHandlers = {};
let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;
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
    kind !== 'auction_bot_action'
    && kind !== 'auction_clue_reveal'
    && kind !== 'auction_clue_study'
    && kind !== 'auction_disconnect_grace'
    && kind !== 'auction_matchmaking_fill'
    && kind !== 'auction_resume_countdown'
    && kind !== 'auction_solo_pick_timeout'
    && kind !== 'auction_turn_timeout'
    && kind !== 'draft_ai_ban'
    && kind !== 'draft_auto_ban'
    && kind !== 'draft_grace_expiry'
    && kind !== 'match_disconnect_forfeit'
    && kind !== 'match_resume_countdown'
    && kind !== 'party_question'
    && kind !== 'party_round_transition'
    && kind !== 'possession_ai_answer'
    && kind !== 'possession_halftime'
    && kind !== 'possession_question'
    && kind !== 'ranked_draft_start'
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
    void handleTimerPayload(member, payload).catch((err) => {
      logger.error({ err, member }, 'Realtime fallback timer handler failed');
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
    // Stale-pop guard: a concurrent scheduleRealtimeTimer for this same member
    // (e.g. a pause/resume re-arming a turn deadline) may have landed between
    // the ZSET pop and here, replacing the payload with a FUTURE deadline and
    // re-adding the member. Handling now would execute that future deadline
    // early (observed risk: insta-folding a just-paused auction turn). If the
    // member is scheduled again in the future, this pop is stale — skip it and
    // let the re-armed entry fire at its own time.
    const redis = getRedisClient();
    if (redis?.isOpen) {
      const rescheduledAt = await redis.zScore(TIMER_ZSET_KEY, member);
      if (typeof rescheduledAt === 'number' && rescheduledAt > Date.now() + 250) {
        logger.debug({ member, rescheduledAt }, 'Realtime timer pop superseded by re-arm; skipping');
        return;
      }
    }

    const payload = await readPayload(member);
    if (!payload) {
      // The member was already popped from the ZSET; without a payload it can
      // never be handled. This used to be a fully silent drop — log it so a
      // lost timer (e.g. payload deleted by a concurrent fire's cleanup while
      // a re-armed member was still pending) is at least visible in prod.
      logger.warn({ member }, 'Realtime timer payload missing; dropping due timer');
      return;
    }
    await handleTimerPayload(member, payload);
    handled = true;
  } catch (error) {
    await rescheduleRedisMember(member, Date.now() + 1000);
    throw error;
  } finally {
    await releaseLock(timerLockKey(member), lock.token).catch(() => {});
    const redis = getRedisClient();
    if (handled && redis?.isOpen) {
      // A handler may have re-armed this same member (e.g. a possession round
      // resolve that no-oped re-defers its question timeout, or the halftime
      // force-open rebasing its own deadline). In that case the member is back
      // in the ZSET with a fresh payload — deleting the payload here would
      // guarantee the re-armed fire gets silently dropped. The check and the
      // delete MUST be one atomic step: a non-atomic zScore→del lets a
      // concurrent re-arm land in between, leaving an armed member whose
      // payload we just destroyed (observed with the halftime re-arm).
      try {
        await redis.eval(CLEANUP_PAYLOAD_IF_UNSCHEDULED_SCRIPT, {
          keys: [TIMER_ZSET_KEY, timerPayloadKey(member)],
          arguments: [member],
        });
      } catch (err) {
        logger.warn({ err, member }, 'Failed to clear realtime timer payload after processing');
      }
    }
  }
}

async function rescheduleRedisMember(member: string, dueAtMs: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  await redis.zAdd(TIMER_ZSET_KEY, [{ score: dueAtMs, value: member }]).catch((err) => {
    logger.warn({ err, member }, 'Failed to reschedule realtime timer');
  });
}

const POP_DUE_TIMERS_SCRIPT = `
  local items = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
  if #items > 0 then
    redis.call("ZREM", KEYS[1], unpack(items))
  end
  return items
`;

// Post-handling cleanup: delete the payload ONLY IF the member is not
// scheduled (anymore). Atomic on purpose — see the comment at the call site.
const CLEANUP_PAYLOAD_IF_UNSCHEDULED_SCRIPT = `
  if redis.call("ZSCORE", KEYS[1], ARGV[1]) then
    return 0
  end
  redis.call("DEL", KEYS[2])
  return 1
`;

async function processDueMembers(members: string[]): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(TIMER_HANDLER_CONCURRENCY, members.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < members.length) {
      const member = members[nextIndex];
      nextIndex += 1;
      if (!member) continue;
      await processDueMember(member).catch((error) => {
        // Pino's Error serializer is attached to the conventional `err` key.
        // Logging this as `error` produced `{}` during the 1k staging run and
        // hid the exact database-admission failure we needed to diagnose.
        logger.error({ err: error, member }, 'Failed to process realtime timer');
      });
    }
  }));
}

async function pollDueTimersOnce(): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;

  let dueMembers: unknown;
  try {
    dueMembers = await redis.eval(POP_DUE_TIMERS_SCRIPT, {
      keys: [TIMER_ZSET_KEY],
      arguments: [String(Date.now()), String(TIMER_BATCH_SIZE)],
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to poll realtime timers from Redis');
    return;
  }

  if (!Array.isArray(dueMembers) || dueMembers.length === 0) return;
  await processDueMembers(
    dueMembers.filter((member): member is string => typeof member === 'string')
  );
}

async function pollDueTimers(): Promise<void> {
  // setInterval does not wait for an async callback. Without this guard, a slow
  // batch lets later polls overlap it and defeats the handler concurrency cap.
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollDueTimersOnce();
  } finally {
    pollInFlight = false;
  }
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
  }, harnessDelayMs(TIMER_POLL_INTERVAL_MS, TIMER_HARNESS_POLL_INTERVAL_MS));
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

  // Payload + ZSET membership must become visible atomically. With two
  // separate roundtrips, processDueMember's post-handling cleanup (which
  // checks zScore before deleting the payload) can interleave between the
  // SET and the ZADD: it observes "member not scheduled", deletes the freshly
  // written payload, and the ZADD then arms a timer that can never be handled
  // (payload-missing drop at fire time). Observed with the halftime re-arm.
  await redis
    .multi()
    .set(timerPayloadKey(member), JSON.stringify(payload), { EX: TIMER_PAYLOAD_TTL_SEC })
    .zAdd(TIMER_ZSET_KEY, [{ score: dueAt.getTime(), value: member }])
    .exec();
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
  TIMER_HANDLER_CONCURRENCY,
  TIMER_ZSET_KEY,
  pollDueTimers,
  timerMember,
  timerPayloadKey,
};
