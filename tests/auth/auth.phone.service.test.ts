import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Webhook } from 'standardwebhooks';

import '../setup.js';
import { config } from '../../src/core/config.js';
import { authController } from '../../src/modules/auth/auth.controller.js';
import { authService, normalizeGeorgianPhone } from '../../src/modules/auth/auth.service.js';

const getOrCreateFromIdentityMock = vi.fn();
const assertPhoneCanBeLinkedMock = vi.fn();
const setVerifiedPhoneNumberMock = vi.fn();
const smsDeliveryUpsertMock = vi.fn();
const verifyPhoneOtpMock = vi.fn();
const updateUserPhoneMock = vi.fn();
const verifyPhoneChangeMock = vi.fn();

vi.mock('../../src/modules/users/index.js', () => ({
  usersService: {
    getOrCreateFromIdentity: (...args: unknown[]) => getOrCreateFromIdentityMock(...args),
    assertPhoneCanBeLinked: (...args: unknown[]) => assertPhoneCanBeLinkedMock(...args),
    setVerifiedPhoneNumber: (...args: unknown[]) => setVerifiedPhoneNumberMock(...args),
  },
}));

vi.mock('../../src/modules/auth/sms-delivery.repo.js', () => ({
  smsDeliveryRepo: {
    upsert: (...args: unknown[]) => smsDeliveryUpsertMock(...args),
  },
}));

vi.mock('../../src/modules/auth/supabase-auth-client.js', () => ({
  getAuthClient: () => ({
    verifyPhoneOtp: (...args: unknown[]) => verifyPhoneOtpMock(...args),
    updateUserPhone: (...args: unknown[]) => updateUserPhoneMock(...args),
    verifyPhoneChange: (...args: unknown[]) => verifyPhoneChangeMock(...args),
  }),
}));

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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.SMSOFFICE_API_KEY = 'sms-key';
    config.SMSOFFICE_SENDER = 'QuizBall';
    config.SMSOFFICE_DRY_RUN = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.SMSOFFICE_API_KEY = original.apiKey;
    config.SMSOFFICE_SENDER = original.sender;
    config.SMSOFFICE_DRY_RUN = original.dryRun;
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
    expect(getOrCreateFromIdentityMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'supabase',
      subject: 'supabase-user-id',
      phoneNumber: '+995577123456',
      phoneVerifiedAt: expect.any(String),
    }));
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
