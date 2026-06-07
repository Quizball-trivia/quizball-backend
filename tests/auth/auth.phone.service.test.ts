import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Webhook } from 'standardwebhooks';

import '../setup.js';
import { config } from '../../src/core/config.js';
import { authController } from '../../src/modules/auth/auth.controller.js';
import { PendingDeletionSessionError, authService, normalizeGeorgianPhone } from '../../src/modules/auth/auth.service.js';
import { AuthenticationError } from '../../src/core/errors.js';

const getOrCreateFromIdentityMock = vi.fn();
const assertPhoneCanBeLinkedMock = vi.fn();
const getVerifiedByPhoneNumberMock = vi.fn();
const getRestorableVerifiedByPhoneNumberMock = vi.fn();
const setVerifiedPhoneNumberMock = vi.fn();
const restorePendingDeletionFromIdentityMock = vi.fn();
const smsDeliveryUpsertMock = vi.fn();
const signUpMock = vi.fn();
const signInMock = vi.fn();
const signInWithIdTokenMock = vi.fn();
const sendPhoneOtpMock = vi.fn();
const verifyPhoneOtpMock = vi.fn();
const updateUserPhoneMock = vi.fn();
const verifyPhoneChangeMock = vi.fn();
const trackEventMock = vi.fn();

vi.mock('../../src/core/analytics.js', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

vi.mock('../../src/modules/users/index.js', () => ({
  usersService: {
    getOrCreateFromIdentity: (...args: unknown[]) => getOrCreateFromIdentityMock(...args),
    assertPhoneCanBeLinked: (...args: unknown[]) => assertPhoneCanBeLinkedMock(...args),
    getVerifiedByPhoneNumber: (...args: unknown[]) => getVerifiedByPhoneNumberMock(...args),
    getRestorableVerifiedByPhoneNumber: (...args: unknown[]) => getRestorableVerifiedByPhoneNumberMock(...args),
    setVerifiedPhoneNumber: (...args: unknown[]) => setVerifiedPhoneNumberMock(...args),
    restorePendingDeletionFromIdentity: (...args: unknown[]) => restorePendingDeletionFromIdentityMock(...args),
  },
}));

vi.mock('../../src/modules/auth/sms-delivery.repo.js', () => ({
  smsDeliveryRepo: {
    upsert: (...args: unknown[]) => smsDeliveryUpsertMock(...args),
  },
}));

vi.mock('../../src/modules/auth/supabase-auth-client.js', () => ({
  getAuthClient: () => ({
    signUp: (...args: unknown[]) => signUpMock(...args),
    signIn: (...args: unknown[]) => signInMock(...args),
    signInWithIdToken: (...args: unknown[]) => signInWithIdTokenMock(...args),
    sendPhoneOtp: (...args: unknown[]) => sendPhoneOtpMock(...args),
    verifyPhoneOtp: (...args: unknown[]) => verifyPhoneOtpMock(...args),
    updateUserPhone: (...args: unknown[]) => updateUserPhoneMock(...args),
    verifyPhoneChange: (...args: unknown[]) => verifyPhoneChangeMock(...args),
  }),
}));

const MOCK_SESSION = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
  tokenType: 'bearer',
  provider: 'supabase',
  user: {
    email: 'user@example.com',
    phone: null,
    phoneConfirmedAt: null,
    providerSub: 'supabase-user-id',
  },
};

async function flushProvisioningRetries<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(150);
  await vi.advanceTimersByTimeAsync(300);
  return promise;
}

describe('Georgian phone auth helpers', () => {
  it('normalizes Georgian mobile formats to E.164', () => {
    expect(normalizeGeorgianPhone('+995 577 123 456')).toBe('+995577123456');
    expect(normalizeGeorgianPhone('995577123456')).toBe('+995577123456');
    expect(normalizeGeorgianPhone('577123456')).toBe('+995577123456');
  });

  it('rejects non-Georgian or non-mobile numbers', () => {
    expect(() => normalizeGeorgianPhone('+12025550123')).toThrow('Only Georgian mobile numbers');
    expect(() => normalizeGeorgianPhone('+995322123456')).toThrow('Only Georgian mobile numbers');
  });
});

