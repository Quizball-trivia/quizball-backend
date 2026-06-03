import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';

// A minimal valid base env (mirrors tests/setup.ts). parseConfig is pure over the
// env object it's given, so we can probe guards without mutating process.env.
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

describe('config guard: REGRESSION_DETERMINISTIC', () => {
  it('allows REGRESSION_DETERMINISTIC=1 in local', () => {
    const env = baseEnv({ NODE_ENV: 'local', REGRESSION_DETERMINISTIC: '1' });
    // parseConfig reads process.env for the guard, so set it on the real env too.
    const prev = process.env.REGRESSION_DETERMINISTIC;
    process.env.REGRESSION_DETERMINISTIC = '1';
    try {
      expect(() => parseConfig(env)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_DETERMINISTIC;
      else process.env.REGRESSION_DETERMINISTIC = prev;
    }
  });

  it('throws when REGRESSION_DETERMINISTIC=1 in staging', () => {
    const env = baseEnv({ NODE_ENV: 'staging', REGRESSION_DETERMINISTIC: '1' });
    const prev = process.env.REGRESSION_DETERMINISTIC;
    process.env.REGRESSION_DETERMINISTIC = '1';
    try {
      expect(() => parseConfig(env)).toThrow(/REGRESSION_DETERMINISTIC/);
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_DETERMINISTIC;
      else process.env.REGRESSION_DETERMINISTIC = prev;
    }
  });

  it('throws when REGRESSION_DETERMINISTIC=1 in prod', () => {
    const env = baseEnv({
      NODE_ENV: 'prod',
      REGRESSION_DETERMINISTIC: '1',
      DOCS_ENABLED: 'false',
      SUPABASE_SMS_HOOK_SECRET: 'secret',
    });
    const prev = process.env.REGRESSION_DETERMINISTIC;
    process.env.REGRESSION_DETERMINISTIC = '1';
    try {
      expect(() => parseConfig(env)).toThrow(/REGRESSION_DETERMINISTIC/);
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_DETERMINISTIC;
      else process.env.REGRESSION_DETERMINISTIC = prev;
    }
  });
});
