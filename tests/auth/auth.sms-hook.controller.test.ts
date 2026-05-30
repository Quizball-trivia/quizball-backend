import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import '../setup.js';
import { config } from '../../src/core/config.js';
import { parseConfig } from '../../src/core/config.js';

const sendSupabaseSmsHookMock = vi.fn();
const checkSmsOfficeStatusMock = vi.fn();

vi.mock('../../src/modules/auth/supabase-auth-client.js', () => ({
  getAuthClient: () => ({}),
}));

vi.mock('../../src/modules/auth/auth.service.js', () => ({
  authService: {
    sendSupabaseSmsHook: (...args: unknown[]) => sendSupabaseSmsHookMock(...args),
    checkSmsOfficeStatus: (...args: unknown[]) => checkSmsOfficeStatusMock(...args),
  },
}));

function createReq(authorization: string | undefined, body: unknown = {}): Request {
  return {
    headers: {},
    validated: { headers: { authorization }, body, query: { destination: '+995577123456', reference: 'qbref123' } },
  } as unknown as Request;
}

function createRes(): Response {
  return { json: vi.fn(), type: vi.fn(() => ({ send: vi.fn() })), send: vi.fn() } as unknown as Response;
}

describe('SMS hook authorization (timing-safe comparison)', () => {
  const originalSecret = config.SUPABASE_SMS_HOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    // A plain (non-webhook) shared secret exercises the Bearer-compare path.
    config.SUPABASE_SMS_HOOK_SECRET = 'plain-shared-secret';
  });

  afterEach(() => {
    config.SUPABASE_SMS_HOOK_SECRET = originalSecret;
  });

  it('accepts the supabase hook with the correct Bearer secret', async () => {
    const { authController } = await import('../../src/modules/auth/auth.controller.js');
    sendSupabaseSmsHookMock.mockResolvedValue(undefined);

    await authController.supabaseSmsHook(
      createReq('Bearer plain-shared-secret', { user: { phone: '+995577123456' }, sms: { otp: '123456' } }),
      createRes()
    );

    expect(sendSupabaseSmsHookMock).toHaveBeenCalledTimes(1);
  });

  it('rejects the supabase hook when the Bearer secret is wrong (same length)', async () => {
    const { authController } = await import('../../src/modules/auth/auth.controller.js');

    await expect(
      authController.supabaseSmsHook(createReq('Bearer plain-shared-secreX'), createRes())
    ).rejects.toMatchObject({ message: 'Invalid SMS hook authorization' });
    expect(sendSupabaseSmsHookMock).not.toHaveBeenCalled();
  });

  it('rejects the supabase hook when the authorization length differs', async () => {
    const { authController } = await import('../../src/modules/auth/auth.controller.js');

    await expect(
      authController.supabaseSmsHook(createReq('Bearer short'), createRes())
    ).rejects.toMatchObject({ message: 'Invalid SMS hook authorization' });
    expect(sendSupabaseSmsHookMock).not.toHaveBeenCalled();
  });

  it('rejects the status endpoint when the Bearer secret is wrong', async () => {
    const { authController } = await import('../../src/modules/auth/auth.controller.js');

    await expect(
      authController.smsOfficeStatus(createReq('Bearer wrong-secret-value-xx'), createRes())
    ).rejects.toMatchObject({ message: 'Invalid SMSOffice status authorization' });
    expect(checkSmsOfficeStatusMock).not.toHaveBeenCalled();
  });

  it('accepts the status endpoint with the correct Bearer secret', async () => {
    const { authController } = await import('../../src/modules/auth/auth.controller.js');
    checkSmsOfficeStatusMock.mockResolvedValue({ reference: 'qbref123', destination: '995577123456', status: 'Pending', message: 'OK' });

    await authController.smsOfficeStatus(createReq('Bearer plain-shared-secret'), createRes());

    expect(checkSmsOfficeStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe('SUPABASE_SMS_HOOK_SECRET is required outside local', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    CORS_ORIGINS: 'http://localhost:3000',
    PORT: '8000',
    DOCS_ENABLED: 'false',
  };

  it('throws when the secret is missing in staging', () => {
    expect(() => parseConfig({ ...baseEnv, NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrow(
      /SUPABASE_SMS_HOOK_SECRET is required outside local/
    );
  });

  it('throws when the secret is missing in prod', () => {
    expect(() => parseConfig({ ...baseEnv, NODE_ENV: 'prod' } as NodeJS.ProcessEnv)).toThrow(
      /SUPABASE_SMS_HOOK_SECRET is required outside local/
    );
  });

  it('does not throw in local when the secret is missing', () => {
    expect(() => parseConfig({ ...baseEnv, NODE_ENV: 'local' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('does not throw outside local when the secret is provided', () => {
    expect(() =>
      parseConfig({ ...baseEnv, NODE_ENV: 'prod', SUPABASE_SMS_HOOK_SECRET: 'set' } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});