describe('authService SMSOffice delivery', () => {
  const original = {
    apiKey: config.SMSOFFICE_API_KEY,
    sender: config.SMSOFFICE_SENDER,
    dryRun: config.SMSOFFICE_DRY_RUN,
    callbackSecret: config.SMSOFFICE_CALLBACK_SECRET,
  };
  const callbackSecret = 'test-callback-secret';

  beforeEach(() => {
    vi.clearAllMocks();
    config.SMSOFFICE_API_KEY = 'sms-key';
    config.SMSOFFICE_SENDER = 'QuizBall';
    config.SMSOFFICE_DRY_RUN = false;
    config.SMSOFFICE_CALLBACK_SECRET = callbackSecret;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.SMSOFFICE_API_KEY = original.apiKey;
    config.SMSOFFICE_SENDER = original.sender;
    config.SMSOFFICE_DRY_RUN = original.dryRun;
    config.SMSOFFICE_CALLBACK_SECRET = original.callbackSecret;
  });

  it('dry-runs locally without calling SMSOffice', async () => {
    config.SMSOFFICE_API_KEY = undefined;
    config.SMSOFFICE_DRY_RUN = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authService.sendSupabaseSmsHook({
      user: { phone: '+995 577 123 456' },
      sms: { otp: '123456' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      destination: '995577123456',
      status: 'dry_run',
      rawCallback: { dryRun: true },
    }));
  });

  it('uses the pending phone_change value for add/change phone OTP hooks', async () => {
    config.SMSOFFICE_API_KEY = undefined;
    config.SMSOFFICE_DRY_RUN = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authService.sendSupabaseSmsHook({
      user: { phone: null, phone_change: '+995 599 000 111' },
      sms: { otp: '000000' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      destination: '995599000111',
      status: 'dry_run',
    }));
  });

  it('uses the Supabase new_phone value for phone-change OTP hooks', async () => {
    config.SMSOFFICE_API_KEY = undefined;
    config.SMSOFFICE_DRY_RUN = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authService.sendSupabaseSmsHook({
      user: { phone: null, new_phone: '+995 599 000 222' },
      sms: { otp: '000000' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      destination: '995599000222',
      status: 'dry_run',
    }));
  });

  it('sends urgent POST requests with destination, reference, sender, and OTP content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ Success: true, Message: 'OK', ErrorCode: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authService.sendSupabaseSmsHook({
      user: { phone: '+995577123456' },
      sms: { otp: '654321' },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://smsoffice.ge/api/v2/send/', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }));
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get('key')).toBe('sms-key');
    expect(body.get('destination')).toBe('995577123456');
    expect(body.get('sender')).toBe('QuizBall');
    expect(body.get('content')).toBe('QuizBall code: 654321');
    expect(body.get('urgent')).toBe('true');
    expect(body.get('reference')).toMatch(/^qb[a-z0-9]+$/);
    expect(body.get('reference')!.length).toBeLessThanOrEqual(20);
    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      destination: '995577123456',
      status: 'accepted',
      errorCode: 0,
    }));
  });

  it('records provider failures and surfaces them as external service errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ Success: false, Message: 'Balance is insufficient', ErrorCode: 20 }),
    }));

    await expect(authService.sendSupabaseSmsHook({
      user: { phone: '+995577123456' },
      sms: { otp: '654321' },
    })).rejects.toMatchObject({
      statusCode: 502,
      message: 'Balance is insufficient',
    });

    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorCode: 20,
      errorMessage: 'Balance is insufficient',
    }));
  });

  it('records SMSOffice callback status updates', async () => {
    await authService.handleSmsOfficeCallback({
      reference: 'qbref123',
      status: 'Delivered',
      reason: '',
      destination: '995577123456',
      timestamp: '20260528203045',
      operator: '28202',
      secret: callbackSecret,
    });

    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'qbref123',
      destination: '995577123456',
      status: 'Delivered',
      deliveredAt: '2026-05-28T20:30:45.000Z',
      rawCallback: expect.objectContaining({
        operator: '28202',
      }),
    }));
  });

  it('polls SMSOffice status by destination and reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        Success: true,
        Message: 'OK',
        Output: { Status: 'Pending' },
        ErrorCode: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await authService.checkSmsOfficeStatus('+995577123456', 'qbref123');

    expect(fetchMock.mock.calls[0][0]).toContain('https://smsoffice.ge/api/v2/getMessageStatus/?');
    expect(fetchMock.mock.calls[0][0]).toContain('destination=995577123456');
    expect(fetchMock.mock.calls[0][0]).toContain('reference=qbref123');
    expect(result).toEqual({
      reference: 'qbref123',
      destination: '995577123456',
      status: 'Pending',
      message: 'OK',
    });
    expect(smsDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'qbref123',
      destination: '995577123456',
      status: 'Pending',
    }));
  });
});

