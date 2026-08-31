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

describe('campaign quiz media environment configuration', () => {
  const hostedEnv = {
    NODE_ENV: 'staging',
    DOCS_ENABLED: 'false',
    SUPABASE_SMS_HOOK_SECRET: 'test-hook-secret',
  } as const;

  it('accepts a media base on the active Supabase project', () => {
    expect(() => parseConfig(baseEnv({
      ...hostedEnv,
      SUPABASE_URL: 'https://staging-project.supabase.co',
      CAMPAIGN_QUIZ_ASSET_BASE_URL: 'https://staging-project.supabase.co',
    }))).not.toThrow();
  });

  it('treats blank optional URLs as unset and keeps the preview default', () => {
    const parsed = parseConfig(baseEnv({
      CAMPAIGN_QUIZ_ASSET_BASE_URL: '',
      CAMPAIGN_QUIZ_PREVIEW_BASE_URL: '',
      PUBLIC_SITE_ORIGIN: '',
    }));
    expect(parsed.CAMPAIGN_QUIZ_ASSET_BASE_URL).toBeUndefined();
    expect(parsed.CAMPAIGN_QUIZ_PREVIEW_BASE_URL).toBe('https://staging.quizball.io');
    expect(parsed.PUBLIC_SITE_ORIGIN).toBe('https://quizball.io');
  });

  it('rejects a media base from another environment', () => {
    expect(() => parseConfig(baseEnv({
      ...hostedEnv,
      SUPABASE_URL: 'https://staging-project.supabase.co',
      CAMPAIGN_QUIZ_ASSET_BASE_URL: 'https://production-project.supabase.co',
    }))).toThrow(/this environment's Supabase project/);
  });
});

describe('campaign quiz artwork generation configuration', () => {
  it('defaults to the current square-image model and high quality', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.OPENAI_IMAGE_MODEL).toBe('gpt-image-2');
    expect(parsed.OPENAI_IMAGE_QUALITY).toBe('high');
  });

  it('treats a blank server key as unconfigured and rejects unsupported quality values', () => {
    expect(parseConfig(baseEnv({ OPENAI_API_KEY: '' })).OPENAI_API_KEY).toBeUndefined();
    expect(() => parseConfig(baseEnv({ OPENAI_IMAGE_QUALITY: 'ultra' }))).toThrow(/OPENAI_IMAGE_QUALITY/);
  });
});

describe('Google Search Console configuration', () => {
  it('requires all service-account values together', () => {
    expect(() => parseConfig(baseEnv({
      GOOGLE_SEARCH_CONSOLE_SITE_URL: 'sc-domain:quizball.io',
    }))).toThrow(/must be configured together/);
  });

  it('accepts a complete service-account configuration', () => {
    expect(() => parseConfig(baseEnv({
      GOOGLE_SEARCH_CONSOLE_SITE_URL: 'sc-domain:quizball.io',
      GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT_EMAIL: 'seo@quizball.iam.gserviceaccount.com',
      GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n',
    }))).not.toThrow();
  });
});

describe('retention email experiment configuration', () => {
  it('is disabled by default with the agreed inactivity, frequency, and deadline windows', () => {
    const parsed = parseConfig(baseEnv());
    expect(parsed.RETENTION_EMAIL_EXPERIMENT_ENABLED).toBe(false);
    expect(parsed.RETENTION_EMAIL_MIN_INACTIVE_DAYS).toBe(3);
    expect(parsed.RETENTION_EMAIL_MAX_INACTIVE_DAYS).toBe(7);
    expect(parsed.RETENTION_EMAIL_FREQUENCY_DAYS).toBe(7);
    expect(parsed.RETENTION_EMAIL_MIN_LEAD_HOURS).toBe(18);
    expect(parsed.RETENTION_EMAIL_MAX_LEAD_HOURS).toBe(24);
    expect(parsed.RETENTION_EMAIL_ASSIGNMENT_CAP).toBe(0);
    expect(parsed.RETENTION_EMAIL_USER_ID_ALLOWLIST).toEqual([]);
    expect(parsed.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED).toBe(false);
    expect(parsed.DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS).toBe(14);
    expect(parsed.DORMANT_COMEBACK_EMAIL_MAX_INACTIVE_DAYS).toBe(90);
    expect(parsed.DORMANT_COMEBACK_EMAIL_MIN_LIFETIME_MATCHES).toBe(3);
    expect(parsed.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP).toBe(0);
    expect(parsed.DORMANT_COMEBACK_EMAIL_USER_ID_ALLOWLIST).toEqual([]);
  });

  it('rejects inverted inactivity and send windows', () => {
    expect(() => parseConfig(baseEnv({
      RETENTION_EMAIL_MIN_INACTIVE_DAYS: '7',
      RETENTION_EMAIL_MAX_INACTIVE_DAYS: '3',
    }))).toThrow(/RETENTION_EMAIL_MIN_INACTIVE_DAYS/);
    expect(() => parseConfig(baseEnv({
      RETENTION_EMAIL_MIN_LEAD_HOURS: '24',
      RETENTION_EMAIL_MAX_LEAD_HOURS: '18',
    }))).toThrow(/RETENTION_EMAIL_MIN_LEAD_HOURS/);
    expect(() => parseConfig(baseEnv({
      DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS: '90',
      DORMANT_COMEBACK_EMAIL_MAX_INACTIVE_DAYS: '14',
    }))).toThrow(/DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS/);
  });

  it('allows a Weekend League email lead window up to seven days', () => {
    const parsed = parseConfig(baseEnv({
      RETENTION_EMAIL_MIN_LEAD_HOURS: '18',
      RETENTION_EMAIL_MAX_LEAD_HOURS: '120',
    }));

    expect(parsed.RETENTION_EMAIL_MAX_LEAD_HOURS).toBe(120);
  });

  it('accepts a bounded rollout cap and UUID allowlist', () => {
    const parsed = parseConfig(baseEnv({
      RETENTION_EMAIL_ASSIGNMENT_CAP: '20',
      DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP: '200',
      RETENTION_EMAIL_USER_ID_ALLOWLIST: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ].join(','),
    }));
    expect(parsed.RETENTION_EMAIL_ASSIGNMENT_CAP).toBe(20);
    expect(parsed.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP).toBe(200);
    expect(parsed.RETENTION_EMAIL_USER_ID_ALLOWLIST).toHaveLength(2);
  });

  it('rejects malformed canary user IDs and excessive rollout caps', () => {
    expect(() => parseConfig(baseEnv({
      RETENTION_EMAIL_USER_ID_ALLOWLIST: 'not-a-user-id',
    }))).toThrow(/RETENTION_EMAIL_USER_ID_ALLOWLIST/);
    expect(() => parseConfig(baseEnv({
      RETENTION_EMAIL_ASSIGNMENT_CAP: '10001',
    }))).toThrow(/RETENTION_EMAIL_ASSIGNMENT_CAP/);
  });
});
