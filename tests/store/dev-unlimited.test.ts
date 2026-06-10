import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// The allowlist is parsed once at module load from config.DEV_UNLIMITED_EMAILS,
// so pin it before importing the helper under test.
process.env.DEV_UNLIMITED_EMAILS = 'dev.one@quizball.io, Dev.Two@quizball.io';

const beginMock = vi.fn();
const getProductBySlugInTxMock = vi.fn();
const getWalletForUpdateInTxMock = vi.fn();
const setWalletStateInTxMock = vi.fn();
const getTicketPackPurchaseWindowInTxMock = vi.fn();
const upsertInventoryInTxMock = vi.fn();
const createCompletedPurchaseInTxMock = vi.fn();
const insertTransactionLogInTxMock = vi.fn();
const insertTransactionLogMock = vi.fn();

vi.mock('../../src/db/index.js', () => ({
  sql: {
    begin: (...args: unknown[]) => beginMock(...args),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/store/stripe.js', () => ({ stripe: {} }));

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    getProductBySlugInTx: (...a: unknown[]) => getProductBySlugInTxMock(...a),
    getWalletForUpdateInTx: (...a: unknown[]) => getWalletForUpdateInTxMock(...a),
    setWalletStateInTx: (...a: unknown[]) => setWalletStateInTxMock(...a),
    getTicketPackPurchaseWindowInTx: (...a: unknown[]) => getTicketPackPurchaseWindowInTxMock(...a),
    upsertInventoryInTx: (...a: unknown[]) => upsertInventoryInTxMock(...a),
    createCompletedPurchaseInTx: (...a: unknown[]) => createCompletedPurchaseInTxMock(...a),
    insertTransactionLogInTx: (...a: unknown[]) => insertTransactionLogInTxMock(...a),
    insertTransactionLog: (...a: unknown[]) => insertTransactionLogMock(...a),
  },
}));

const TICKET_PACK = {
  id: 'prod-ticket-1',
  slug: 'ticket_pack_3',
  type: 'ticket_pack',
  name: { en: '3 Tickets' },
  description: { en: 'Tickets' },
  price_cents: 500,
  currency: 'coins',
  metadata: { tickets: 3 },
  is_active: true,
  sort_order: 1,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('storeService.purchaseWithCoins — dev unlimited bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginMock.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }));
    getProductBySlugInTxMock.mockResolvedValue(TICKET_PACK);
    // Already at the cap, no coins, and 3 purchases inside the window — every
    // limit a normal account would hit is tripped here.
    getWalletForUpdateInTxMock.mockResolvedValue({
      coins: 0,
      tickets: 3,
      tickets_refill_started_at: null,
    });
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({
      count: 3,
      oldest_purchased_at: '2026-06-10T00:00:00.000Z',
    });
    setWalletStateInTxMock.mockImplementation(async (_tx, _userId, state) => ({
      coins: state.coins,
      tickets: state.tickets,
      tickets_refill_started_at: state.ticketsRefillStartedAt,
    }));
    createCompletedPurchaseInTxMock.mockResolvedValue({ id: 'purchase-1' });
    insertTransactionLogInTxMock.mockResolvedValue({ id: 'log-1' });
    insertTransactionLogMock.mockResolvedValue({ id: 'log-fail-1' });
  });

  it('bypasses cooldown, ticket cap and coin check for an unlimited account', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');

    const result = await storeService.purchaseWithCoins('user-dev', 'ticket_pack_3', {
      unlimited: true,
    });

    // Tickets exceed MAX_TICKETS (3 + 3 = 6) and coins floor at 0 instead of going negative.
    expect(result.wallet.tickets).toBe(6);
    expect(result.wallet.coins).toBe(0);
    expect(setWalletStateInTxMock).toHaveBeenCalledWith(
      { tx: true },
      'user-dev',
      expect.objectContaining({ coins: 0, tickets: 6 })
    );
  });

  it('still enforces every limit for a normal account', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');

    await expect(
      storeService.purchaseWithCoins('user-normal', 'ticket_pack_3')
    ).rejects.toMatchObject({ code: 'TICKET_PURCHASE_COOLDOWN' });

    expect(setWalletStateInTxMock).not.toHaveBeenCalled();
  });
});

describe('isUnlimitedDevEmail', () => {
  it('matches allowlisted emails case-insensitively and rejects others', async () => {
    const { isUnlimitedDevEmail } = await import('../../src/core/dev-allowlist.js');

    expect(isUnlimitedDevEmail('dev.one@quizball.io')).toBe(true);
    expect(isUnlimitedDevEmail('DEV.ONE@quizball.io')).toBe(true);
    expect(isUnlimitedDevEmail('dev.two@quizball.io')).toBe(true);
    expect(isUnlimitedDevEmail('stranger@quizball.io')).toBe(false);
    expect(isUnlimitedDevEmail(null)).toBe(false);
    expect(isUnlimitedDevEmail(undefined)).toBe(false);
  });
});