describe('authService phone verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts OTP only for a verified linked phone number', async () => {
    getRestorableVerifiedByPhoneNumberMock.mockResolvedValue({
      id: 'user-1',
      phone_number: '+995577123456',
      phone_verified_at: '2026-05-29T12:00:00.000Z',
      deletion_requested_at: null,
      pending_deletion_at: null,
    });

    await authService.startGeorgianPhoneOtp('577123456');

    expect(getRestorableVerifiedByPhoneNumberMock).toHaveBeenCalledWith('+995577123456');
    expect(sendPhoneOtpMock).toHaveBeenCalledWith('+995577123456');
  });

  it('returns generic success without sending OTP for an unlinked phone number', async () => {
    getRestorableVerifiedByPhoneNumberMock.mockResolvedValue(null);

    await authService.startGeorgianPhoneOtp('577123456');

    expect(getRestorableVerifiedByPhoneNumberMock).toHaveBeenCalledWith('+995577123456');
    expect(sendPhoneOtpMock).not.toHaveBeenCalled();
  });

  it('provisions the verified phone number after OTP login', async () => {
    verifyPhoneOtpMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      tokenType: 'bearer',
      provider: 'supabase',
      user: {
        email: null,
        phone: null,
        phoneConfirmedAt: null,
        providerSub: 'supabase-user-id',
      },
    });

    await authService.verifyGeorgianPhoneOtp('577123456', '123456');

    expect(verifyPhoneOtpMock).toHaveBeenCalledWith('+995577123456', '123456');
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'supabase',
        subject: 'supabase-user-id',
        phoneNumber: '+995577123456',
        phoneVerifiedAt: expect.any(String),
      }),
      undefined,
      expect.objectContaining({ onUserCreated: expect.any(Function) }),
    );
  });

  it('preserves the verified session when OTP login hits a pending-deletion account', async () => {
    const session = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      tokenType: 'bearer',
      provider: 'supabase',
      user: {
        email: null,
        phone: null,
        phoneConfirmedAt: null,
        providerSub: 'supabase-user-id',
      },
    };
    verifyPhoneOtpMock.mockResolvedValue(session);
    getOrCreateFromIdentityMock.mockRejectedValue(
      new AuthenticationError('Account is scheduled for deletion', { reason: 'pending_deletion' })
    );

    await expect(authService.verifyGeorgianPhoneOtp('577123456', '123456')).rejects.toMatchObject({
      statusCode: 401,
      details: { reason: 'pending_deletion' },
      session: expect.objectContaining({ refreshToken: 'refresh-token' }),
    });
    await expect(authService.verifyGeorgianPhoneOtp('577123456', '123456')).rejects.toBeInstanceOf(
      PendingDeletionSessionError
    );
  });

  it('restores a pending-deletion phone account after a valid OTP when requested', async () => {
    verifyPhoneOtpMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      tokenType: 'bearer',
      provider: 'supabase',
      user: {
        email: null,
        phone: null,
        phoneConfirmedAt: null,
        providerSub: 'supabase-user-id',
      },
    });
    restorePendingDeletionFromIdentityMock.mockResolvedValue({ id: 'user-1' });

    await authService.verifyGeorgianPhoneOtp('577123456', '123456', true);

    expect(verifyPhoneOtpMock).toHaveBeenCalledWith('+995577123456', '123456');
    expect(restorePendingDeletionFromIdentityMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'supabase',
      subject: 'supabase-user-id',
      phoneNumber: '+995577123456',
      phoneVerifiedAt: expect.any(String),
    }));
    expect(getOrCreateFromIdentityMock).not.toHaveBeenCalled();
  });
});

