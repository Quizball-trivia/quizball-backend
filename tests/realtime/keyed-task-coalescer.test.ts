import { describe, expect, it, vi } from 'vitest';
import { KeyedTaskCoalescer } from '../../src/realtime/keyed-task-coalescer.js';

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('room broadcast coalescing', () => {
  it('delivers the latest change after a read already started, without six parallel reads', async () => {
    const coalescer = new KeyedTaskCoalescer(2, 10, 1000);
    const blocked = latch();
    const first = vi.fn(async () => { await blocked.promise; });
    const done = coalescer.run('match', first);
    await Promise.resolve();
    const skipped = Array.from({ length: 5 }, () => vi.fn(async () => {}));
    for (const task of skipped) expect(coalescer.run('match', task)).toBe(done);
    const last = vi.fn(async () => {});
    coalescer.run('match', last);
    blocked.release();
    await done;
    expect(first).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
    for (const task of skipped) expect(task).not.toHaveBeenCalled();
    await coalescer.run('match', last);
    expect(last).toHaveBeenCalledTimes(2);
  });

  it('bounds different matches and folds updates while a match is queued', async () => {
    const coalescer = new KeyedTaskCoalescer(1, 1, 1000);
    const blocked = latch();
    const running = coalescer.run('a', async () => { await blocked.promise; });
    const stale = vi.fn(async () => {});
    const queued = coalescer.run('b', stale);
    const fresh = vi.fn(async () => {});
    expect(coalescer.run('b', fresh)).toBe(queued);
    await expect(coalescer.run('c', async () => {})).rejects.toThrow('queue_full');
    expect(fresh).not.toHaveBeenCalled();
    blocked.release();
    await Promise.all([running, queued]);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
    await expect(coalescer.run('c', async () => {})).resolves.toBeUndefined();
  });

  it('releases a failed match so resync or the next committed update can retry', async () => {
    const coalescer = new KeyedTaskCoalescer(1, 1, 1000);
    await expect(coalescer.run('a', async () => { throw new Error('database unavailable'); })).rejects.toThrow();
    await expect(coalescer.run('a', async () => {})).resolves.toBeUndefined();
  });

  it('P2: a failing read still runs the newer commit that arrived during it', async () => {
    const coalescer = new KeyedTaskCoalescer(1, 10, 1_000);
    let failFirst!: (error: Error) => void;
    const newer = vi.fn(async () => {});
    const first = coalescer.run('m1', () => new Promise<void>((_, reject) => { failFirst = reject; }));
    await Promise.resolve();
    void coalescer.run('m1', newer).catch(() => {});
    failFirst(new Error('read failed'));
    await first.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(newer).toHaveBeenCalledOnce();
  });
});
