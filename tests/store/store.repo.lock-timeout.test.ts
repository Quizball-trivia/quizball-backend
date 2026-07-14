import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

import type { TransactionSql } from '../../src/db/index.js';
import { storeRepo } from '../../src/modules/store/store.repo.js';

function transactionDouble(queryResult: unknown[] = []) {
  const savepointUnsafe = vi.fn().mockResolvedValue(queryResult);
  const savepoint = {
    unsafe: savepointUnsafe,
  } as unknown as TransactionSql;
  const tx = {
    unsafe: vi.fn().mockResolvedValue([]),
    savepoint: vi.fn(async (work: (nested: TransactionSql) => Promise<unknown>) => work(savepoint)),
  } as unknown as TransactionSql;
  return { tx, savepointUnsafe };
}

describe('storeRepo wallet lock timeout', () => {
  it('sets a two-second local timeout before SELECT FOR UPDATE', async () => {
    const wallet = { coins: 10, tickets: 2, tickets_refill_started_at: null };
    const { tx, savepointUnsafe } = transactionDouble([wallet]);

    await expect(storeRepo.getWalletForUpdateInTx(tx, 'user-1')).resolves.toEqual(wallet);

    expect(tx.unsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2s'");
    expect(savepointUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      ['user-1']
    );
  });

  it('turns a lock timeout into a CAS miss after rolling back the savepoint', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const tx = {
      unsafe: vi.fn().mockResolvedValue([]),
      savepoint: vi.fn().mockRejectedValue(lockTimeout),
    } as unknown as TransactionSql;

    await expect(storeRepo.compareAndSetTicketsStateInTx(tx, {
      userId: 'user-1',
      observedTickets: 2,
      observedTicketsRefillStartedAt: null,
      tickets: 1,
      ticketsRefillStartedAt: '2026-07-14T20:00:00.000Z',
    })).resolves.toBeNull();

    expect(tx.unsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2s'");
    expect(tx.savepoint).toHaveBeenCalledTimes(1);
  });

  it('does not hide non-lock database errors', async () => {
    const databaseError = Object.assign(new Error('connection lost'), { code: '08006' });
    const tx = {
      unsafe: vi.fn().mockResolvedValue([]),
      savepoint: vi.fn().mockRejectedValue(databaseError),
    } as unknown as TransactionSql;

    await expect(storeRepo.compareAndSetTicketsStateInTx(tx, {
      userId: 'user-1',
      observedTickets: 2,
      observedTicketsRefillStartedAt: null,
      tickets: 1,
      ticketsRefillStartedAt: null,
    })).rejects.toBe(databaseError);
  });
});
