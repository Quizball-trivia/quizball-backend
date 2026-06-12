import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

type RedisSetOptions = { EX?: number; PX?: number; NX?: boolean };

class FakeRedis {
  isOpen = true;
  values = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
    }
    return removed;
  }

  async zAdd(key: string, entries: Array<{ score: number; value: string }>): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    let added = 0;
    for (const entry of entries) {
      if (!zset.has(entry.value)) added += 1;
      zset.set(entry.value, entry.score);
    }
    this.zsets.set(key, zset);
    return added;
  }

  async zRem(key: string, member: string): Promise<number> {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async zScore(key: string, member: string): Promise<number | null> {
    return this.zsets.get(key)?.get(member) ?? null;
  }

  async eval(script: string, params: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (script.includes('ZRANGEBYSCORE')) {
      const zset = this.zsets.get(params.keys[0]) ?? new Map<string, number>();
      const now = Number(params.arguments[0]);
      const limit = Number(params.arguments[1]);
      const due = Array.from(zset.entries())
        .filter(([, score]) => score <= now)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
      for (const member of due) zset.delete(member);
      return due;
    }

    const [key] = params.keys;
    const [token] = params.arguments;
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }
}

let redis: FakeRedis | null;

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

describe('realtime timer scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redis = new FakeRedis();
  });

  afterEach(async () => {
    const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
    stopRealtimeTimerScheduler();
    vi.useRealTimers();
  });

  it('stores scheduled timers in Redis and processes due payloads once', async () => {
    const handled = vi.fn(async () => {});
    const {
      __realtimeTimerInternals,
      scheduleRealtimeTimer,
      startRealtimeTimerScheduler,
    } = await import('../../src/realtime/realtime-timer-scheduler.js');

    startRealtimeTimerScheduler({} as QuizballServer, {
      possession_question: handled,
    });

    await scheduleRealtimeTimer(
      'possession_question',
      'm1:3',
      new Date(Date.now() + 1000),
      { kind: 'possession_question', matchId: 'm1', qIndex: 3 }
    );

    const member = __realtimeTimerInternals.timerMember('possession_question', 'm1:3');
    expect(redis?.zsets.get(__realtimeTimerInternals.TIMER_ZSET_KEY)?.get(member)).toBe(Date.now() + 1000);
    expect(redis?.values.get(__realtimeTimerInternals.timerPayloadKey(member))).toContain('"qIndex":3');

    await vi.advanceTimersByTimeAsync(1000);
    await __realtimeTimerInternals.pollDueTimers();
    await __realtimeTimerInternals.pollDueTimers();

    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'possession_question', matchId: 'm1', qIndex: 3 }
    );
    expect(redis?.values.has(__realtimeTimerInternals.timerPayloadKey(member))).toBe(false);
  });

  it('keeps the payload when the handler re-arms the same member during processing', async () => {
    const {
      __realtimeTimerInternals,
      scheduleRealtimeTimer,
      startRealtimeTimerScheduler,
    } = await import('../../src/realtime/realtime-timer-scheduler.js');

    // Handler that re-arms its own member (the possession round resolver does
    // this when a timeout fire no-ops: paused / lock busy / transient miss).
    const handled = vi.fn(async () => {
      await scheduleRealtimeTimer(
        'possession_question',
        'm1:3',
        new Date(Date.now() + 5000),
        { kind: 'possession_question', matchId: 'm1', qIndex: 3 }
      );
    });

    startRealtimeTimerScheduler({} as QuizballServer, {
      possession_question: handled,
    });

    await scheduleRealtimeTimer(
      'possession_question',
      'm1:3',
      new Date(Date.now() + 1000),
      { kind: 'possession_question', matchId: 'm1', qIndex: 3 }
    );

    const member = __realtimeTimerInternals.timerMember('possession_question', 'm1:3');
    await vi.advanceTimersByTimeAsync(1000);
    await __realtimeTimerInternals.pollDueTimers();

    expect(handled).toHaveBeenCalledTimes(1);
    // The re-armed member must survive post-processing cleanup: still in the
    // ZSET with its fresh score AND with its payload intact, so the retry fire
    // can actually be handled instead of being silently dropped.
    expect(redis?.zsets.get(__realtimeTimerInternals.TIMER_ZSET_KEY)?.get(member)).toBe(Date.now() + 5000);
    expect(redis?.values.get(__realtimeTimerInternals.timerPayloadKey(member))).toContain('"qIndex":3');

    // And the retry fire is processed normally once due (handler no longer
    // re-arms a second time here because vi.fn keeps re-arming — advance and
    // confirm it fired again).
    await vi.advanceTimersByTimeAsync(5000);
    await __realtimeTimerInternals.pollDueTimers();
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it('persists a match_disconnect_forfeit timer in Redis and fires it when overdue', async () => {
    const handled = vi.fn(async () => {});
    const {
      __realtimeTimerInternals,
      scheduleRealtimeTimer,
      startRealtimeTimerScheduler,
      stopRealtimeTimerScheduler,
    } = await import('../../src/realtime/realtime-timer-scheduler.js');

    startRealtimeTimerScheduler({} as QuizballServer, {
      match_disconnect_forfeit: handled,
    });

    // The disconnect grace forfeit is written to the Redis sorted set, NOT an
    // in-process setTimeout — that is what survives a backend restart. Schedule
    // it 60s out, then jump past it: a poll picks the now-overdue timer up from
    // Redis (exactly how a restarted process would replay it).
    await scheduleRealtimeTimer(
      'match_disconnect_forfeit',
      'match-9',
      new Date(Date.now() + 60_000),
      { kind: 'match_disconnect_forfeit', matchId: 'match-9', disconnectedUserId: 'user-7' }
    );
    const member = __realtimeTimerInternals.timerMember('match_disconnect_forfeit', 'match-9');
    expect(redis?.zsets.get(__realtimeTimerInternals.TIMER_ZSET_KEY)?.get(member)).toBe(Date.now() + 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    await __realtimeTimerInternals.pollDueTimers();
    await __realtimeTimerInternals.pollDueTimers();
    stopRealtimeTimerScheduler();

    expect(handled).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'match_disconnect_forfeit', matchId: 'match-9', disconnectedUserId: 'user-7' }
    );
  });

  it('cancels scheduled Redis timers and payloads', async () => {
    const {
      __realtimeTimerInternals,
      cancelRealtimeTimer,
      scheduleRealtimeTimer,
    } = await import('../../src/realtime/realtime-timer-scheduler.js');

    await scheduleRealtimeTimer(
      'party_question',
      'm2:1',
      new Date(Date.now() + 1000),
      { kind: 'party_question', matchId: 'm2', qIndex: 1 }
    );
    await cancelRealtimeTimer('party_question', 'm2:1');

    const member = __realtimeTimerInternals.timerMember('party_question', 'm2:1');
    expect(redis?.zsets.get(__realtimeTimerInternals.TIMER_ZSET_KEY)?.has(member)).toBe(false);
    expect(redis?.values.has(__realtimeTimerInternals.timerPayloadKey(member))).toBe(false);
  });
});
