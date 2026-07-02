import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/config.js', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
}));

const { fatal } = vi.hoisted(() => ({ fatal: vi.fn() }));
vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), fatal },
}));

import { closeRedisClients, runWatchdogTick, __watchdogTestHooks } from '../../src/realtime/redis.js';

type PingBehaviour = 'ok' | 'reject' | 'hang';

function makeClient(name: string, behaviour: () => PingBehaviour) {
  const calls = { ping: 0, disconnect: 0, connect: 0 };
  const client = {
    isOpen: true,
    ping: vi.fn(() => {
      calls.ping += 1;
      const mode = behaviour();
      if (mode === 'ok') return Promise.resolve('PONG');
      if (mode === 'reject') return Promise.reject(new Error('ping error'));
      return new Promise<string>(() => {}); // hang forever
    }),
    disconnect: vi.fn(() => {
      calls.disconnect += 1;
      client.isOpen = false;
      return Promise.resolve();
    }),
    connect: vi.fn(() => {
      calls.connect += 1;
      client.isOpen = true;
      return Promise.resolve(client);
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { name, client: client as any, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  fatal.mockClear();
  __watchdogTestHooks.resetState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('redis watchdog tick', () => {
  it('is a no-op-to-recovery when all pings succeed', async () => {
    const a = makeClient('command', () => 'ok');
    const b = makeClient('pub', () => 'ok');
    const onFatal = vi.fn();

    await runWatchdogTick([a, b], { onFatal });

    expect(a.calls.ping).toBe(1);
    expect(b.calls.ping).toBe(1);
    expect(a.calls.disconnect).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();
    expect(__watchdogTestHooks.getStalledRounds()).toBe(0);
  });

  it('force-reconnects a client whose ping times out', async () => {
    const healthy = makeClient('pub', () => 'ok');
    const dead = makeClient('command', () => 'hang');
    const onFatal = vi.fn();

    const tick = runWatchdogTick([healthy, dead], {
      pingTimeoutMs: 8000,
      onFatal,
    });
    await vi.advanceTimersByTimeAsync(8000);
    await tick;

    expect(dead.calls.disconnect).toBe(1);
    expect(dead.calls.connect).toBe(1);
    expect(healthy.calls.disconnect).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();
    expect(__watchdogTestHooks.getStalledRounds()).toBe(1);
  });

  it('does not reconnect when the watchdog is stopped while a tick is in flight', async () => {
    const dead = makeClient('command', () => 'hang');
    const onFatal = vi.fn();

    const tick = runWatchdogTick([dead], {
      pingTimeoutMs: 8000,
      onFatal,
    });
    await Promise.resolve();
    await closeRedisClients();
    await vi.advanceTimersByTimeAsync(8000);
    await tick;

    expect(dead.calls.ping).toBe(1);
    expect(dead.calls.disconnect).toBe(0);
    expect(dead.calls.connect).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('resets the stall counter once a client recovers', async () => {
    let mode: PingBehaviour = 'reject';
    const flaky = makeClient('command', () => mode);
    const onFatal = vi.fn();

    await runWatchdogTick([flaky], { onFatal });
    expect(__watchdogTestHooks.getStalledRounds()).toBe(1);

    mode = 'ok';
    await runWatchdogTick([flaky], { onFatal });
    expect(__watchdogTestHooks.getStalledRounds()).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('escalates to fatal exit after the configured consecutive stalls', async () => {
    const dead = makeClient('command', () => 'reject');
    const onFatal = vi.fn();

    await runWatchdogTick([dead], { maxStalledRounds: 2, onFatal });
    expect(onFatal).not.toHaveBeenCalled();
    expect(dead.calls.connect).toBe(1); // first stall attempts a reconnect

    await runWatchdogTick([dead], { maxStalledRounds: 2, onFatal });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(dead.calls.connect).toBe(1); // second stall exits instead of reconnecting
  });

  it('does not run overlapping ticks', async () => {
    const dead = makeClient('command', () => 'hang');
    const onFatal = vi.fn();

    const first = runWatchdogTick([dead], { pingTimeoutMs: 8000, onFatal });
    await runWatchdogTick([dead], { pingTimeoutMs: 8000, onFatal });

    expect(dead.calls.ping).toBe(1);

    await vi.advanceTimersByTimeAsync(8000);
    await first;
  });
});
