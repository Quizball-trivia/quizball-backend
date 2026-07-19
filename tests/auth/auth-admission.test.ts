import { describe, expect, it, vi } from 'vitest';
import {
  AuthAdmissionController,
  AuthOverloadedError,
} from '../../src/modules/auth/auth-admission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AuthAdmissionController', () => {
  it('bounds concurrent upstream Auth operations', async () => {
    const gate = new AuthAdmissionController(2, 2, 1_000);
    const first = deferred<void>();
    const second = deferred<void>();
    let thirdStarted = false;

    const a = gate.run(() => first.promise);
    const b = gate.run(() => second.promise);
    const c = gate.run(async () => { thirdStarted = true; });

    await Promise.resolve();
    expect(gate.stats()).toMatchObject({ active: 2, queued: 1 });
    expect(thirdStarted).toBe(false);

    first.resolve();
    await Promise.all([a, c]);
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

  it('returns a retryable 429 when the queue is full', async () => {
    const gate = new AuthAdmissionController(1, 1, 1_000);
    const active = deferred<void>();
    const first = gate.run(() => active.promise);
    const queued = gate.run(async () => 'queued');

    await expect(gate.run(async () => 'rejected')).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      reason: 'queue_full',
      details: { source: 'application_auth_bulkhead', reason: 'queue_full' },
    });
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1, rejections: 1 });

    active.resolve();
    await Promise.all([first, queued]);
  });

  it('expires queued work instead of holding Auth pressure indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const gate = new AuthAdmissionController(1, 1, 250);
      const active = deferred<void>();
      const first = gate.run(() => active.promise);
      const queued = gate.run(async () => 'never');
      const queuedResult = queued.catch((error) => error);

      await vi.advanceTimersByTimeAsync(250);
      await expect(queuedResult).resolves.toBeInstanceOf(AuthOverloadedError);
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
});
