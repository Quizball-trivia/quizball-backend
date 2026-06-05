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
