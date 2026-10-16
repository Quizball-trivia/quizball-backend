import { describe, expect, it, vi } from 'vitest';
import {
  assertWritableTransaction,
  isReadOnlyTransactionError,
  retryRolledBackReadOnlyTransaction,
} from '../../src/db/read-only-recovery.js';

const readOnlyError = () => Object.assign(new Error('read-only transaction'), { code: '25006' });

describe('rolled-back read-only transaction recovery', () => {
  it('does not repeat a successful transaction', async () => {
    const transaction = vi.fn().mockResolvedValue({ coins: 30 });
    const retry = vi.fn();
    await expect(retryRolledBackReadOnlyTransaction(transaction, retry)).resolves.toEqual({ coins: 30 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('waits for transaction rollback before retrying the entire callback', async () => {
    const order: string[] = [];
    let attempts = 0;
    const transaction = vi.fn(async () => {
      order.push('begin');
      if (attempts++ === 0) {
        try { throw readOnlyError(); }
        finally {
          await Promise.resolve();
          order.push('rollback');
        }
      }
      order.push('commit');
      return 'saved';
    });
    await expect(retryRolledBackReadOnlyTransaction(transaction, () => order.push('retry')))
      .resolves.toBe('saved');
    expect(order).toEqual(['begin', 'rollback', 'retry', 'begin', 'commit']);
  });

  it('stops after one retry when read-only mode persists', async () => {
    const error = readOnlyError();
    const transaction = vi.fn().mockRejectedValue(error);
    const retry = vi.fn();
    await expect(retryRolledBackReadOnlyTransaction(transaction, retry)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each(['ECONNRESET', 'CONNECTION_CLOSED', '23505', '40001', '42501', '25P02'])
    ('does not replay an ambiguous commit or unrelated failure (%s)', async (code) => {
      const error = Object.assign(new Error('failure'), { code });
      const transaction = vi.fn().mockRejectedValue(error);
      const retry = vi.fn();
      await expect(retryRolledBackReadOnlyTransaction(transaction, retry)).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });

  it('does not infer rollback from text, a nested cause or a domain error', () => {
    for (const error of [null, undefined, '25006', new Error('25006'), { cause: readOnlyError() }, { code: 25006 }]) {
      expect(isReadOnlyTransactionError(error)).toBe(false);
    }
    expect(isReadOnlyTransactionError(readOnlyError())).toBe(true);
  });
});

describe('database readiness writability', () => {
  it('accepts an explicitly writable transaction', () => {
    expect(() => assertWritableTransaction('off')).not.toThrow();
  });

  it('rejects a read-only transaction even though SELECT succeeded', () => {
    expect(() => assertWritableTransaction('on')).toThrow(expect.objectContaining({ code: '25006' }));
  });

  it.each([undefined, null, '', true])('fails closed when probe mode is missing (%s)', (mode) => {
    expect(() => assertWritableTransaction(mode)).toThrow(expect.objectContaining({ code: 'DB_OVERLOADED' }));
  });
});
