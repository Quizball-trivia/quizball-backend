import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from '../../src/db/index.js';
import { storeRepo } from '../../src/modules/store/store.repo.js';

function transactionReturning(rows: unknown[]) {
  const unsafe = vi.fn().mockResolvedValue(rows);
  return {
    tx: { unsafe } as unknown as TransactionSql,
    unsafe,
  };
}

describe('storeRepo fractional wallet mutations', () => {
  it('applies an exact minor-unit delta in one guarded update', async () => {
    const wallet = {
      coins: 25,
      coin_fraction_minor: 75,
      tickets: 4,
    };
    const { tx, unsafe } = transactionReturning([wallet]);

    await expect(storeRepo.adjustWalletMinorInTx(tx, 'user-1', -125, -1))
      .resolves.toEqual(wallet);

    const [statement, parameters] = unsafe.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain('coins::bigint * 100 + coin_fraction_minor::bigint + $1::bigint >= 0');
    expect(statement).toContain('RETURNING coins, coin_fraction_minor, tickets');
    expect(parameters).toEqual([-125, -1, 'user-1']);
  });

  it('returns null when the atomic balance guards reject the update', async () => {
    const { tx } = transactionReturning([]);

    await expect(storeRepo.adjustWalletMinorInTx(tx, 'user-1', -1, 0))
      .resolves.toBeNull();
  });

  it('converts existing whole-coin adjustments to minor units', async () => {
    const wallet = {
      coins: 37,
      coin_fraction_minor: 42,
      tickets: 2,
    };
    const { tx, unsafe } = transactionReturning([wallet]);

    await expect(storeRepo.adjustWalletInTx(tx, 'user-1', 12, 0))
      .resolves.toEqual(wallet);

    expect(unsafe.mock.calls[0]?.[1]).toEqual([1_200, 0, 'user-1']);
  });

  it('rejects non-integer financial deltas before querying', async () => {
    const { tx, unsafe } = transactionReturning([]);

    await expect(storeRepo.adjustWalletMinorInTx(tx, 'user-1', 0.5))
      .rejects.toThrow(RangeError);
    await expect(storeRepo.adjustWalletInTx(tx, 'user-1', 1.25, 0))
      .rejects.toThrow(RangeError);
    expect(unsafe).not.toHaveBeenCalled();
  });
});

describe('storeRepo exact transaction logs', () => {
  it('derives exact minor units from a legacy whole-coin delta', async () => {
    const { tx, unsafe } = transactionReturning([{ id: 'log-1' }]);

    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: 'manual_adjustment_succeeded',
      outcome: 'success',
      coinsDelta: -25,
    });

    const parameters = unsafe.mock.calls[0]?.[1] as unknown[];
    expect(parameters[8]).toBe(-25);
    expect(parameters[9]).toBe(-2_500);
  });

  it('stores an exact minor delta while retaining the legacy integer field', async () => {
    const { tx, unsafe } = transactionReturning([{ id: 'log-1' }]);

    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: 'road_to_goal_payout',
      outcome: 'success',
      coinsDeltaMinor: 2_575,
    });

    const [statement, parameters] = unsafe.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain('coins_delta_minor');
    expect(parameters[8]).toBe(25);
    expect(parameters[9]).toBe(2_575);
  });
});
