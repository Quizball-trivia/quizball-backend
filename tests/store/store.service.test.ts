import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppError, ExternalServiceError } from '../../src/core/errors.js';
import { config } from '../../src/core/config.js';
import '../setup.js';

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    listActiveProducts: vi.fn(),
    getProductBySlug: vi.fn(),
    getProductBySlugInTx: vi.fn(),
    getProductById: vi.fn(),
    getProductByIdInTx: vi.fn(),
    createPurchase: vi.fn(),
    updatePurchaseStripeCheckoutId: vi.fn(),
    markPurchaseFailed: vi.fn(),
    getPurchaseByStripeCheckoutId: vi.fn(),
    getPurchaseByStripeCheckoutIdInTx: vi.fn(),
    markPurchaseCompletedInTx: vi.fn(),
    getWallet: vi.fn(),
    getWalletForUpdateInTx: vi.fn(),
    adjustWalletInTx: vi.fn(),
    addCoinsInTx: vi.fn(),
    addTicketsInTx: vi.fn(),
    setTicketsStateInTx: vi.fn(),
    setWalletStateInTx: vi.fn(),
    upsertInventoryInTx: vi.fn(),
    listInventoryWithProducts: vi.fn(),
    insertTransactionLog: vi.fn(),
    insertTransactionLogInTx: vi.fn(),
    findManualAdjustmentSuccessByIdempotencyKey: vi.fn(),
    listTransactionLogs: vi.fn(),
  },
}));

vi.mock('../../src/modules/store/stripe.js', () => ({
  stripe: {
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
  },
}));

import { storeRepo } from '../../src/modules/store/store.repo.js';
import { stripe } from '../../src/modules/store/stripe.js';
import { storeService } from '../../src/modules/store/store.service.js';

describe('storeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.STRIPE_SUCCESS_URL = 'http://localhost:3000/store?purchase=success';
    config.STRIPE_CANCEL_URL = 'http://localhost:3000/store?purchase=cancelled';
  });

  it('createCheckoutSession logs successful checkout creation', async () => {
    (storeRepo.getProductBySlug as Mock).mockResolvedValue({
      id: 'prod-1',
      slug: 'coin_pack_100',
      type: 'coin_pack',
      name: { en: '100 Coins' },
      description: { en: 'Coins' },
      price_cents: 99,
      currency: 'usd',
      metadata: { coins: 100 },
      is_active: true,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    (storeRepo.createPurchase as Mock).mockResolvedValue({
      id: 'purchase-1',
      user_id: 'user-1',
      product_id: 'prod-1',
    });
    (stripe!.checkout.sessions.create as Mock).mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    (storeRepo.insertTransactionLog as Mock).mockResolvedValue({ id: 'log-1' });

    const result = await storeService.createCheckoutSession('user-1', 'coin_pack_100');

    expect(result.url).toContain('checkout.stripe.com');
    expect(storeRepo.updatePurchaseStripeCheckoutId).toHaveBeenCalledWith('purchase-1', 'cs_test_123');
    expect(storeRepo.insertTransactionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'checkout_session_created',
        outcome: 'success',
        purchaseId: 'purchase-1',
      })
    );
  });

  it('createCheckoutSession marks purchase failed and logs when Stripe create fails', async () => {
    (storeRepo.getProductBySlug as Mock).mockResolvedValue({
      id: 'prod-1',
      slug: 'coin_pack_100',
      type: 'coin_pack',
      name: { en: '100 Coins' },
      description: { en: 'Coins' },
      price_cents: 99,
      currency: 'usd',
      metadata: { coins: 100 },
      is_active: true,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    (storeRepo.createPurchase as Mock).mockResolvedValue({
      id: 'purchase-1',
      user_id: 'user-1',
      product_id: 'prod-1',
    });
    (stripe!.checkout.sessions.create as Mock).mockRejectedValue(new Error('Stripe unavailable'));
    (storeRepo.insertTransactionLog as Mock).mockResolvedValue({ id: 'log-1' });

    await expect(storeService.createCheckoutSession('user-1', 'coin_pack_100'))
      .rejects
      .toBeInstanceOf(ExternalServiceError);

    expect(storeRepo.markPurchaseFailed).toHaveBeenCalledWith('purchase-1');
    expect(storeRepo.insertTransactionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'checkout_session_failed',
        outcome: 'failure',
      })
    );
  });

  it('createCheckoutSession allows ticket packs through Stripe checkout when user has space', async () => {
    (storeRepo.getProductBySlug as Mock).mockResolvedValue({
      id: 'prod-ticket-1',
      slug: 'ticket_pack_3',
      type: 'ticket_pack',
      name: { en: '3 Arena Tickets' },
      description: { en: 'Tickets' },
      price_cents: 199,
      currency: 'usd',
      metadata: { tickets: 3 },
      is_active: true,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    (storeRepo.getWallet as Mock).mockResolvedValue({
      coins: 100,
      tickets: 6,
      tickets_refill_started_at: null,
    });
    (storeRepo.createPurchase as Mock).mockResolvedValue({
      id: 'purchase-ticket-1',
      user_id: 'user-1',
      product_id: 'prod-ticket-1',
    });
    (stripe!.checkout.sessions.create as Mock).mockResolvedValue({
      id: 'cs_test_ticket',
      url: 'https://checkout.stripe.com/c/pay/cs_test_ticket',
    });
    (storeRepo.insertTransactionLog as Mock).mockResolvedValue({ id: 'log-1' });

    const result = await storeService.createCheckoutSession('user-1', 'ticket_pack_3');

    expect(result.url).toContain('checkout.stripe.com');
    expect(storeRepo.createPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        productId: 'prod-ticket-1',
      })
    );
  });

  it('createCheckoutSession rejects ticket packs that would overflow the ticket cap', async () => {
    (storeRepo.getProductBySlug as Mock).mockResolvedValue({
      id: 'prod-ticket-1',
      slug: 'ticket_pack_3',
      type: 'ticket_pack',
      name: { en: '3 Arena Tickets' },
      description: { en: 'Tickets' },
      price_cents: 199,
      currency: 'usd',
      metadata: { tickets: 3 },
      is_active: true,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    (storeRepo.getWallet as Mock).mockResolvedValue({
      coins: 100,
      tickets: 9,
      tickets_refill_started_at: null,
    });
    (storeRepo.insertTransactionLog as Mock).mockResolvedValue({ id: 'log-1' });

    await expect(
      storeService.createCheckoutSession('user-1', 'ticket_pack_3')
    ).rejects.toMatchObject<AppError>({
      code: 'TICKETS_FULL',
    });

    expect(stripe!.checkout.sessions.create).not.toHaveBeenCalled();
    expect(storeRepo.createPurchase).not.toHaveBeenCalled();
  });

  it('applyManualAdjustment returns existing successful idempotent result', async () => {
    (storeRepo.findManualAdjustmentSuccessByIdempotencyKey as Mock).mockResolvedValue({
      id: 'log-1',
      metadata: {
        walletAfter: { coins: 120, tickets: 8 },
        inventoryApplied: [{ productSlug: 'chance_card_5050', quantity: 1 }],
      },
    });

    const result = await storeService.applyManualAdjustment('admin-user', {
      userId: '11111111-1111-1111-1111-111111111111',
      reason: 'idempotent retry',
      idempotencyKey: 'manual-adjustment-1',
      coinsDelta: 50,
    });

    expect(result.applied).toBe(false);
    expect(result.wallet).toEqual({ coins: 120, tickets: 8 });
    expect(storeRepo.adjustWalletInTx).not.toHaveBeenCalled();
  });
});
