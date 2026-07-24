import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    getWalletInTx: vi.fn(),
    compareAndSetTicketsStateInTx: vi.fn(),
    getWalletForUpdateInTx: vi.fn(),
    setTicketsStateInTx: vi.fn(),
  },
}));

import { AppError } from '../../src/core/errors.js';
import { storeRepo } from '../../src/modules/store/store.repo.js';
import {
  MAX_TICKETS,
  resolveHydratedTicketState,
  ticketRefillService,
} from '../../src/modules/store/ticket-refill.service.js';

describe('ticketRefillService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Refills are now granted by the global `refill-tickets-every-4h` cron, NOT
  // lazily from elapsed time. resolveHydratedTicketState is therefore a pure
  // clamp to [0, MAX_TICKETS] that leaves the cron-owned anchor untouched.
  describe('resolveHydratedTicketState (pure clamp — cron owns refills)', () => {
    it('does NOT add tickets from elapsed time, even after many hours', () => {
      const result = resolveHydratedTicketState(
        { tickets: 2, tickets_refill_started_at: '2026-03-08T10:00:00.000Z' },
        '2026-03-09T10:00:00.000Z' // 24h later — old logic would have refilled to MAX
      );

      expect(result).toEqual({
        tickets: 2, // unchanged
        ticketsRefillStartedAt: '2026-03-08T10:00:00.000Z', // anchor untouched
        changed: false,
      });
    });

    it('leaves an in-range wallet untouched regardless of the now argument', () => {
      const result = resolveHydratedTicketState(
        { tickets: 4, tickets_refill_started_at: null },
        '2026-03-08T14:01:00.000Z'
      );

      expect(result).toEqual({ tickets: 4, ticketsRefillStartedAt: null, changed: false });
    });

    it('clamps an over-cap wallet back to the max (defensive), preserving the anchor', () => {
      const result = resolveHydratedTicketState(
        { tickets: 14, tickets_refill_started_at: '2026-03-08T10:00:00.000Z' },
        '2026-03-08T12:00:00.000Z'
      );

      expect(result).toEqual({
        tickets: MAX_TICKETS,
        ticketsRefillStartedAt: '2026-03-08T10:00:00.000Z', // not nulled — left as-is
        changed: true,
      });
    });

    it('clamps a negative/garbage ticket count up to 0', () => {
      const result = resolveHydratedTicketState(
        { tickets: -3, tickets_refill_started_at: null },
      );

      expect(result).toEqual({ tickets: 0, ticketsRefillStartedAt: null, changed: true });
    });
  });

  describe('transaction helpers', () => {
    it('is a no-op (no CAS) when the wallet is already in range', async () => {
      // With cron-driven refills, hydrate no longer tops up from elapsed time.
      // An in-range wallet needs no write, no matter how old the anchor is.
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 2,
        tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
      });

      const result = await ticketRefillService.hydrateTicketsInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T18:01:00.000Z' } // 8h later — old logic refilled; new does not
      );

      expect(result).toMatchObject({ coins: 100, tickets: 2 });
      expect(storeRepo.getWalletInTx).toHaveBeenCalledTimes(1);
      expect(storeRepo.compareAndSetTicketsStateInTx).not.toHaveBeenCalled();
    });

    it('clamps an over-cap wallet via CAS and retries once after a race', async () => {
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 9, // out of range → clamp to MAX requires a write
        tickets_refill_started_at: null,
      });
      (storeRepo.compareAndSetTicketsStateInTx as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ coins: 100, tickets: MAX_TICKETS, tickets_refill_started_at: null });

      const result = await ticketRefillService.hydrateTicketsInTx({} as never, 'user-1');

      expect(result).toMatchObject({ coins: 100, tickets: MAX_TICKETS });
      expect(storeRepo.getWalletInTx).toHaveBeenCalledTimes(2);
      expect(storeRepo.compareAndSetTicketsStateInTx).toHaveBeenCalledTimes(2);
    });

    it('starts a refill anchor when consuming from a full wallet', async () => {
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: MAX_TICKETS,
        tickets_refill_started_at: null,
      });
      (storeRepo.compareAndSetTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: MAX_TICKETS - 1,
        tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
      });

      const result = await ticketRefillService.consumeRankedTicketInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T10:00:00.000Z' }
      );

      expect(result.consumed).toBe(true);
      expect(storeRepo.compareAndSetTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        {
          userId: 'user-1',
          observedTickets: MAX_TICKETS,
          observedTicketsRefillStartedAt: null,
          tickets: MAX_TICKETS - 1,
          ticketsRefillStartedAt: '2026-03-08T10:00:00.000Z',
        }
      );
    });

    it('preserves the existing anchor when consuming below the cap', async () => {
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 2,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });
      (storeRepo.compareAndSetTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 1,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });

      const result = await ticketRefillService.consumeRankedTicketInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T10:00:00.000Z' }
      );

      expect(result.consumed).toBe(true);
      expect(storeRepo.compareAndSetTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        {
          userId: 'user-1',
          observedTickets: 2,
          observedTicketsRefillStartedAt: '2026-03-08T09:15:00.000Z',
          tickets: 1,
          ticketsRefillStartedAt: '2026-03-08T09:15:00.000Z',
        }
      );
    });

    it('returns unconsumed without CAS when the wallet has no ticket and no hydration change', async () => {
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 0,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });

      const result = await ticketRefillService.consumeRankedTicketInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T10:00:00.000Z' }
      );

      expect(result).toEqual({
        consumed: false,
        wallet: {
          coins: 100,
          tickets: 0,
          tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
        },
      });
      expect(storeRepo.compareAndSetTicketsStateInTx).not.toHaveBeenCalled();
    });

    it('throws a conflict when consume CAS misses repeatedly', async () => {
      (storeRepo.getWalletInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 1,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });
      (storeRepo.compareAndSetTicketsStateInTx as Mock).mockResolvedValue(null);
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      await expect(
        ticketRefillService.consumeRankedTicketInTx(
          {} as never,
          'user-1',
          { now: '2026-03-08T10:00:00.000Z' }
        )
      ).rejects.toMatchObject<AppError>({
        code: 'CONFLICT',
      });

      // Matches TICKET_CAS_MAX_ATTEMPTS (raised to 6 so transient wallet
      // contention converges instead of aborting a ranked match).
      expect(storeRepo.compareAndSetTicketsStateInTx).toHaveBeenCalledTimes(6);
      // Pin the backoff curve (25ms × attempt) so a regression to near-zero
      // spacing can't slip through while the retry count still passes.
      const backoffDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(backoffDelays).toEqual([25, 50, 75, 100, 125]);
      setTimeoutSpy.mockRestore();
    });

    it('rejects overflowing ticket grants when overflow rejection is enabled', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 2,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });

      await expect(
        ticketRefillService.clampTicketGrantInTx(
          {} as never,
          'user-1',
          4,
          {
            now: '2026-03-08T09:30:00.000Z',
            rejectOnOverflow: true,
          }
        )
      ).rejects.toMatchObject<AppError>({
        code: 'TICKETS_FULL',
      });
    });

    it('caps ticket grants at the wallet max and clears the anchor when the wallet becomes full', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 2,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });
      (storeRepo.setTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: MAX_TICKETS,
        tickets_refill_started_at: null,
      });

      const result = await ticketRefillService.clampTicketGrantInTx(
        {} as never,
        'user-1',
        5,
        {
          now: '2026-03-08T09:30:00.000Z',
          rejectOnOverflow: false,
        }
      );

      expect(result.grantedTickets).toBe(3);
      expect(storeRepo.setTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        MAX_TICKETS,
        null
      );
    });
  });
});
