import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';

// parseConfig is pure over the env object it's given — no process.env mutation.
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'local',
    PORT: '8000',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_JWT_SECRET: 'x'.repeat(32),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('config guard: REGRESSION_* flags are local-only', () => {
  it('allows REGRESSION_DETERMINISTIC=1 in local', () => {
    expect(() => parseConfig(baseEnv({ NODE_ENV: 'local', REGRESSION_DETERMINISTIC: '1' }))).not.toThrow();
  });

  it('allows REGRESSION_FAST_TIMERS=1 in local', () => {
    expect(() => parseConfig(baseEnv({ NODE_ENV: 'local', REGRESSION_FAST_TIMERS: '1' }))).not.toThrow();
  });

  it('throws when REGRESSION_DETERMINISTIC=1 in staging', () => {
    expect(() => parseConfig(baseEnv({ NODE_ENV: 'staging', REGRESSION_DETERMINISTIC: '1' })))
      .toThrow(/REGRESSION_DETERMINISTIC/);
  });

  it('throws when REGRESSION_FAST_TIMERS=1 in staging', () => {
    expect(() => parseConfig(baseEnv({ NODE_ENV: 'staging', REGRESSION_FAST_TIMERS: '1' })))
      .toThrow(/REGRESSION_FAST_TIMERS/);
  });

  it('throws when a REGRESSION_* flag is set in prod', () => {
    expect(() => parseConfig(baseEnv({
      NODE_ENV: 'prod',
      REGRESSION_DETERMINISTIC: '1',
      DOCS_ENABLED: 'false',
      SUPABASE_SMS_HOOK_SECRET: 'secret',
    }))).toThrow(/REGRESSION_DETERMINISTIC/);
  });

  it('does not throw when no REGRESSION_* flag is set outside local', () => {
    expect(() => parseConfig(baseEnv({
      NODE_ENV: 'prod',
      DOCS_ENABLED: 'false',
      SUPABASE_SMS_HOOK_SECRET: 'secret',
    }))).not.toThrow();
  });
});

describe('database resilience configuration', () => {
  it('uses conservative pool, admission, and watchdog defaults', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.DB_POOL_MAX).toBe(12);
    expect(parsed.DB_INFLIGHT_LIMIT).toBe(12);
    expect(parsed.DB_QUEUE_LIMIT).toBe(12);
    expect(parsed.DB_ACQUIRE_TIMEOUT_MS).toBe(1500);
    expect(parsed.DB_MAX_LIFETIME_SECONDS).toBe(1800);
    expect(parsed.DB_WATCHDOG_ENABLED).toBe(true);
    expect(parsed.DB_WATCHDOG_INTERVAL_MS).toBe(10_000);
    expect(parsed.DB_WATCHDOG_TIMEOUT_MS).toBe(4_000);
    expect(parsed.DB_WATCHDOG_FAILURES).toBe(3);
  });

  it('rejects unsafe or nonsensical database limits', () => {
    expect(() => parseConfig(baseEnv({ DB_POOL_MAX: '0' }))).toThrow(/DB_POOL_MAX/);
    expect(() => parseConfig(baseEnv({ DB_POOL_MAX: '31' }))).toThrow(/DB_POOL_MAX/);
    expect(() => parseConfig(baseEnv({ DB_ACQUIRE_TIMEOUT_MS: '50' })))
      .toThrow(/DB_ACQUIRE_TIMEOUT_MS/);
    expect(() => parseConfig(baseEnv({ DB_WATCHDOG_FAILURES: '0' })))
      .toThrow(/DB_WATCHDOG_FAILURES/);
  });
});

describe('hosted Auth resilience configuration', () => {
  it('uses bounded per-replica defaults', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.AUTH_INFLIGHT_LIMIT).toBe(4);
    expect(parsed.AUTH_QUEUE_LIMIT).toBe(16);
    expect(parsed.AUTH_ACQUIRE_TIMEOUT_MS).toBe(2_000);
    expect(parsed.AUTH_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('rejects invalid Auth limits and deadlines', () => {
    expect(() => parseConfig(baseEnv({ AUTH_INFLIGHT_LIMIT: '0' })))
      .toThrow(/AUTH_INFLIGHT_LIMIT/);
    expect(() => parseConfig(baseEnv({ AUTH_QUEUE_LIMIT: '-1' })))
      .toThrow(/AUTH_QUEUE_LIMIT/);
    expect(() => parseConfig(baseEnv({ AUTH_REQUEST_TIMEOUT_MS: '100' })))
      .toThrow(/AUTH_REQUEST_TIMEOUT_MS/);
  });
});
