import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadAllowedRedirectDomains(nodeEnv: 'local' | 'staging' | 'prod', corsOrigins: string): Promise<string[]> {
  vi.resetModules();
  process.env.NODE_ENV = nodeEnv;
  process.env.CORS_ORIGINS = corsOrigins;
  process.env.DOCS_ENABLED = 'false';
  // The config boot guard requires this outside the local env (see
  // src/core/config.ts); tests/core/config.guard.test.ts covers the guard
  // itself, here we just need config parsing to succeed.
  process.env.SUPABASE_SMS_HOOK_SECRET = 'test-sms-hook-secret';

  const { ALLOWED_REDIRECT_DOMAINS } = await import('../../src/core/constants.js');
  return ALLOWED_REDIRECT_DOMAINS;
}

describe('ALLOWED_REDIRECT_DOMAINS', () => {
  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('allows staging redirect hosts configured through CORS_ORIGINS', async () => {
    const domains = await loadAllowedRedirectDomains('staging', 'https://staging.quizball.io');

    expect(domains).toContain('staging.quizball.io');
  });

  it('does not widen production redirects with CORS_ORIGINS', async () => {
    const domains = await loadAllowedRedirectDomains('prod', 'https://staging.quizball.io');

    expect(domains).not.toContain('staging.quizball.io');
    expect(domains).toContain('quizball.io');
  });
});
