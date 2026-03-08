import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
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

  describe('resolveHydratedTicketState', () => {
    it('preserves partial progress when less than one hour has elapsed', () => {
      const result = resolveHydratedTicketState(
        {
          tickets: 9,
          tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
        },
        '2026-03-08T10:30:00.000Z'
      );

      expect(result).toEqual({
        tickets: 9,
        ticketsRefillStartedAt: '2026-03-08T10:00:00.000Z',
        changed: false,
      });
    });

    it('fills to cap and clears the refill anchor once enough time has passed', () => {
      const result = resolveHydratedTicketState(
        {
          tickets: 9,
          tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
        },
        '2026-03-08T11:01:00.000Z'
      );

      expect(result).toEqual({
        tickets: MAX_TICKETS,
        ticketsRefillStartedAt: null,
        changed: true,
      });
    });

    it('advances the refill anchor by whole hours while preserving leftover progress', () => {
      const result = resolveHydratedTicketState(
        {
          tickets: 3,
          tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
        },
        '2026-03-08T12:30:00.000Z'
      );

      expect(result).toEqual({
        tickets: 5,
        ticketsRefillStartedAt: '2026-03-08T12:00:00.000Z',
        changed: true,
      });
    });

    it('normalizes over-cap wallets back to the max and clears the anchor', () => {
      const result = resolveHydratedTicketState(
        {
          tickets: 14,
          tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
        },
        '2026-03-08T12:00:00.000Z'
      );

      expect(result).toEqual({
        tickets: MAX_TICKETS,
        ticketsRefillStartedAt: null,
        changed: true,
      });
    });
  });

  describe('transaction helpers', () => {
    it('starts a refill anchor when consuming from a full wallet', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 10,
        tickets_refill_started_at: null,
      });
      (storeRepo.setTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 9,
        tickets_refill_started_at: '2026-03-08T10:00:00.000Z',
      });

      const result = await ticketRefillService.consumeRankedTicketInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T10:00:00.000Z' }
      );

      expect(result.consumed).toBe(true);
      expect(storeRepo.setTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        9,
        '2026-03-08T10:00:00.000Z'
      );
    });

    it('preserves the existing anchor when consuming below the cap', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 4,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });
      (storeRepo.setTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 3,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });

      const result = await ticketRefillService.consumeRankedTicketInTx(
        {} as never,
        'user-1',
        { now: '2026-03-08T10:00:00.000Z' }
      );

      expect(result.consumed).toBe(true);
      expect(storeRepo.setTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        3,
        '2026-03-08T09:15:00.000Z'
      );
    });

    it('rejects overflowing ticket grants when overflow rejection is enabled', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 8,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });

      await expect(
        ticketRefillService.clampTicketGrantInTx(
          {} as never,
          'user-1',
          3,
          {
            now: '2026-03-08T09:30:00.000Z',
            rejectOnOverflow: true,
          }
        )
      ).rejects.toMatchObject<AppError>({
        code: 'TICKETS_FULL',
      });
    });

    it('caps ticket grants at 10 and clears the anchor when the wallet becomes full', async () => {
      (storeRepo.getWalletForUpdateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 8,
        tickets_refill_started_at: '2026-03-08T09:15:00.000Z',
      });
      (storeRepo.setTicketsStateInTx as Mock).mockResolvedValue({
        coins: 100,
        tickets: 10,
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

      expect(result.grantedTickets).toBe(2);
      expect(storeRepo.setTicketsStateInTx).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        10,
        null
      );
    });
  });
});
