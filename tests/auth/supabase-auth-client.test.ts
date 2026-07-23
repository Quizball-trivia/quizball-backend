import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { SupabaseAuthClient } from '../../src/modules/auth/supabase-auth-client.js';

/**
 * Verifies the signup wiring that makes the localized confirmation email work:
 * the locale must be sent to Supabase as `data: { locale }` (raw_user_meta_data)
 * so the email template can branch on {{ .Data.locale }}, and redirect_to must
 * ride along as a query param. We stub global fetch and inspect the outgoing
 * request rather than hitting Supabase.
 */
describe('SupabaseAuthClient.signUp', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function lastCall(): { url: string; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
    return { url, body: JSON.parse(init.body) };
  }

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: null, refresh_token: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes data.locale in the signup body when a locale is provided', async () => {
    const client = new SupabaseAuthClient();
    await client.signUp('player@quizball.io', 'password123', undefined, 'ka');

    const { body } = lastCall();
    expect(body).toMatchObject({
      email: 'player@quizball.io',
      password: 'password123',
      data: { locale: 'ka' },
    });
  });

  it('omits data entirely when no locale is provided', async () => {
    const client = new SupabaseAuthClient();
    await client.signUp('player@quizball.io', 'password123');

    const { body } = lastCall();
    expect(body).toEqual({ email: 'player@quizball.io', password: 'password123' });
    expect(body).not.toHaveProperty('data');
  });

  it('passes redirect_to as a query param and still carries the locale', async () => {
    const client = new SupabaseAuthClient();
    await client.signUp(
      'player@quizball.io',
      'password123',
      'https://quizball.io/auth/callback',
      'en',
    );

    const { url, body } = lastCall();
    expect(url).toContain('/auth/v1/signup?');
    expect(url).toContain('redirect_to=https%3A%2F%2Fquizball.io%2Fauth%2Fcallback');
    expect(body).toMatchObject({ data: { locale: 'en' } });
  });

  it('puts a deadline on admitted Supabase Auth requests', async () => {
    const client = new SupabaseAuthClient();
    await client.signUp('deadline@quizball.io', 'password123');

    const [, init] = fetchMock.mock.calls.at(-1) as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });
});

describe('SupabaseAuthClient session phone normalization', () => {
  // Regression: OAuth (Google/Facebook) users come back from Supabase with an
  // empty phone string (""). Storing that verbatim collides on the partial
  // unique index `uq_users_phone_number_active` — the first OAuth user inserts
  // "" fine, every later new user 500s on a duplicate-key error. The session
  // must normalize blank phones to null so they never reach the DB.
  let fetchMock: ReturnType<typeof vi.fn>;

  function stubSession(user: Record<string, unknown>) {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'bearer',
        user,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes an empty-string phone to null (OAuth users)', async () => {
    stubSession({ id: 'sub-1', email: 'oauth@quizball.io', phone: '' });
    const client = new SupabaseAuthClient();

    const session = await client.signInWithIdToken('google', 'id-token');

    expect(session.user?.phone).toBeNull();
  });

  it('normalizes a whitespace-only phone to null', async () => {
    stubSession({ id: 'sub-2', email: 'oauth2@quizball.io', phone: '   ' });
    const client = new SupabaseAuthClient();

    const session = await client.signInWithIdToken('facebook', 'id-token');

    expect(session.user?.phone).toBeNull();
  });

  it('preserves a real phone number', async () => {
    stubSession({ id: 'sub-3', email: null, phone: '+995577123456' });
    const client = new SupabaseAuthClient();

    const session = await client.signInWithIdToken('google', 'id-token');

    expect(session.user?.phone).toBe('+995577123456');
  });
});

describe('SupabaseAuthClient.sendPhoneOtp', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not create a Supabase user from the public phone OTP start flow', async () => {
    const client = new SupabaseAuthClient();
    await client.sendPhoneOtp('+995577123456');

    const [, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      phone: '+995577123456',
      create_user: false,
    });
  });
});

describe('SupabaseAuthClient error mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(status: number, payload: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status, json: async () => payload }),
    );
  }

  it('maps a Supabase 429 to our RateLimitError (429), not a 502', async () => {
    stubResponse(429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
    const client = new SupabaseAuthClient();

    await expect(
      client.forgotPassword('player@quizball.io', 'https://quizball.io/auth/reset-password'),
    ).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('maps a Supabase 401 to AuthenticationError (401)', async () => {
    stubResponse(401, { msg: 'invalid token' });
    const client = new SupabaseAuthClient();

    await expect(client.resetPassword('bad-token', 'password123')).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('falls back to ExternalServiceError (502) for unmapped upstream errors', async () => {
    stubResponse(500, { msg: 'boom' });
    const client = new SupabaseAuthClient();

    await expect(client.resetPassword('token', 'password123')).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});
