import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: { TD_STATS_DATABASE_URL: undefined as string | undefined },
  redisOpen: false,
  acquireLock: vi.fn(),
  releaseLock: vi.fn(async () => true),
  query: vi.fn(async () => [{ fresh: true }]),
}));
vi.mock('../../src/core/config.js', () => ({ config: h.config }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/db/index.js', () => ({ sql: () => h.query() }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => (h.redisOpen ? { isOpen: true } : null) }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: h.acquireLock,
  releaseLock: h.releaseLock,
  startLockHeartbeat: () => ({ stop: () => undefined }),
}));

const { runTableDerbyStatsSync } = await import('../../src/modules/partner-stats/table-derby-stats.js');

describe('Table Derby stats sync lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.config.TD_STATS_DATABASE_URL = 'postgresql://td_stats_reader:x@127.0.0.1:1/td';
    h.redisOpen = true;
    h.acquireLock.mockResolvedValue({ acquired: true, token: 't' });
  });

  it('is off without TD_STATS_DATABASE_URL', async () => {
    h.config.TD_STATS_DATABASE_URL = undefined;
    expect(await runTableDerbyStatsSync()).toBe('skipped');
    expect(h.acquireLock).not.toHaveBeenCalled();
  });

  it('never runs without Redis (every replica would)', async () => {
    h.redisOpen = false;
    expect(await runTableDerbyStatsSync()).toBe('skipped');
    expect(h.acquireLock).not.toHaveBeenCalled();
  });

  it('leaves the run to the replica holding the lease', async () => {
    h.acquireLock.mockResolvedValue({ acquired: false });
    expect(await runTableDerbyStatsSync()).toBe('skipped');
    expect(h.query).not.toHaveBeenCalled();
  });

  it('skips, and releases the lease, when another replica synced today in the last 25 minutes', async () => {
    expect(await runTableDerbyStatsSync()).toBe('skipped');
    expect(h.acquireLock).toHaveBeenCalledWith('lock:partner_stats:table_derby', 60_000);
    expect(h.releaseLock).toHaveBeenCalledWith('lock:partner_stats:table_derby', 't');
  });

  it('releases the lease when Table Derby is down', async () => {
    h.query.mockResolvedValueOnce([{ fresh: false }]);
    await expect(runTableDerbyStatsSync()).rejects.toThrow();
    expect(h.releaseLock).toHaveBeenCalledWith('lock:partner_stats:table_derby', 't');
  });
});
