import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import { storeRoutes } from '../../src/http/routes/store.routes.js';
import '../setup.js';

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    listProducts: vi.fn(),
    createCheckoutSession: vi.fn(),
    getWallet: vi.fn(),
    getInventory: vi.fn(),
    applyDevSelfGrant: vi.fn(),
    applyManualAdjustment: vi.fn(),
    listTransactions: vi.fn(),
    logWebhookReceived: vi.fn(),
    logWebhookSignatureInvalid: vi.fn(),
    fulfillCheckout: vi.fn(),
  },
}));

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'test-user-id', role: 'admin' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

vi.mock('../../src/http/middleware/require-role.js', () => ({
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => {
    next();
  }),
}));

import { storeService } from '../../src/modules/store/store.service.js';

describe('Store Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/store', storeRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /products returns active product list', async () => {
    (storeService.listProducts as Mock).mockResolvedValue({
      items: [{ id: '11111111-1111-1111-1111-111111111111', slug: 'coin_pack_100' }],
    });

    const response = await request(app).get('/api/v1/store/products');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(storeService.listProducts).toHaveBeenCalledTimes(1);
  });

  it('POST /checkout validates body', async () => {
    const response = await request(app)
      .post('/api/v1/store/checkout')
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /checkout creates checkout url', async () => {
    (storeService.createCheckoutSession as Mock).mockResolvedValue({
      url: 'https://checkout.stripe.com/pay/cs_test_123',
    });

    const response = await request(app)
      .post('/api/v1/store/checkout')
      .send({ productSlug: 'coin_pack_550' });

    expect(response.status).toBe(200);
    expect(response.body.url).toContain('checkout.stripe.com');
    expect(storeService.createCheckoutSession).toHaveBeenCalledWith(
      'test-user-id',
      'coin_pack_550'
    );
  });

  it('POST /admin/adjustments applies adjustment', async () => {
    (storeService.applyManualAdjustment as Mock).mockResolvedValue({
      applied: true,
      wallet: { coins: 100, tickets: 3 },
      inventoryApplied: [],
    });

    const response = await request(app)
      .post('/api/v1/store/admin/adjustments')
      .send({
        userId: '11111111-1111-1111-1111-111111111111',
        coinsDelta: 100,
        reason: 'manual correction',
      });

    expect(response.status).toBe(200);
    expect(response.body.wallet.coins).toBe(100);
  });

  it('POST /dev/grant-self grants wallet funds in local dev', async () => {
    (storeService.applyDevSelfGrant as Mock).mockResolvedValue({
      wallet: { coins: 1000, tickets: 10 },
    });

    const response = await request(app)
      .post('/api/v1/store/dev/grant-self')
      .send({
        coinsDelta: 1000,
        ticketsDelta: 10,
      });

    expect(response.status).toBe(200);
    expect(response.body.wallet).toEqual({ coins: 1000, tickets: 10 });
    expect(storeService.applyDevSelfGrant).toHaveBeenCalledWith('test-user-id', {
      coinsDelta: 1000,
      ticketsDelta: 10,
    });
  });
});
