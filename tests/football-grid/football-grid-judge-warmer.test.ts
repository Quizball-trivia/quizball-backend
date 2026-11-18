import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createFootballGridJudgeWarmer } from '../../src/modules/football-grid/football-grid-judge.service.js';

const quiet = { info: vi.fn(), warn: vi.fn() };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('Football Grid judge warmer', () => {
  it('loads the active version once, and again only when another version is activated', async () => {
    let active: string | null = 'version-a';
    const warmVersion = vi.fn(async () => {});
    const warmer = createFootballGridJudgeWarmer({ getActiveVersion: async () => active, warmVersion, log: quiet });
    await warmer.check();
    await warmer.check();
    expect(warmVersion).toHaveBeenCalledTimes(1);
    expect(warmer.warmedVersion()).toBe('version-a');
    active = 'version-b';
    await warmer.check();
    expect(warmVersion).toHaveBeenLastCalledWith('version-b');
    expect(warmVersion).toHaveBeenCalledTimes(2);
    active = null;
    await warmer.check();
    expect(warmVersion).toHaveBeenCalledTimes(2);
  });

  it('warms the active version again after older pinned versions evicted it from the cache', async () => {
    let loaded = true;
    const warmVersion = vi.fn(async () => { loaded = true; });
    const warmer = createFootballGridJudgeWarmer({ getActiveVersion: async () => 'version-a', warmVersion, isLoaded: () => loaded, log: quiet });
    await warmer.check();
    expect(warmVersion).toHaveBeenCalledTimes(1);
    await warmer.check();
    expect(warmVersion).toHaveBeenCalledTimes(1);
    loaded = false;                       // evicted by answers on two older versions
    await warmer.check();
    expect(warmVersion).toHaveBeenCalledTimes(2);
  });

  it('never throws: a failed load is logged and tried again on the next check', async () => {
    const warn = vi.fn();
    const warmVersion = vi.fn().mockRejectedValueOnce(new Error('pooler busy')).mockResolvedValue(undefined);
    const warmer = createFootballGridJudgeWarmer({ getActiveVersion: async () => 'version-a', warmVersion, log: { info: vi.fn(), warn } });
    await expect(warmer.check()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warmer.warmedVersion()).toBeNull();
    await warmer.check();
    expect(warmer.warmedVersion()).toBe('version-a');
    const failingRead = createFootballGridJudgeWarmer({ getActiveVersion: async () => { throw new Error('db down'); }, warmVersion, log: quiet });
    await expect(failingRead.check()).resolves.toBeUndefined();
  });

  it('shares one load between overlapping checks, and start() never waits for it', async () => {
    const gate = deferred();
    const warmVersion = vi.fn(() => gate.promise);
    const warmer = createFootballGridJudgeWarmer({ getActiveVersion: async () => 'version-a', warmVersion, log: quiet, intervalMs: 60_000 });
    warmer.start();                       // returns at once: start-up and health checks never wait on the load
    const first = warmer.check();
    const second = warmer.check();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(warmVersion).toHaveBeenCalledTimes(1));
    expect(warmer.warmedVersion()).toBeNull();
    gate.resolve();
    await first;
    expect(warmer.warmedVersion()).toBe('version-a');
    warmer.stop();
  });
});
