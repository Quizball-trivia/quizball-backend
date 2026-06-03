/**
 * In-process match runner: boots a REAL ranked-AI match through the production
 * path (ranked:queue_join -> processFallbacks -> startRankedAiForUser -> draft ->
 * match) using the FakeIo adapter + the harness clock, and returns the EventTrace.
 *
 * IMPORTANT: the engine reads config (DATABASE_URL / REDIS_URL) at import time, so
 * callers MUST set those env vars to the LOCAL DB/Redis BEFORE importing this
 * module. The test harness does that in its setup.
 *
 * Consumed from a vitest test (fake timers live there). `vi` is injected.
 */
import { FakeIo, createTrace, type EventTrace, type FakeSocket } from './adapter.mjs';
import { seedFixtures, seedTestUserWithTicket, type SeededFixtures } from './fixtures.mjs';

// Engine imports (resolved against backend-node/src).
import { getRedisClient, initRedisClients } from '../../src/realtime/redis.js';
import { rankedMatchmakingService } from '../../src/realtime/services/ranked-matchmaking.service.js';
import { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } from '../../src/realtime/realtime-timer-scheduler.js';
import { buildRealtimeTimerHandlers } from '../../src/realtime/socket-server.js';
import { handlePossessionAnswer } from '../../src/realtime/possession-answer-handlers.js';

export interface RunMatchResult {
  trace: EventTrace;
  fixtures: SeededFixtures;
  botUserId: string;
  matchId: string | null;
  io: FakeIo;
  botSocket: FakeSocket;
}

export interface RunMatchOptions {
  botUserId?: string;
  seed?: string;
  /** Max real-ms to wait for the match to start. With REGRESSION_FAST_TIMERS the
   *  whole boot is a few hundred ms, so a couple of seconds is ample. */
  startTimeoutMs?: number;
}

const BOT_USER_ID = '00000000-0000-0000-0000-0000000000b0';

/** Real-time poll until `predicate` is true or `maxMs` elapses. */
async function waitUntil(predicate: () => boolean, maxMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  if (predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    if (predicate()) return true;
  }
  return false;
}

/** Boot a ranked-AI match and return the trace once a match:start is observed. */
export async function bootMatch(options: RunMatchOptions = {}): Promise<RunMatchResult> {
  const botUserId = options.botUserId ?? BOT_USER_ID;

  const now = () => Date.now();
  const trace = createTrace(now);
  const io = new FakeIo(trace);

  // 1. Seed fixtures + ticketed bot user.
  const fixtures = await seedFixtures({ categoryCount: 3, mcqPerCategory: 5 });
  await seedTestUserWithTicket({ userId: botUserId, nickname: 'RegressionBot', tickets: 1 });

  // 2. Redis + the durable timer scheduler + the matchmaking loop.
  await initRedisClients();
  // Flush ALL Redis state so leftover matchmaking/queue/timer entries from a
  // prior (or killed) run can't confuse this one — the realtime engine keys are
  // transient and the harness Redis is local + isolated. This was the cause of a
  // stale-queued-search blocking the AI fallback between runs.
  const redisForFlush = getRedisClient();
  if (redisForFlush?.isOpen) await redisForFlush.flushAll();
  startRealtimeTimerScheduler(io as never, buildRealtimeTimerHandlers());
  rankedMatchmakingService.start(io as never);

  // 3. The bot socket (one human seat), joined to its own user room.
  const botSocket: FakeSocket = io.createSocket('bot-socket-1', {
    user: { id: botUserId },
    connectedAt: now(),
  });
  botSocket.join(`user:${botUserId}`);

  // 4. Join the ranked queue (real production entry point).
  await rankedMatchmakingService.handleQueueJoin(io as never, botSocket as never);

  // 5. Wait (real, fast time) for queue -> AI fallback -> draft -> match:start ->
  //    first question. With REGRESSION_FAST_TIMERS the delays are ~5ms each.
  const startTimeout = options.startTimeoutMs ?? 10_000;
  const started = await waitUntil(
    () => trace.byEvent('match:start').length > 0 && trace.byEvent('match:question').length > 0,
    startTimeout,
  );

  let matchId: string | null = null;
  if (started) {
    const startEvt = trace.byEvent('match:start')[0];
    const payload = startEvt.payload as { matchId?: string } | undefined;
    matchId = payload?.matchId ?? null;
    if (matchId) botSocket.data.matchId = matchId;
  }

  return { trace, fixtures, botUserId, matchId, io, botSocket };
}

interface QuestionEventPayload {
  matchId: string;
  qIndex: number;
  question?: { kind?: string };
  correctIndex?: number;
  deadlineAt?: string;
}

/**
 * Drive the bot to play the match to completion. The bot answers MCQ questions
 * (correctly, deterministically — score control comes later via the planner) and
 * lets non-MCQ specials time out (the engine resolves them); the AI side is
 * server-driven. Halftime banning auto-resolves via its timer. Returns when
 * match:final_results is observed or the timeout elapses.
 */
export async function playMatch(
  run: RunMatchResult,
  opts: { maxMs?: number; answerEveryMs?: number } = {},
): Promise<void> {
  const { trace, io, botSocket } = run;
  const maxMs = opts.maxMs ?? 30_000;
  const answered = new Set<number>();
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    if (trace.byEvent('match:final_results').length > 0) return;

    // Answer the latest unanswered MCQ question.
    const questions = trace.byEvent('match:question');
    const latest = questions[questions.length - 1]?.payload as QuestionEventPayload | undefined;
    if (latest && !answered.has(latest.qIndex) && latest.question?.kind === 'multipleChoice') {
      answered.add(latest.qIndex);
      // Answer correctly when the server reveals the index (it does for MCQ).
      const selectedIndex = typeof latest.correctIndex === 'number' ? latest.correctIndex : 0;
      try {
        await handlePossessionAnswer(io as never, botSocket as never, {
          matchId: latest.matchId,
          qIndex: latest.qIndex,
          selectedIndex,
          timeMs: 300,
        });
      } catch {
        // A late/duplicate answer can throw; ignore — the engine guards it.
      }
    }
    await new Promise((r) => setTimeout(r, opts.answerEveryMs ?? 50));
  }
}

/** Boot + play a full match to completion; returns the result with its trace. */
export async function runFullMatch(options: RunMatchOptions = {}): Promise<RunMatchResult> {
  const run = await bootMatch(options);
  if (run.matchId) await playMatch(run);
  return run;
}

/** Tear down scheduler + matchmaking loop + redis between runs. */
export async function teardownRun(): Promise<void> {
  rankedMatchmakingService.stop();
  stopRealtimeTimerScheduler();
  const redis = getRedisClient();
  if (redis?.isOpen) {
    // best-effort flush of harness keys is left to the caller's DB/redis reset
  }
}
