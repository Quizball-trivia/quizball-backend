import 'express-async-errors';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express from 'express';
import type Stripe from 'stripe';
import { createStoreWebhookRouter } from '../../src/modules/store/store.webhook.js';
import { storeService } from '../../src/modules/store/store.service.js';
import '../setup.js';

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    listProducts: vi.fn(),
    createCheckoutSession: vi.fn(),
    getWallet: vi.fn(),
    getInventory: vi.fn(),
    applyManualAdjustment: vi.fn(),
    listTransactions: vi.fn(),
    logWebhookReceived: vi.fn(),
    logWebhookSignatureInvalid: vi.fn(),
    fulfillCheckout: vi.fn(),
  },
}));

function createTestApp(stripeClient: Stripe) {
  const app = express();
  app.use(createStoreWebhookRouter(stripeClient));
  return app;
}

describe('Store Webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when signature is missing', async () => {
    const stripeClient = {
      webhooks: { constructEvent: vi.fn() },
    } as unknown as Stripe;

    const app = createTestApp(stripeClient);

    const response = await request(app)
      .post('/api/v1/store/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'checkout.session.completed' });

    expect(response.status).toBe(400);
    expect(storeService.logWebhookSignatureInvalid).toHaveBeenCalledTimes(1);
  });

  it('returns 200 and fulfills checkout session.completed', async () => {
    const constructEvent = vi.fn(() => ({
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          payment_intent: 'pi_123',
        },
      },
    }));

    const stripeClient = {
      webhooks: { constructEvent },
    } as unknown as Stripe;

    (storeService.fulfillCheckout as Mock).mockResolvedValue(undefined);

    const app = createTestApp(stripeClient);

    const response = await request(app)
      .post('/api/v1/store/webhook')
      .set('Stripe-Signature', 'test-signature')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_123' });

    expect(response.status).toBe(200);
    expect(storeService.logWebhookReceived).toHaveBeenCalledTimes(1);
    expect(storeService.fulfillCheckout).toHaveBeenCalledWith('cs_test_123', 'pi_123');
  });

  it('returns 500 when fulfillment fails', async () => {
    const stripeClient = {
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: 'evt_456',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_test_fail', payment_intent: 'pi_fail' } },
        })),
      },
    } as unknown as Stripe;

    (storeService.fulfillCheckout as Mock).mockRejectedValue(new Error('boom'));

    const app = createTestApp(stripeClient);

    const response = await request(app)
      .post('/api/v1/store/webhook')
      .set('Stripe-Signature', 'test-signature')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_456' });

    expect(response.status).toBe(500);
  });
});
