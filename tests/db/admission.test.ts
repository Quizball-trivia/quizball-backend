import { describe, expect, it, vi } from 'vitest';
import { DbAdmissionController, DbOverloadedError } from '../../src/db/admission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DbAdmissionController', () => {
  it('never executes more operations than the configured limit', async () => {
    const gate = new DbAdmissionController(2, 2, 1_000);
    const first = deferred<void>();
    const second = deferred<void>();
    let thirdStarted = false;

    const a = gate.run(() => first.promise);
    const b = gate.run(() => second.promise);
    const c = gate.run(async () => {
      thirdStarted = true;
    });

    await Promise.resolve();
    expect(gate.stats()).toMatchObject({ active: 2, queued: 1 });
    expect(thirdStarted).toBe(false);

    first.resolve();
    await a;
    await c;
    expect(thirdStarted).toBe(true);
    expect(gate.stats()).toMatchObject({
      active: 1,
      queued: 0,
      acquisitions: 3,
      queuedAcquisitions: 1,
    });

    second.resolve();
    await b;
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('rejects immediately when the bounded queue is full', async () => {
    const gate = new DbAdmissionController(1, 1, 1_000);
    const active = deferred<void>();
    const first = gate.run(() => active.promise);
    const queued = gate.run(async () => 'queued');

    await expect(gate.run(async () => 'rejected')).rejects.toMatchObject({
      statusCode: 503,
      code: 'DB_OVERLOADED',
      reason: 'queue_full',
    });
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1, rejections: 1 });

    active.resolve();
    await Promise.all([first, queued]);
  });

  it('times out a queued acquisition instead of waiting indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const gate = new DbAdmissionController(1, 1, 250);
      const active = deferred<void>();
      const first = gate.run(() => active.promise);
      const queuedResult = gate.run(async () => 'never').catch((error) => error);

      await vi.advanceTimersByTimeAsync(250);
      await expect(queuedResult).resolves.toBeInstanceOf(DbOverloadedError);
      expect(gate.stats()).toMatchObject({
        active: 1,
        queued: 0,
        rejections: 1,
        timeouts: 1,
      });

      active.resolve();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a priority watchdog probe before an ordinary backlog', async () => {
    const gate = new DbAdmissionController(1, 1, 1_000);
    const active = deferred<void>();
    const priority = deferred<void>();
    const order: string[] = [];

    const first = gate.run(() => active.promise);
    const ordinary = gate.run(async () => {
      order.push('ordinary');
    });
    const probe = gate.runPriority(async () => {
      order.push('probe');
      await priority.promise;
    });

    await Promise.resolve();
    expect(gate.stats()).toMatchObject({ active: 1, queued: 2 });

    active.resolve();
    await first;
    await vi.waitFor(() => expect(order).toEqual(['probe']));

    priority.resolve();
    await Promise.all([probe, ordinary]);
    expect(order).toEqual(['probe', 'ordinary']);
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});
