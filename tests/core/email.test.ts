import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import {
  emailLinkToken,
  sendEmail,
  sendEmailDetailed,
  verifyEmailLinkToken,
} from '../../src/core/email.js';

describe('email transport and signed campaign links', () => {
  beforeEach(() => {
    vi.stubEnv('EMAIL_UNSUB_SECRET', 's'.repeat(32));
    vi.stubEnv('RESEND_API_KEY', 're_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses purpose-bound constant-time-verifiable campaign link tokens', () => {
    const token = emailLinkToken('retention-click', 'assignment:user:/play');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEmailLinkToken('retention-click', 'assignment:user:/play', token!)).toBe(true);
    expect(verifyEmailLinkToken('retention-unsubscribe', 'assignment:user:/play', token!)).toBe(false);
  });

  it('returns the provider message id while preserving the boolean sender API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'provider-message-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'provider-message-2' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendEmailDetailed({
      to: 'player@example.com',
      subject: 'Come back',
      html: '<p>Play</p>',
      idempotencyKey: 'assignment-1',
    })).resolves.toEqual({ accepted: true, messageId: 'provider-message-1' });
    await expect(sendEmail({
      to: 'player@example.com',
      subject: 'Come back',
      html: '<p>Play</p>',
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.resend.com/emails', expect.objectContaining({
      headers: expect.objectContaining({ 'idempotency-key': 'assignment-1' }),
    }));
  });
});
