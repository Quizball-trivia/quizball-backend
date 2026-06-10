import { sql, type TransactionSql } from '../../db/index.js';
import { AppError, ErrorCode, NotFoundError } from '../../core/errors.js';
import { storeRepo } from './store.repo.js';
import type { StoreWalletResponse, WalletStateRow } from './store.types.js';

export const MAX_TICKETS = 5;
// Daily store purchase cap: up to this many TICKETS per rolling 24h window
// (quantity-based — a 5-pack consumes the whole allowance). Lives here next to
// MAX_TICKETS so wallet-shaping helpers can use it without importing
// store.service (which imports this module).
export const TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW = 5;
// One ticket refills every 4 hours, up to MAX_TICKETS.
export const TICKET_REFILL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const TICKET_CAS_MAX_ATTEMPTS = 3;

export interface HydratedTicketState {
  tickets: number;
  ticketsRefillStartedAt: string | null;
  changed: boolean;
}

function toIsoString(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export function toStoreWalletResponse(wallet: Pick<WalletStateRow, 'coins' | 'tickets'>): StoreWalletResponse {
  return {
    coins: wallet.coins,
    tickets: wallet.tickets,
    ticketPurchaseCooldown: {
      canBuy: true,
      nextAvailableAt: null,
      remainingSeconds: 0,
      ticketsRemainingInWindow: TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW,
    },
  };
}

export function resolveHydratedTicketState(
  wallet: Pick<WalletStateRow, 'tickets' | 'tickets_refill_started_at'>,
  nowInput: Date | string = new Date()
): HydratedTicketState {
  const nowIso = toIsoString(nowInput);
  const nowMs = Date.parse(nowIso);
  const cappedTickets = Math.max(0, Math.min(MAX_TICKETS, Math.trunc(wallet.tickets)));
  const currentAnchor = wallet.tickets_refill_started_at;

  if (cappedTickets >= MAX_TICKETS) {
    return {
      tickets: MAX_TICKETS,
      ticketsRefillStartedAt: null,
      changed: cappedTickets !== wallet.tickets || currentAnchor !== null,
    };
  }

  if (!currentAnchor) {
    return {
      tickets: cappedTickets,
      ticketsRefillStartedAt: nowIso,
      changed: cappedTickets !== wallet.tickets || currentAnchor !== nowIso,
    };
  }

  const anchorMs = Date.parse(currentAnchor);
  if (!Number.isFinite(anchorMs) || anchorMs > nowMs) {
    return {
      tickets: cappedTickets,
      ticketsRefillStartedAt: nowIso,
      changed: cappedTickets !== wallet.tickets || currentAnchor !== nowIso,
    };
  }

  const elapsedHours = Math.floor((nowMs - anchorMs) / TICKET_REFILL_INTERVAL_MS);
  if (elapsedHours <= 0) {
    return {
      tickets: cappedTickets,
      ticketsRefillStartedAt: currentAnchor,
      changed: cappedTickets !== wallet.tickets,
    };
  }

  const restoredTickets = Math.min(MAX_TICKETS, cappedTickets + elapsedHours);
  if (restoredTickets >= MAX_TICKETS) {
    return {
      tickets: MAX_TICKETS,
      ticketsRefillStartedAt: null,
      changed: restoredTickets !== wallet.tickets || currentAnchor !== null,
    };
  }

  const advancedAnchorMs = anchorMs + elapsedHours * TICKET_REFILL_INTERVAL_MS;
  const advancedAnchor = new Date(advancedAnchorMs).toISOString();

  return {
    tickets: restoredTickets,
    ticketsRefillStartedAt: advancedAnchor,
    changed: restoredTickets !== wallet.tickets || advancedAnchor !== currentAnchor,
  };
}

function ticketCasConflict(userId: string, operation: string): AppError {
  return new AppError(
    'Ticket state changed during update; retry the request',
    409,
    ErrorCode.CONFLICT,
    { userId, operation, attempts: TICKET_CAS_MAX_ATTEMPTS }
  );
}

async function waitBeforeCasRetry(attempt: number): Promise<void> {
  if (attempt >= TICKET_CAS_MAX_ATTEMPTS - 1) return;
  await new Promise((resolve) => setTimeout(resolve, attempt + 1));
}

export const ticketRefillService = {
  async hydrateTicketsInTx(
    tx: TransactionSql,
    userId: string,
    options?: { now?: Date | string }
  ): Promise<WalletStateRow | null> {
    for (let attempt = 0; attempt < TICKET_CAS_MAX_ATTEMPTS; attempt += 1) {
      const wallet = await storeRepo.getWalletInTx(tx, userId);
      if (!wallet) return null;

      const hydrated = resolveHydratedTicketState(wallet, options?.now);
      if (!hydrated.changed) {
        return wallet;
      }

      const updated = await storeRepo.compareAndSetTicketsStateInTx(tx, {
        userId,
        observedTickets: wallet.tickets,
        observedTicketsRefillStartedAt: wallet.tickets_refill_started_at,
        tickets: hydrated.tickets,
        ticketsRefillStartedAt: hydrated.ticketsRefillStartedAt,
      });
      if (updated) {
        return updated;
      }

      await waitBeforeCasRetry(attempt);
    }

    throw ticketCasConflict(userId, 'hydrate');
  },

  async hydrateTicketsForUpdateInTx(
    tx: TransactionSql,
    userId: string,
    options?: { now?: Date | string }
  ): Promise<WalletStateRow | null> {
    const wallet = await storeRepo.getWalletForUpdateInTx(tx, userId);
    if (!wallet) return null;

    const hydrated = resolveHydratedTicketState(wallet, options?.now);
    if (!hydrated.changed) {
      return wallet;
    }

    return storeRepo.setTicketsStateInTx(
      tx,
      userId,
      hydrated.tickets,
      hydrated.ticketsRefillStartedAt
    );
  },

  async hydrateTickets(userId: string, options?: { now?: Date | string }): Promise<WalletStateRow> {
    const wallet = await sql.begin(async (tx) => {
      const hydrated = await this.hydrateTicketsInTx(tx, userId, options);
      if (!hydrated) {
        throw new NotFoundError('User not found');
      }
      return hydrated;
    });

    return wallet;
  },

  async consumeRankedTicketInTx(
    tx: TransactionSql,
    userId: string,
    options?: { now?: Date | string }
  ): Promise<{ consumed: boolean; wallet: WalletStateRow | null }> {
    const nowIso = toIsoString(options?.now ?? new Date());

    for (let attempt = 0; attempt < TICKET_CAS_MAX_ATTEMPTS; attempt += 1) {
      const wallet = await storeRepo.getWalletInTx(tx, userId);
      if (!wallet) {
        return { consumed: false, wallet: null };
      }

      const hydrated = resolveHydratedTicketState(wallet, nowIso);
      if (hydrated.tickets < 1) {
        if (!hydrated.changed) {
          return { consumed: false, wallet };
        }

        const updated = await storeRepo.compareAndSetTicketsStateInTx(tx, {
          userId,
          observedTickets: wallet.tickets,
          observedTicketsRefillStartedAt: wallet.tickets_refill_started_at,
          tickets: hydrated.tickets,
          ticketsRefillStartedAt: hydrated.ticketsRefillStartedAt,
        });
        if (updated) {
          return { consumed: false, wallet: updated };
        }

        await waitBeforeCasRetry(attempt);
        continue;
      }

      const nextTickets = hydrated.tickets - 1;
      const nextAnchor = nextTickets < MAX_TICKETS
        ? hydrated.ticketsRefillStartedAt ?? nowIso
        : null;

      const updated = await storeRepo.compareAndSetTicketsStateInTx(tx, {
        userId,
        observedTickets: wallet.tickets,
        observedTicketsRefillStartedAt: wallet.tickets_refill_started_at,
        tickets: nextTickets,
        ticketsRefillStartedAt: nextAnchor,
      });
      if (updated) {
        return { consumed: true, wallet: updated };
      }

      await waitBeforeCasRetry(attempt);
    }

    throw ticketCasConflict(userId, 'consume');
  },

  async clampTicketGrantInTx(
    tx: TransactionSql,
    userId: string,
    requestedAmount: number,
    options?: {
      now?: Date | string;
      rejectOnOverflow?: boolean;
    }
  ): Promise<{ wallet: WalletStateRow; grantedTickets: number }> {
    const requested = Math.max(0, Math.trunc(requestedAmount));
    const wallet = await this.hydrateTicketsForUpdateInTx(tx, userId, { now: options?.now });
    if (!wallet) {
      throw new NotFoundError('User not found');
    }
    if (requested === 0) {
      return { wallet, grantedTickets: 0 };
    }

    const availableSpace = Math.max(0, MAX_TICKETS - wallet.tickets);
    if (availableSpace === 0 || (options?.rejectOnOverflow && requested > availableSpace)) {
      throw new AppError(
        'Tickets are already full',
        400,
        ErrorCode.TICKETS_FULL,
        {
          userId,
          requestedAmount: requested,
          availableSpace,
          maxTickets: MAX_TICKETS,
        }
      );
    }

    const grantedTickets = Math.min(requested, availableSpace);
    if (grantedTickets === 0) {
      return { wallet, grantedTickets: 0 };
    }

    const nextTickets = wallet.tickets + grantedTickets;
    const nextAnchor = nextTickets >= MAX_TICKETS ? null : wallet.tickets_refill_started_at;
    const updated = await storeRepo.setTicketsStateInTx(tx, userId, nextTickets, nextAnchor);
    if (!updated) {
      throw new NotFoundError('User not found');
    }

    return { wallet: updated, grantedTickets };
  },
};
