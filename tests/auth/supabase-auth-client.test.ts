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
});
