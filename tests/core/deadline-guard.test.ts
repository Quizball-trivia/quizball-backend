import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeadlineGuard } from '../../src/core/deadline-guard.js';

function hanging() {
  let settle: () => void = () => undefined;
  const promise = new Promise<string>((resolve) => { settle = () => resolve('late'); });
  return { promise, settle };
}

afterEach(() => { vi.useRealTimers(); });

describe('createDeadlineGuard', () => {
  it('two overlapping runs of one key both abandoned: the key stays refused until the older one settles too', async () => {
    vi.useFakeTimers();
    const guard = createDeadlineGuard((key) => new Error(`timeout:${key}`));
    const older = hanging();
    const newer = hanging();
    const start = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    // Both start before either deadline (the keeper and a suggestion refresh asking at once).
    const a = guard.run('room pairs', 1_000, start);
    await vi.advanceTimersByTimeAsync(500);
    const b = guard.run('room pairs', 1_000, start);
    const failedA = expect(a).rejects.toThrow('timeout:room pairs');
    const failedB = expect(b).rejects.toThrow('timeout:room pairs');
    await vi.advanceTimersByTimeAsync(1_000);
    await failedA;
    await failedB;
    // The newer one settles first: the older still holds its connection, so nothing new starts.
    newer.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.stuck('room pairs')).toBe(true);
    await expect(guard.run('room pairs', 1_000, start)).rejects.toThrow('timeout:room pairs');
    expect(start).toHaveBeenCalledTimes(2);
    // Every abandoned run has settled: the key runs again.
    older.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.stuck('room pairs')).toBe(false);
    await expect(guard.run('room pairs', 1_000, async () => 'fresh')).resolves.toBe('fresh');
  });

  it('a run that answers in time passes through and leaves no timer or stuck key', async () => {
    vi.useFakeTimers();
    const guard = createDeadlineGuard((key) => new Error(key));
    await expect(guard.run('k', 1_000, async () => 5)).resolves.toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(guard.stuck('k')).toBe(false);
  });
});
