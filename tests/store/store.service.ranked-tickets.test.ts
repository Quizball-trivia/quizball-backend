import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const beginMock = vi.fn();
const hydrateTicketsInTxMock = vi.fn();
const consumeRankedTicketInTxMock = vi.fn();
const setTicketsStateInTxMock = vi.fn();

vi.mock('../../src/db/index.js', () => ({
  sql: {
    begin: (...args: unknown[]) => beginMock(...args),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    setTicketsStateInTx: (...args: unknown[]) => setTicketsStateInTxMock(...args),
  },
}));

vi.mock('../../src/modules/store/stripe.js', () => ({
  stripe: {},
}));

vi.mock('../../src/modules/store/ticket-refill.service.js', () => ({
  MAX_TICKETS: 3,
  resolveHydratedTicketState: vi.fn(),
  ticketRefillService: {
    hydrateTicketsInTx: (...args: unknown[]) => hydrateTicketsInTxMock(...args),
    consumeRankedTicketInTx: (...args: unknown[]) => consumeRankedTicketInTxMock(...args),
  },
}));

describe('storeService.consumeRankedTickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginMock.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }));
  });

  it('does not partially consume tickets when any ranked participant has none', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    hydrateTicketsInTxMock.mockImplementation(async (_tx: unknown, userId: string) => ({
      coins: 0,
      tickets: userId === 'u-empty' ? 0 : 1,
      tickets_refill_started_at: null,
    }));

    const result = await storeService.consumeRankedTickets(['u-ready', 'u-empty']);

    expect(result).toBeNull();
    expect(hydrateTicketsInTxMock).toHaveBeenCalledTimes(2);
    expect(consumeRankedTicketInTxMock).not.toHaveBeenCalled();
  });

  it('consumes every ranked participant only after all ticket preflights pass', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    hydrateTicketsInTxMock.mockResolvedValue({
      coins: 0,
      tickets: 1,
      tickets_refill_started_at: null,
    });
    consumeRankedTicketInTxMock.mockImplementation(async (_tx: unknown, userId: string) => ({
      consumed: true,
      wallet: {
        coins: 0,
        tickets: userId === 'u-a' ? 2 : 4,
      },
    }));

    const result = await storeService.consumeRankedTickets(['u-b', 'u-a']);

    expect(result?.wallets['u-a']).toMatchObject({ coins: 0, tickets: 2 });
    expect(result?.wallets['u-b']).toMatchObject({ coins: 0, tickets: 4 });
    expect(consumeRankedTicketInTxMock).toHaveBeenCalledTimes(2);
  });
});

describe('storeService.refundRankedTickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginMock.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }));
  });

  it('returns one ticket per ranked participant without exceeding the ticket cap', async () => {
    const { storeService } = await import('../../src/modules/store/store.service.js');
    hydrateTicketsInTxMock.mockImplementation(async (_tx: unknown, userId: string) => ({
      coins: 0,
      tickets: userId === 'u-capped' ? 3 : 2,
      tickets_refill_started_at: userId === 'u-capped' ? '2026-05-30T00:00:00.000Z' : null,
    }));
    setTicketsStateInTxMock.mockImplementation(async (
      _tx: unknown,
      userId: string,
      tickets: number,
      ticketsRefillStartedAt: string | null
    ) => ({
      coins: 0,
      tickets,
      tickets_refill_started_at: ticketsRefillStartedAt,
      user_id: userId,
    }));

    const result = await storeService.refundRankedTickets(['u-capped', 'u-spent']);

    expect(result.wallets['u-capped']).toMatchObject({ coins: 0, tickets: 3 });
    expect(result.wallets['u-spent']).toMatchObject({ coins: 0, tickets: 3 });
    expect(setTicketsStateInTxMock).toHaveBeenCalledWith(
      { tx: true },
      'u-capped',
      3,
      null
    );
    expect(setTicketsStateInTxMock).toHaveBeenCalledWith(
      { tx: true },
      'u-spent',
      3,
      null
    );
  });
});
