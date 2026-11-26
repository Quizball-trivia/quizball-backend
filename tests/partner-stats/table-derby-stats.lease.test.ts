import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: {
    NODE_ENV: 'local',
    TD_STATS_DATABASE_URL: undefined as string | undefined,
    TD_STATS_DATABASE_CA: undefined as string | undefined,
  },
  redisOpen: false,
  acquireLock: vi.fn(),
  releaseLock: vi.fn(async () => true),
  query: vi.fn(async () => [{ fresh: true }]),
  warn: vi.fn(),
}));
vi.mock('../../src/core/config.js', () => ({ config: h.config }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: h.warn } }));
vi.mock('../../src/db/index.js', () => ({ sql: () => h.query() }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => (h.redisOpen ? { isOpen: true } : null) }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: h.acquireLock,
  releaseLock: h.releaseLock,
  startLockHeartbeat: () => ({ stop: () => undefined }),
}));

const { runTableDerbyStatsSync, startTableDerbyStatsSync, stopTableDerbyStatsSync, parseTableDerbyTarget, createTableDerbyClient } =
  await import('../../src/modules/partner-stats/table-derby-stats.js');

const SECRET = 's3cr3t-Passw0rd';
const POOLER = `postgresql://td_stats_reader.abcdefghijklmnopqrst:${SECRET}@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`;

describe('Table Derby stats sync lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.config.NODE_ENV = 'local';
    h.config.TD_STATS_DATABASE_URL = 'postgresql://td_stats_reader:x@127.0.0.1:1/td';
    h.config.TD_STATS_DATABASE_CA = undefined;
    h.redisOpen = true;
    h.acquireLock.mockResolvedValue({ acquired: true, token: 't' });
    h.query.mockResolvedValue([{ fresh: true }]);
  });
  afterEach(async () => {
    await stopTableDerbyStatsSync();
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

  it('releases the lease when Table Derby is down, after the run has settled', async () => {
    h.query.mockResolvedValueOnce([{ fresh: false }]);
    await expect(runTableDerbyStatsSync()).rejects.toMatchObject({ stage: 'read', code: 'ECONNREFUSED' });
    expect(h.releaseLock).toHaveBeenCalledWith('lock:partner_stats:table_derby', 't');
  });
});

describe('Table Derby connection target', () => {
  it('accepts the pooler as td_stats_reader of a project', () => {
    expect(parseTableDerbyTarget(POOLER, false)).toMatchObject({
      host: 'aws-1-eu-central-1.pooler.supabase.com', port: 6543, database: 'postgres', local: false,
    });
  });

  it.each([
    ['an owner login', POOLER.replace('td_stats_reader.', 'postgres.'), 'url_user'],
    ['the direct host', POOLER.replace('aws-1-eu-central-1.pooler.supabase.com:6543', 'db.abcdefghijklmnopqrst.supabase.co:5432'), 'url_host'],
    ['the session port', POOLER.replace(':6543', ':5432'), 'url_port'],
    ['a local database outside local runs', 'postgresql://td_stats_reader:x@127.0.0.1:5439/td', 'url_local_host'],
    ['a malformed URL', `postgresql://td_stats_reader:${SECRET}@aws-1-eu-central-1.pooler.supabase.com:65536:1/x y`, 'url_malformed'],
  ])('refuses %s, without echoing the URL', (_name, raw, code) => {
    let error: unknown;
    try {
      parseTableDerbyTarget(raw, false);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ stage: 'config', code });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(Object.keys(error as object)).not.toContain('input');
  });

  it('verifies the pooler certificate against the configured CA, and needs one', () => {
    const target = parseTableDerbyTarget(POOLER, false);
    expect(() => createTableDerbyClient(target, undefined)).toThrow(/ca_missing/);
    const pem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    const client = createTableDerbyClient(target, pem);
    expect(client.options.ssl).toEqual({ ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', rejectUnauthorized: true });
    void client.end({ timeout: 0 });
  });

  it('does not start, and logs only a code, when the URL is not allowed', () => {
    h.config.NODE_ENV = 'prod';
    h.config.TD_STATS_DATABASE_URL = POOLER.replace('td_stats_reader.', 'postgres.');
    startTableDerbyStatsSync();
    expect(h.warn).toHaveBeenCalledWith({ operation: 'config', code: 'url_user' }, expect.any(String));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain(SECRET);
  });

  it('does not start without the CA outside local runs', () => {
    h.config.NODE_ENV = 'prod';
    h.config.TD_STATS_DATABASE_URL = POOLER;
    h.config.TD_STATS_DATABASE_CA = undefined;
    startTableDerbyStatsSync();
    expect(h.warn).toHaveBeenCalledWith({ operation: 'config', code: 'ca_missing' }, expect.any(String));
  });
});
