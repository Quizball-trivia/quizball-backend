import { describe, expect, it, vi } from 'vitest';
import { DbWatchdog } from '../../src/db/watchdog.js';

describe('DbWatchdog', () => {
  it('resets the failure counter after a successful probe', async () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const onFatal = vi.fn();
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('closed'))
      .mockResolvedValueOnce(undefined);
    const watchdog = new DbWatchdog({
      probe,
      intervalMs: 10_000,
      timeoutMs: 1_000,
      maxFailures: 3,
      onFailure,
      onRecovery,
      onFatal,
    });

    await watchdog.tick();
    await watchdog.tick();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onRecovery).toHaveBeenCalledWith(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('requests a replica restart after consecutive failures', async () => {
    const onFatal = vi.fn();
    const watchdog = new DbWatchdog({
      probe: async () => { throw new Error('database closed'); },
      intervalMs: 10_000,
      timeoutMs: 1_000,
      maxFailures: 3,
      onFailure: vi.fn(),
      onFatal,
    });

    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();

    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('treats a stuck probe as a failure', async () => {
    vi.useFakeTimers();
    try {
      const onFailure = vi.fn();
      const onFatal = vi.fn();
      const watchdog = new DbWatchdog({
        probe: () => new Promise(() => {}),
        intervalMs: 10_000,
        timeoutMs: 500,
        maxFailures: 1,
        onFailure,
        onFatal,
      });

      const tick = watchdog.tick();
      await vi.advanceTimersByTimeAsync(500);
      await tick;

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
