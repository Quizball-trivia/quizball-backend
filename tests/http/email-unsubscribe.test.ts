import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: query }));
vi.mock('../../src/modules/retention-email/retention-email.service.js', () => ({
  handleRetentionEmailClick: vi.fn(),
  handleRetentionEmailProviderEvent: vi.fn(),
  markRetentionEmailUnsubscribed: vi.fn(),
  verifyRetentionUnsubscribeToken: vi.fn(() => false),
}));

import { emailRoutes } from '../../src/http/routes/email.routes.js';
import { emailUnsubToken } from '../../src/core/email.js';

const userId = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(helmet());
app.use('/api/v1/email', emailRoutes);

describe('marketing unsubscribe confirmation', () => {
  beforeEach(() => query.mockReset());

  it('keeps native form origins while withholding the signed query from referrers', async () => {
    const response = await request(app).get('/api/v1/email/unsubscribe')
      .query({ u: userId, t: emailUnsubToken(userId) });
    expect(response.status).toBe(200);
    expect(response.headers['referrer-policy']).toBe('strict-origin');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.text).toContain('<form method="post">');
    expect(query).not.toHaveBeenCalled(); // Link scanners must not unsubscribe.
  });

  it('rejects invalid tokens without writing an opt-out', async () => {
    const response = await request(app).post('/api/v1/email/unsubscribe')
      .query({ u: userId, t: '0'.repeat(64) });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('confirms both the first opt-out and an idempotent repeat', async () => {
    query.mockResolvedValueOnce([{ user_id: userId }]).mockResolvedValueOnce([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).post('/api/v1/email/unsubscribe')
        .query({ u: userId, t: emailUnsubToken(userId) });
      expect(response.status).toBe(200);
      expect(response.text).toContain("You've been unsubscribed");
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
});
