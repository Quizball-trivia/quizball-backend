import { describe, expect, it, vi } from 'vitest';
import {
  createSupabaseInviter,
  maskEmail,
  staffInviteMode,
} from '../../src/modules/partners/partner-staff-invites.js';

describe('staff invite mode', () => {
  it('defaults to a stub everywhere but production', () => {
    expect(staffInviteMode({}, 'local')).toBe('stub');
    expect(staffInviteMode({}, 'staging')).toBe('stub');
    expect(staffInviteMode({}, 'prod')).toBe('supabase');
    expect(staffInviteMode({ PARTNER_STAFF_INVITE_MODE: 'supabase' }, 'staging')).toBe('supabase');
  });

  it('refuses a stub on production and an unknown mode', () => {
    expect(() => staffInviteMode({ PARTNER_STAFF_INVITE_MODE: 'stub' }, 'prod')).toThrow(/not allowed in production/);
    expect(() => staffInviteMode({ PARTNER_STAFF_INVITE_MODE: 'email' }, 'local')).toThrow(/must be/);
  });

  it('masks emails in logs', () => {
    expect(maskEmail('nika@freecroco.ge')).toBe('ni***@freecroco.ge');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('nope')).toBe('***');
  });
});

describe('Supabase inviter', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('invites with the secret key as apikey only, and the redirect', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { id: 'auth-1', email: 'x@y.z' }));
    const inviter = createSupabaseInviter({
      baseUrl: 'https://proj.supabase.co/', key: 'sb_secret_abc', redirectTo: 'https://cms.quizball.io/login', fetchImpl,
    });
    expect(await inviter.invite('x@y.z')).toEqual({ authUserId: 'auth-1', invited: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fcms.quizball.io%2Flogin');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', apikey: 'sb_secret_abc' });
    expect(JSON.parse(String(init.body))).toEqual({ email: 'x@y.z' });
  });

  it('sends a legacy service role key as the bearer too', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { id: 'auth-2' }));
    await createSupabaseInviter({ baseUrl: 'https://p.supabase.co', key: 'eyJlegacy', fetchImpl }).invite('a@b.co');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ apikey: 'eyJlegacy', Authorization: 'Bearer eyJlegacy' });
  });

  it('resolves an email Supabase already knows without sending anything', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }))
      .mockResolvedValueOnce(reply(200, { id: 'auth-3', email_confirmed_at: '2026-01-01T00:00:00Z', action_link: 'https://…' }));
    const inviter = createSupabaseInviter({ baseUrl: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl });
    expect(await inviter.invite('old@b.co')).toEqual({ authUserId: 'auth-3', invited: false });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://p.supabase.co/auth/v1/admin/generate_link');
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({ type: 'magiclink', email: 'old@b.co' });
  });

  it('refuses a re-invite of an older unconfirmed account (Supabase answers 200 for those)', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(200, { id: 'auth-5', created_at: old, email_confirmed_at: null }));
    const inviter = createSupabaseInviter({ baseUrl: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl });
    await expect(inviter.invite('pre@b.co')).rejects.toMatchObject({ code: 'staff_not_eligible' });
    const fresh = createSupabaseInviter({
      baseUrl: 'https://p.supabase.co', key: 'sb_secret_k',
      fetchImpl: vi.fn().mockResolvedValueOnce(reply(200, { id: 'auth-6', created_at: new Date().toISOString() })),
    });
    expect(await fresh.invite('new@b.co')).toEqual({ authUserId: 'auth-6', invited: true });
  });

  it('refuses an existing account whose email was never confirmed (it may belong to someone else)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }))
      .mockResolvedValueOnce(reply(200, { id: 'auth-4', email_confirmed_at: null, action_link: 'https://…' }));
    const inviter = createSupabaseInviter({ baseUrl: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl });
    await expect(inviter.invite('new@b.co')).rejects.toMatchObject({ code: 'staff_not_eligible' });
  });

  it('answers invite_failed on any other refusal or a network error', async () => {
    const refused = createSupabaseInviter({
      baseUrl: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl: vi.fn(async () => reply(429, { error_code: 'over_email_send_rate_limit' })),
    });
    await expect(refused.invite('a@b.co')).rejects.toMatchObject({ code: 'invite_failed', status: 502 });
    const offline = createSupabaseInviter({
      baseUrl: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }),
    });
    await expect(offline.invite('a@b.co')).rejects.toMatchObject({ code: 'invite_failed' });
  });
});
