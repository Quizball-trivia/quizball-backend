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
const getTicketPackPurchaseWindowMock = vi.fn();
const createCompletedPurchaseInTxMock = vi.fn();
const insertTransactionLogInTxMock = vi.fn();
const insertTransactionLogMock = vi.fn();
const hydrateTicketsMock = vi.fn();

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
    getTicketPackPurchaseWindow: (...a: unknown[]) => getTicketPackPurchaseWindowMock(...a),
    createCompletedPurchaseInTx: (...a: unknown[]) => createCompletedPurchaseInTxMock(...a),
    insertTransactionLogInTx: (...a: unknown[]) => insertTransactionLogInTxMock(...a),
    insertTransactionLog: (...a: unknown[]) => insertTransactionLogMock(...a),
  },
}));

vi.mock('../../src/modules/store/ticket-refill.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/store/ticket-refill.service.js')>();
  return {
    ...actual,
    ticketRefillService: {
      ...actual.ticketRefillService,
      hydrateTickets: (...a: unknown[]) => hydrateTicketsMock(...a),
    },
  };
});

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
    // Freeze the clock at a fixed instant so the service's window computation and
    // the expected boundary use the SAME `now` (otherwise a Georgia-day rollover
    // between the two Date.now() reads could flake the assertion).
    const OFFSET = 4 * 60 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;
    const frozen = Date.UTC(2026, 6, 10, 10, 0, 0); // arbitrary fixed instant
    vi.useFakeTimers();
    vi.setSystemTime(frozen);
    try {
      const { storeService } = await import('../../src/modules/store/store.service.js');
      getProductBySlugInTxMock.mockResolvedValue(makeTicketPack('ticket_pack_1', 1, 2000));
      getTicketPackPurchaseWindowInTxMock.mockResolvedValue({ ticketCount: 0, oldest_purchased_at: null });

      await storeService.purchaseWithCoins('user-1', 'ticket_pack_1');

      // The `since` boundary passed to the repo must be the current Georgia-day
      // start (00:00 Asia/Tbilisi = 20:00 UTC), NOT `now - 24h`.
      const sinceArg = getTicketPackPurchaseWindowInTxMock.mock.calls[0]?.[2] as string;
      const sinceMs = Date.parse(sinceArg);
      const expectedStart = Math.floor((frozen + OFFSET) / DAY) * DAY - OFFSET;
      expect(sinceMs).toBe(expectedStart);
      // Fixed window: within the current day, not a rolling now-24h boundary.
      expect(frozen - sinceMs).toBeLessThanOrEqual(DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getWallet reports nextAvailableAt as the next Georgia daily reset when at the cap', async () => {
    const OFFSET = 4 * 60 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;
    const frozen = Date.UTC(2026, 6, 10, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(frozen);
    try {
      // Exercise the real getWallet() path: mock its non-tx deps (refill hydrate
      // + the non-tx purchase-window query) so we assert the actual cooldown
      // fields the service returns, not duplicated date math.
      getTicketPackPurchaseWindowMock.mockResolvedValue({ ticketCount: 5, oldest_purchased_at: null });
      hydrateTicketsMock.mockResolvedValue({ coins: 1000, tickets: 5 });

      const { storeService } = await import('../../src/modules/store/store.service.js');
      const wallet = await storeService.getWallet('user-1');

      const windowStart = Math.floor((frozen + OFFSET) / DAY) * DAY - OFFSET;
      const expectedReset = new Date(windowStart + DAY).toISOString();
      expect(wallet.ticketPurchaseCooldown.canBuy).toBe(false);
      expect(wallet.ticketPurchaseCooldown.nextAvailableAt).toBe(expectedReset);
      expect(wallet.ticketPurchaseCooldown.remainingSeconds).toBe(
        Math.ceil((windowStart + DAY - frozen) / 1000)
      );
      expect(wallet.ticketPurchaseCooldown.ticketsRemainingInWindow).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
