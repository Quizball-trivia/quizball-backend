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
  it('uses a conservative per-replica connection and queue budget', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.DB_POOL_MAX).toBe(12);
    expect(parsed.DB_INFLIGHT_LIMIT).toBe(12);
    expect(parsed.DB_QUEUE_LIMIT).toBe(12);
    expect(parsed.DB_ACQUIRE_TIMEOUT_MS).toBe(1500);
    expect(parsed.DB_MAX_LIFETIME_SECONDS).toBe(1800);
  });

  it('rejects unsafe or nonsensical database limits', () => {
    expect(() => parseConfig(baseEnv({ DB_POOL_MAX: '0' }))).toThrow(/DB_POOL_MAX/);
    expect(() => parseConfig(baseEnv({ DB_POOL_MAX: '31' }))).toThrow(/DB_POOL_MAX/);
    expect(() => parseConfig(baseEnv({ DB_ACQUIRE_TIMEOUT_MS: '50' }))).toThrow(/DB_ACQUIRE_TIMEOUT_MS/);
  });
});

describe('realtime timer capacity configuration', () => {
  it('defaults to a conservative per-replica worker count', () => {
    expect(parseConfig(baseEnv()).REALTIME_TIMER_HANDLER_CONCURRENCY).toBe(4);
  });

  it('accepts a measured worker count and rejects unsafe values', () => {
    expect(parseConfig(baseEnv({
      REALTIME_TIMER_HANDLER_CONCURRENCY: '12',
    })).REALTIME_TIMER_HANDLER_CONCURRENCY).toBe(12);
    expect(() => parseConfig(baseEnv({
      REALTIME_TIMER_HANDLER_CONCURRENCY: '0',
    }))).toThrow(/REALTIME_TIMER_HANDLER_CONCURRENCY/);
    expect(() => parseConfig(baseEnv({
      REALTIME_TIMER_HANDLER_CONCURRENCY: '31',
    }))).toThrow(/REALTIME_TIMER_HANDLER_CONCURRENCY/);
    expect(() => parseConfig(baseEnv({
      DB_INFLIGHT_LIMIT: '8',
      REALTIME_TIMER_HANDLER_CONCURRENCY: '9',
    }))).toThrow(/REALTIME_TIMER_HANDLER_CONCURRENCY/);
  });
});

describe('Supabase Auth IP forwarding configuration', () => {
  it('is disabled by default and keeps the anon-key path available', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.SUPABASE_AUTH_IP_FORWARDING_ENABLED).toBe(false);
  });

  it('requires a modern server-only Supabase secret key when enabled', () => {
    expect(() => parseConfig(baseEnv({
      SUPABASE_AUTH_IP_FORWARDING_ENABLED: 'true',
    }))).toThrow(/SUPABASE_SECRET_KEY/);

    expect(() => parseConfig(baseEnv({
      SUPABASE_AUTH_IP_FORWARDING_ENABLED: 'true',
      SUPABASE_SECRET_KEY: 'legacy-service-role-key',
    }))).toThrow(/sb_secret_/);
  });

  it('accepts an explicit modern secret key when enabled', () => {
    const parsed = parseConfig(baseEnv({
      SUPABASE_AUTH_IP_FORWARDING_ENABLED: 'true',
      SUPABASE_SECRET_KEY: 'sb_secret_test-only',
    }));
    expect(parsed.SUPABASE_AUTH_IP_FORWARDING_ENABLED).toBe(true);
  });
});