describe('authService strict provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries login provisioning twice, then fails closed as an external service error', async () => {
    signInMock.mockResolvedValue(MOCK_SESSION);
    getOrCreateFromIdentityMock
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'));

    const result = authService.login({ email: 'user@example.com', password: 'secret' });
    const assertion = expect(result).rejects.toMatchObject({
      statusCode: 502,
      details: expect.objectContaining({ reason: 'profile_provisioning_failed' }),
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(3);
  });

  it('returns the social token session when strict provisioning succeeds on retry', async () => {
    signInWithIdTokenMock.mockResolvedValue(MOCK_SESSION);
    getOrCreateFromIdentityMock
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockResolvedValueOnce({ id: 'user-1' });

    const result = authService.socialLoginToken({
      provider: 'google',
      id_token: 'google-token',
    });

    await expect(flushProvisioningRetries(result)).resolves.toEqual(MOCK_SESSION);
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(3);
  });

  it('propagates account-state auth errors without retrying', async () => {
    signInMock.mockResolvedValue(MOCK_SESSION);
    getOrCreateFromIdentityMock.mockRejectedValueOnce(
      new AuthenticationError('Account is no longer active', { reason: 'account_inactive' })
    );

    await expect(authService.login({ email: 'user@example.com', password: 'secret' })).rejects.toMatchObject({
      statusCode: 401,
      details: { reason: 'account_inactive' },
    });
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed for register-with-session provisioning failures', async () => {
    signUpMock.mockResolvedValue(MOCK_SESSION);
    getOrCreateFromIdentityMock
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'));

    const result = authService.register({
      email: 'user@example.com',
      password: 'secret',
      redirect_to: 'https://quizball.io/auth/callback',
    });
    const assertion = expect(result).rejects.toMatchObject({
      statusCode: 502,
      details: expect.objectContaining({ reason: 'profile_provisioning_failed' }),
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(3);
  });

  it('emits account_created (not login_completed) for a brand-new social user', async () => {
    signInWithIdTokenMock.mockResolvedValue({ ...MOCK_SESSION, provider: 'google' });
    // Simulate a first-time login: the service invokes onUserCreated.
    getOrCreateFromIdentityMock.mockImplementationOnce(
      async (_identity: unknown, _country: unknown, opts?: { onUserCreated?: (u: unknown) => void }) => {
        opts?.onUserCreated?.({ id: 'new-user-1' });
        return { id: 'new-user-1' };
      },
    );

    await authService.socialLoginToken({ provider: 'google', id_token: 'google-token' });

    expect(trackEventMock).toHaveBeenCalledWith('account_created', 'new-user-1', {
      method: 'google',
      is_new_user: true,
    });
    expect(trackEventMock).not.toHaveBeenCalledWith('login_completed', expect.anything(), expect.anything());
  });

  it('emits login_completed (not account_created) for a returning social user', async () => {
    signInWithIdTokenMock.mockResolvedValue({ ...MOCK_SESSION, provider: 'facebook' });
    // Returning user: onUserCreated is never called.
    getOrCreateFromIdentityMock.mockResolvedValueOnce({ id: 'existing-user-1' });

    await authService.socialLoginToken({ provider: 'facebook', id_token: 'fb-token' });

    expect(trackEventMock).toHaveBeenCalledWith('login_completed', 'existing-user-1', {
      method: 'facebook',
      is_new_user: false,
    });
    expect(trackEventMock).not.toHaveBeenCalledWith('account_created', expect.anything(), expect.anything());
  });
});

describe('authService refresh account check provisioning tolerance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries non-auth provisioning failures, then tolerates them so rotated refresh tokens can be returned', async () => {
    getOrCreateFromIdentityMock
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'))
      .mockRejectedValueOnce(new Error('pooler timeout'));

    const result = authService.ensureSessionAccountActive(MOCK_SESSION);

    await expect(flushProvisioningRetries(result)).resolves.toBeUndefined();
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(3);
  });

  it('still propagates terminal account-state auth errors on refresh', async () => {
    getOrCreateFromIdentityMock.mockRejectedValueOnce(
      new AuthenticationError('Account is no longer active', { reason: 'account_inactive' })
    );

    await expect(authService.ensureSessionAccountActive(MOCK_SESSION)).rejects.toMatchObject({
      statusCode: 401,
      details: { reason: 'account_inactive' },
    });
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit login_completed on the refresh path (avoids per-refresh spam)', async () => {
    getOrCreateFromIdentityMock.mockResolvedValueOnce({ id: 'existing-user-1' });

    await authService.ensureSessionAccountActive(MOCK_SESSION);

    expect(trackEventMock).not.toHaveBeenCalledWith('login_completed', expect.anything(), expect.anything());
  });
});

describe('authController SMS hook authorization', () => {
  const originalSecret = config.SUPABASE_SMS_HOOK_SECRET;

  afterEach(() => {
    config.SUPABASE_SMS_HOOK_SECRET = originalSecret;
  });

  it('rejects a Supabase SMS hook request with the wrong bearer secret', async () => {
    config.SUPABASE_SMS_HOOK_SECRET = 'expected-secret';
    const req = {
      validated: {
        headers: { authorization: 'Bearer wrong-secret' },
        body: {
          user: { phone: '+995577123456' },
          sms: { otp: '123456' },
        },
      },
    } as unknown as Request;
    const res = { json: vi.fn() } as unknown as Response;

    await expect(authController.supabaseSmsHook(req, res)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid SMS hook authorization',
    });
  });

  it('accepts a Supabase signed webhook secret generated by the dashboard', async () => {
    const body = {
      user: { phone: '+995577123456' },
      sms: { otp: '123456' },
    };
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await new Webhook('testsecret').sign('msg_test', new Date(), rawBody);

    config.SUPABASE_SMS_HOOK_SECRET = 'v1,whsec_testsecret';
    const sendSpy = vi.spyOn(authService, 'sendSupabaseSmsHook').mockResolvedValueOnce(undefined);
    const req = {
      rawBody,
      headers: {
        'webhook-id': 'msg_test',
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      },
      validated: {
        headers: {},
        body,
      },
    } as unknown as Request;
    const res = { json: vi.fn() } as unknown as Response;

    await authController.supabaseSmsHook(req, res);

    expect(sendSpy).toHaveBeenCalledWith(body);
    expect(res.json).toHaveBeenCalledWith({ message: 'SMS sent' });
  });
});
