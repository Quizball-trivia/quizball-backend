import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_ONLY_SQLSTATE, readOnlyDbBreaker } from '../../src/db/readonly-breaker.js';
import { config } from '../../src/core/config.js';
import {
  buildSystemStatus,
  setSystemStatusRealtimeServer,
  emitSystemStatus,
  __resetSystemStatusForTests,
} from '../../src/realtime/services/system-status.service.js';

function readOnlyError(): Error & { code: string } {
  const error = new Error('cannot execute in a read-only transaction') as Error & { code: string };
  error.code = READ_ONLY_SQLSTATE;
  return error;
}

/** Minimal fake of the parts of QuizballServer the service touches. */
function fakeIo() {
  const emit = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { emit } as any;
}

const WINDOW_MS = config.DB_OUTAGE_BREAKER_WINDOW_MS ?? 60_000;

describe('system-status service', () => {
  beforeEach(() => {
    readOnlyDbBreaker.resetForTests();
    __resetSystemStatusForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetSystemStatusForTests();
    readOnlyDbBreaker.resetForTests();
  });

  describe('buildSystemStatus', () => {
    it('reports available/healthy when the breaker is closed', () => {
      const status = buildSystemStatus();
      expect(status.degraded).toBe(false);
      expect(status.reason).toBeNull();
      expect(status.matchmaking).toBe('available');
      expect(status.sinceMs).toBeNull();
      expect(typeof status.serverTimeMs).toBe('number');
    });

    it('reports paused/db_write_outage with sinceMs when degraded', () => {
      readOnlyDbBreaker.recordError(readOnlyError());
      const status = buildSystemStatus();
      expect(status.degraded).toBe(true);
      expect(status.reason).toBe('db_write_outage');
      expect(status.matchmaking).toBe('paused');
      expect(status.sinceMs).toBeGreaterThan(0);
    });
  });

  describe('breaker edge → broadcast', () => {
    it('broadcasts system:status exactly on the trip edge, not per error', () => {
      const io = fakeIo();
      setSystemStatusRealtimeServer(io);
      expect(io.emit).not.toHaveBeenCalled();

      readOnlyDbBreaker.recordError(readOnlyError());
      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenLastCalledWith(
        'system:status',
        expect.objectContaining({ degraded: true, matchmaking: 'paused' }),
      );

      // A second 25006 while already degraded must NOT re-broadcast (edge only).
      readOnlyDbBreaker.recordError(readOnlyError());
      expect(io.emit).toHaveBeenCalledTimes(1);
    });

    it('broadcasts a healthy status on the recovery edge', () => {
      const io = fakeIo();
      setSystemStatusRealtimeServer(io);
      readOnlyDbBreaker.recordError(readOnlyError());
      io.emit.mockClear();

      // Probe cannot clear until the window elapses.
      readOnlyDbBreaker.recordProbeSuccess();
      expect(io.emit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(WINDOW_MS + 1);
      readOnlyDbBreaker.recordProbeSuccess();
      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenLastCalledWith(
        'system:status',
        expect.objectContaining({ degraded: false, matchmaking: 'available' }),
      );
    });

    it('does not throw when no server is wired (emit is best-effort)', () => {
      __resetSystemStatusForTests();
      expect(() => emitSystemStatus()).not.toThrow();
      expect(() => readOnlyDbBreaker.recordError(readOnlyError())).not.toThrow();
    });
  });

  describe('forceRecover', () => {
    it('clears the latch immediately (bypassing the probe window) and emits', () => {
      const io = fakeIo();
      setSystemStatusRealtimeServer(io);
      readOnlyDbBreaker.recordError(readOnlyError());
      io.emit.mockClear();

      readOnlyDbBreaker.forceRecover();
      expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
      expect(io.emit).toHaveBeenCalledTimes(1);
    });
  });
});
