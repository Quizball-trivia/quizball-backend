import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

import {
  SocketDbTaskLimiter,
  SocketDbTaskOverloadedError,
} from '../../src/realtime/socket-db-task-limiter.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SocketDbTaskLimiter', () => {
  it('bounds active workflows and drains queued cleanup work', async () => {
    const limiter = new SocketDbTaskLimiter(2, 3, 1_000);
    const gates = Array.from({ length: 5 }, deferred);
    const runs = gates.map((gate, index) => limiter.run(async () => {
      await gate.promise;
      return index;
    }));

    await Promise.resolve();
    expect(limiter.stats()).toMatchObject({ active: 2, queued: 3, maxQueued: 3 });

    gates[0]!.resolve();
    await runs[0];
    await Promise.resolve();
    expect(limiter.stats()).toMatchObject({ active: 2, queued: 2, queuedAcquisitions: 1 });

    for (const gate of gates.slice(1)) gate.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(limiter.stats()).toMatchObject({ active: 0, queued: 0, acquisitions: 5 });
  });

  it('rejects overflow and stale queued work without exceeding the limit', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new SocketDbTaskLimiter(1, 1, 100);
      const gate = deferred();
      const active = limiter.run(() => gate.promise);
      const timedOut = limiter.run(async () => undefined);
      const overflow = limiter.run(async () => undefined);

      await expect(overflow).rejects.toMatchObject<Partial<SocketDbTaskOverloadedError>>({
        reason: 'queue_full',
      });
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject<Partial<SocketDbTaskOverloadedError>>({
        reason: 'wait_timeout',
      });
      await vi.advanceTimersByTimeAsync(100);
      await timeoutAssertion;
      expect(limiter.stats()).toMatchObject({ active: 1, queued: 0, rejections: 2, timeouts: 1 });

      gate.resolve();
      await active;
    } finally {
      vi.useRealTimers();
    }
  });
});
