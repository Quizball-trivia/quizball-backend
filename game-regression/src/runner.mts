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
import type { FakeTimerApi } from './clock.mjs';
import { createHarnessClock } from './clock.mjs';
import { FakeIo, createTrace, type EventTrace, type FakeSocket } from './adapter.mjs';
import { seedFixtures, seedTestUserWithTicket, type SeededFixtures } from './fixtures.mjs';

// Engine imports (resolved against backend-node/src).
import { getRedisClient, initRedisClients } from '../../src/realtime/redis.js';
import { rankedMatchmakingService } from '../../src/realtime/services/ranked-matchmaking.service.js';
import { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } from '../../src/realtime/realtime-timer-scheduler.js';
import { buildRealtimeTimerHandlers } from '../../src/realtime/socket-server.js';

export interface RunMatchResult {
  trace: EventTrace;
  fixtures: SeededFixtures;
  botUserId: string;
  matchId: string | null;
}

export interface RunMatchOptions {
  vi: FakeTimerApi & { setSystemTime?: (t: number) => void };
  botUserId?: string;
  seed?: string;
  /** Max fake-ms to wait for the match to start before giving up. */
  startTimeoutMs?: number;
}

const BOT_USER_ID = '00000000-0000-0000-0000-0000000000b0';

/** Boot a ranked-AI match and return the trace once a match:start is observed. */
export async function bootMatch(options: RunMatchOptions): Promise<RunMatchResult> {
  const vi = options.vi;
  const botUserId = options.botUserId ?? BOT_USER_ID;
  const clock = createHarnessClock(vi);

  const now = () => Date.now();
  const trace = createTrace(now);
  const io = new FakeIo(trace);

  // 1. Seed fixtures + ticketed bot user.
  const fixtures = await seedFixtures({ categoryCount: 3, mcqPerCategory: 5 });
  await seedTestUserWithTicket({ userId: botUserId, nickname: 'RegressionBot', tickets: 1 });

  // 2. Redis + the durable timer scheduler + the matchmaking loop.
  await initRedisClients();
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

  // 5. Advance fake time past the queue search window so processFallbacks starts AI.
  const startTimeout = options.startTimeoutMs ?? 30_000;
  const started = await clock.advanceUntil(
    () => trace.byEvent('match:start').length > 0,
    startTimeout,
  );

  let matchId: string | null = null;
  if (started) {
    const startEvt = trace.byEvent('match:start')[0];
    const payload = startEvt.payload as { matchId?: string } | undefined;
    matchId = payload?.matchId ?? null;
    if (matchId) botSocket.data.matchId = matchId;
  }

  return { trace, fixtures, botUserId, matchId };
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
