import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import { createHarnessClock } from '../../game-regression/src/clock.mjs';

// Minimal fake Redis supporting the durable timer scheduler (mirrors the pattern
// in realtime-timer-scheduler.test.ts) so we can prove the harness clock fires a
// real scheduled timer deterministically.
class FakeRedis {
  isOpen = true;
  values = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async set(k: string, v: string, o?: { NX?: boolean }) {
    if (o?.NX && this.values.has(k)) return null;
    this.values.set(k, v); return 'OK';
  }
  async del(k: string | string[]) {
    const keys = Array.isArray(k) ? k : [k]; let n = 0;
    for (const key of keys) if (this.values.delete(key)) n++; return n;
  }
  async zAdd(k: string, e: Array<{ score: number; value: string }>) {
    const z = this.zsets.get(k) ?? new Map(); for (const x of e) z.set(x.value, x.score);
    this.zsets.set(k, z); return e.length;
  }
  async zRem(k: string, m: string) { return this.zsets.get(k)?.delete(m) ? 1 : 0; }
  async eval(script: string, p: { keys: string[]; arguments: string[] }) {
    if (script.includes('ZRANGEBYSCORE')) {
      const z = this.zsets.get(p.keys[0]) ?? new Map<string, number>();
      const now = Number(p.arguments[0]);
      const due = Array.from(z.entries()).filter(([, s]) => s <= now).map(([m]) => m);
      for (const m of due) z.delete(m);
      return due;
    }
    const [key] = p.keys; const [token] = p.arguments;
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key); return 1;
  }
}

let redis: FakeRedis;
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => redis }));

describe('harness clock drives the durable scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); redis = new FakeRedis(); });
  afterEach(async () => {
    const { stopRealtimeTimerScheduler } = await import('../../src/realtime/realtime-timer-scheduler.js');
    stopRealtimeTimerScheduler();
    vi.useRealTimers();
  });

  it('fires a scheduled timer when the clock advances past its due time', async () => {
    const fired = vi.fn(async () => {});
    const { scheduleRealtimeTimer, startRealtimeTimerScheduler } =
      await import('../../src/realtime/realtime-timer-scheduler.js');

    // Real scheduler with a fake io; register a handler for the question kind.
    startRealtimeTimerScheduler({} as QuizballServer, {
      possession_question: fired,
    });

    await scheduleRealtimeTimer(
      'possession_question',
      'm1:0',
      new Date(Date.now() + 3000),
      { kind: 'possession_question', matchId: 'm1', qIndex: 0 },
    );

    const clock = createHarnessClock(vi);

    // Before the due time: handler must NOT have fired.
    await clock.advance(1000);
    expect(fired).not.toHaveBeenCalled();

    // Past the due time: the scheduler's poll interval + the faked clock fire it.
    await clock.advance(3000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'possession_question', matchId: 'm1', qIndex: 0 },
    );
  });

  it('advanceUntil stops as soon as the predicate is met', async () => {
    const { scheduleRealtimeTimer, startRealtimeTimerScheduler } =
      await import('../../src/realtime/realtime-timer-scheduler.js');
    let done = false;
    startRealtimeTimerScheduler({} as QuizballServer, {
      possession_question: async () => { done = true; },
    });
    await scheduleRealtimeTimer(
      'possession_question', 'm2:0', new Date(Date.now() + 1500),
      { kind: 'possession_question', matchId: 'm2', qIndex: 0 },
    );
    const clock = createHarnessClock(vi);
    const met = await clock.advanceUntil(() => done, 10_000);
    expect(met).toBe(true);
    expect(done).toBe(true);
  });
});
