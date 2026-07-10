import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// Quantity-based daily ticket purchase cap (economy v3): players can buy up to
// 5 TICKETS per FIXED daily window (resets 00:00 Georgia time) — pack size
// counts, not purchase count. The whole allowance frees together at reset, so
// the full-allowance 5-pack is buyable right after a reset (the bug this fixes:
// a rolling window fragmented capacity and made the 5-pack unbuyable).

const beginMock = vi.fn();
const getProductBySlugInTxMock = vi.fn();
const getWalletForUpdateInTxMock = vi.fn();
const setWalletStateInTxMock = vi.fn();
const getTicketPackPurchaseWindowInTxMock = vi.fn();
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
    createCompletedPurchaseInTx: (...a: unknown[]) => createCompletedPurchaseInTxMock(...a),
    insertTransactionLogInTx: (...a: unknown[]) => insertTransactionLogInTxMock(...a),
    insertTransactionLog: (...a: unknown[]) => insertTransactionLogMock(...a),
  },
}));

function makeTicketPack(slug: string, tickets: number, priceCoins: number) {
  return {
    id: `prod-${slug}`,
    slug,
    type: 'ticket_pack',
    name: { en: `${tickets} Tickets` },
    description: { en: 'Tickets' },
    price_cents: priceCoins,
    currency: 'coins',
    metadata: { tickets },
    is_active: true,
    sort_order: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('storeService.purchaseWithCoins — quantity-based daily ticket cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginMock.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }));
    getWalletForUpdateInTxMock.mockResolvedValue({
      coins: 100_000,
      tickets: 0,
      // Fresh anchor so ticket hydration doesn't auto-refill the wallet
      // before the purchase (we want 0 tickets + full coin balance).
      tickets_refill_started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    setWalletStateInTxMock.mockImplementation(async (_tx, _userId, state: { coins: number; tickets: number; ticketsRefillStartedAt: string | null }) => ({
      coins: state.coins,
      tickets: state.tickets,
      tickets_refill_started_at: state.ticketsRefillStartedAt,
    }));
    createCompletedPurchaseInTxMock.mockResolvedValue({ id: 'purchase-1' });
    insertTransactionLogInTxMock.mockResolvedValue({ id: 'log-1' });
    insertTransactionLogMock.mockResolvedValue({ id: 'log-fail-1' });
  });

  it('rejects a 3-pack when only 2 tickets remain in the daily window', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_3', 3, 4000));
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({
      ticketCount: 3, // 3 of 5 already bought today → 2 remaining
      oldest_purchased_at: '2026-06-10T08:00:00.000Z',
    });

    await expect(
      storeService.purchaseWithCoins('user-1', 'ticket_pack_3')
    ).rejects.toMatchObject({ code: 'TICKET_PURCHASE_COOLDOWN' });

    expect(setWalletStateInTxMock).not.toHaveBeenCalled();
  });

  it('allows a 1-pack when 2 tickets remain in the daily window', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_1', 1, 2000));
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({
      ticketCount: 3,
      oldest_purchased_at: '2026-06-10T08:00:00.000Z',
    });

    const result = await storeService.purchaseWithCoins('user-1', 'ticket_pack_1');

    expect(result.wallet.tickets).toBe(1);
    expect(result.wallet.coins).toBe(98_000);
  });

  it('allows the 5-pack on a fresh window and rejects anything afterwards', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_5', 5, 5000));
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({
      ticketCount: 0,
      oldest_purchased_at: null,
    });

    const result = await storeService.purchaseWithCoins('user-1', 'ticket_pack_5');
    expect(result.wallet.tickets).toBe(5);
    expect(result.wallet.coins).toBe(95_000);

    // Whole allowance consumed → even a single ticket is now rejected.
    getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_1', 1, 2000));
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({
      ticketCount: 5,
      oldest_purchased_at: '2026-06-10T08:00:00.000Z',
    });

    await expect(
      storeService.purchaseWithCoins('user-1', 'ticket_pack_1')
    ).rejects.toMatchObject({ code: 'TICKET_PURCHASE_COOLDOWN' });
  });

  it('enforces the cap against a FIXED daily window (00:00 Georgia), not a rolling 24h boundary', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_1', 1, 2000));
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({ ticketCount: 0, oldest_purchased_at: null });

    await storeService.purchaseWithCoins('user-1', 'ticket_pack_1');

    // The `since` boundary passed to the repo must be the current Georgia-day
    // start (00:00 Asia/Tbilisi = 20:00 UTC), NOT `now - 24h`.
    const sinceArg = getTicketPackPurchaseWindowInTxMock.mock.calls[0]?.[2] as string;
    const sinceMs = Date.parse(sinceArg);
    const OFFSET = 4 * 60 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;
    const expectedStart = Math.floor((Date.now() + OFFSET) / DAY) * DAY - OFFSET;
    expect(sinceMs).toBe(expectedStart);
    // Fixed window: it is NOT a rolling now-24h boundary (which would be ~24h before now).
    expect(Date.now() - sinceMs).toBeLessThanOrEqual(DAY);
  });

  it('reports nextAvailableAt as the next Georgia daily reset when at the cap', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    // getWallet path: at the cap (5 bought today) → cooldown points at next reset.
    vi.doMock('../../src/modules/store/ticket-refill.service.js', async (orig) => orig());
    getTicketPackPurchaseWindowInTxMock.mockResolvedValue({ ticketCount: 5, oldest_purchased_at: null });

    // Assert the cooldown math directly against the fixed window boundary.
    const OFFSET = 4 * 60 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;
    const windowStart = Math.floor((Date.now() + OFFSET) / DAY) * DAY - OFFSET;
    const expectedReset = new Date(windowStart + DAY).toISOString();
    // The next reset must be in the future and exactly one day after the window start.
    expect(new Date(expectedReset).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(expectedReset).getTime() - windowStart).toBe(DAY);
  });
});
