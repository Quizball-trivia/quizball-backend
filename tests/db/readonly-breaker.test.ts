import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_ONLY_ALERT_MARKER,
  READ_ONLY_SQLSTATE,
  DbWriteOutageError,
  isDbWriteOutage,
  isReadOnlyTransactionError,
  readOnlyDbBreaker,
} from '../../src/db/readonly-breaker.js';
import { config } from '../../src/core/config.js';
import { logger } from '../../src/core/logger.js';

/** A postgres.js error as it actually surfaces for a read-only pool. */
function readOnlyError(): Error & { code: string } {
  const error = new Error('cannot execute CREATE TABLE in a read-only transaction') as Error & {
    code: string;
  };
  error.code = READ_ONLY_SQLSTATE;
  return error;
}

const WINDOW_MS = config.DB_OUTAGE_BREAKER_WINDOW_MS ?? 60_000;

describe('readOnlyDbBreaker', () => {
  beforeEach(() => {
    readOnlyDbBreaker.resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    readOnlyDbBreaker.resetForTests();
  });

  describe('detection', () => {
    it('identifies SQLSTATE 25006 and nothing else', () => {
      expect(isReadOnlyTransactionError(readOnlyError())).toBe(true);
      const other = new Error('deadlock') as Error & { code: string };
      other.code = '40P01';
      expect(isReadOnlyTransactionError(other)).toBe(false);
      expect(isReadOnlyTransactionError(new Error('plain'))).toBe(false);
      expect(isReadOnlyTransactionError(undefined)).toBe(false);
      expect(isReadOnlyTransactionError(null)).toBe(false);
    });
  });

  describe('tripping', () => {
    it('enters degraded mode on the FIRST 25006', () => {
      expect(isDbWriteOutage()).toBe(false);
      readOnlyDbBreaker.recordError(readOnlyError());
      expect(isDbWriteOutage()).toBe(true);
      const snapshot = readOnlyDbBreaker.snapshot();
      expect(snapshot.state).toBe('degraded');
      expect(snapshot.tripCount).toBe(1);
      expect(snapshot.observedErrors).toBe(1);
    });

    it('logs a CRITICAL alert marker exactly once per outage', () => {
      const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined as never);
      readOnlyDbBreaker.recordError(readOnlyError());
      readOnlyDbBreaker.recordError(readOnlyError());
      readOnlyDbBreaker.recordError(readOnlyError());

      expect(fatal).toHaveBeenCalledTimes(1);
      const [context, message] = fatal.mock.calls[0]!;
      expect(message).toContain(READ_ONLY_ALERT_MARKER);
      expect(context).toMatchObject({
        marker: READ_ONLY_ALERT_MARKER,
        sqlstate: READ_ONLY_SQLSTATE,
      });
      // All three errors are still counted even though only one alert fired.
      expect(readOnlyDbBreaker.snapshot().observedErrors).toBe(3);
    });

    it('ignores unrelated database errors', () => {
      const timeout = new Error('statement timeout') as Error & { code: string };
      timeout.code = '57014';
      readOnlyDbBreaker.recordError(timeout);
      expect(isDbWriteOutage()).toBe(false);
      expect(readOnlyDbBreaker.snapshot().observedErrors).toBe(0);
    });

    it('never throws, whatever it is handed', () => {
      expect(() => readOnlyDbBreaker.recordError('a string')).not.toThrow();
      expect(() => readOnlyDbBreaker.recordError(Symbol('x'))).not.toThrow();
      expect(isDbWriteOutage()).toBe(false);
    });
  });

  describe('recovery', () => {
    it('does NOT recover on a probe that succeeds inside the trip window', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      vi.advanceTimersByTime(Math.floor(WINDOW_MS / 2));

      // Only a SUBSET of pooled backends is poisoned during contamination, so an
      // early probe can land on a healthy connection while writes still fail.
      readOnlyDbBreaker.recordProbeSuccess();
      expect(isDbWriteOutage()).toBe(true);
    });

    it('recovers on a probe that succeeds after the window elapses', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      vi.advanceTimersByTime(WINDOW_MS + 1);

      readOnlyDbBreaker.recordProbeSuccess();
      expect(isDbWriteOutage()).toBe(false);
      expect(readOnlyDbBreaker.snapshot().state).toBe('closed');
    });

    it('stays degraded on time alone, with no successful probe', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      vi.advanceTimersByTime(WINDOW_MS * 10);

      // The window bounds how long we wait for a probe; it does not heal.
      expect(isDbWriteOutage()).toBe(true);
    });

    it('re-arms the window when a probe fails mid-outage', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      vi.advanceTimersByTime(WINDOW_MS + 1);

      readOnlyDbBreaker.recordProbeFailure(readOnlyError());
      // The failed probe pushed the window out, so an immediate success is refused.
      readOnlyDbBreaker.recordProbeSuccess();
      expect(isDbWriteOutage()).toBe(true);

      vi.advanceTimersByTime(WINDOW_MS + 1);
      readOnlyDbBreaker.recordProbeSuccess();
      expect(isDbWriteOutage()).toBe(false);
    });

    it('counts a second outage as a new trip', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      vi.advanceTimersByTime(WINDOW_MS + 1);
      readOnlyDbBreaker.recordProbeSuccess();
      expect(isDbWriteOutage()).toBe(false);

      readOnlyDbBreaker.recordError(readOnlyError());
      expect(isDbWriteOutage()).toBe(true);
      expect(readOnlyDbBreaker.snapshot().tripCount).toBe(2);
    });

    it('ignores a probe success when it was never degraded', () => {
      readOnlyDbBreaker.recordProbeSuccess();
      expect(readOnlyDbBreaker.snapshot().state).toBe('closed');
      expect(readOnlyDbBreaker.snapshot().tripCount).toBe(0);
    });
  });

  describe('feature flag', () => {
    it('never degrades when DB_OUTAGE_BREAKER_ENABLED is false', () => {
      const spy = vi
        .spyOn(config, 'DB_OUTAGE_BREAKER_ENABLED', 'get')
        .mockReturnValue(false as never);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

      readOnlyDbBreaker.recordError(readOnlyError());

      expect(isDbWriteOutage()).toBe(false);
      expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
      // Still observable for alerting even with the behaviour disabled.
      expect(readOnlyDbBreaker.snapshot().observedErrors).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![1]).toContain(READ_ONLY_ALERT_MARKER);
      spy.mockRestore();
    });
  });

  describe('DbWriteOutageError', () => {
    it('is a retryable, clearly-coded client error', () => {
      const error = new DbWriteOutageError();
      expect(error.code).toBe('DB_WRITE_OUTAGE');
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/try again/i);
    });
  });
});
