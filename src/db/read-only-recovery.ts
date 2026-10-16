import { setTimeout as delay } from 'node:timers/promises';

/** PostgreSQL rejects a write before it can commit in a read-only transaction. */
export function isReadOnlyTransactionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === '25006';
}

/**
 * Only pass a complete transaction whose callback has no external side effects.
 * postgres.js begin() must have rejected (and finished rollback) before retrying.
 * Never replay connection/commit failures: their commit outcome can be unknown.
 */
export async function retryRolledBackReadOnlyTransaction<T>(
  runTransaction: () => Promise<T>,
  onRetry: () => void,
): Promise<T> {
  try {
    return await runTransaction();
  } catch (error) {
    if (!isReadOnlyTransactionError(error)) throw error;
    onRetry();
    // Release the failed transaction before another pool acquisition; stay bounded.
    await delay(100);
    return runTransaction();
  }
}

/** A read-only SELECT can succeed while application writes are unavailable. */
export function assertWritableTransaction(mode: unknown): void {
  if (mode === 'off') return;
  throw Object.assign(new Error('Database transaction is not writable'), {
    code: mode === 'on' ? '25006' : 'DB_OVERLOADED',
  });
}
