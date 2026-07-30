import { logger } from '../core/logger.js';
import { config } from '../core/config.js';

/**
 * PostgreSQL SQLSTATE for "cannot execute X in a read-only transaction".
 * This is the ONLY signal that a pooled connection has been contaminated with
 * `default_transaction_read_only=on` (INC-2026-07-29 / recurrence 2026-07-30).
 */
export const READ_ONLY_SQLSTATE = '25006';

/**
 * Distinct log marker for alerting. Alert rules match on this exact string —
 * do not reword it without updating the alert.
 */
export const READ_ONLY_ALERT_MARKER = 'DB_READONLY_OUTAGE';

export type BreakerState = 'closed' | 'degraded';

export type BreakerSnapshot = {
  enabled: boolean;
  state: BreakerState;
  degraded: boolean;
  trippedAtMs: number | null;
  degradedUntilMs: number | null;
  tripCount: number;
  observedErrors: number;
  lastErrorAtMs: number | null;
};

/**
 * Returns true when `error` is a Postgres read-only-transaction failure.
 * Matches the SQLSTATE only; message text is not load-bearing.
 */
export function isReadOnlyTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === READ_ONLY_SQLSTATE;
}

/**
 * Process-wide latch for a read-only database outage.
 *
 * Trips on the FIRST observed 25006 — during INC-2026-07-29 matchmaking kept
 * creating matches into a pool that could not persist their results, so there
 * is no error budget worth spending here. Recovery is probe-driven only: a
 * rollback-only write probe must actually succeed before writes resume. The
 * timed window is a ceiling, not a healer, so a still-poisoned pool cannot
 * silently un-degrade just because time passed.
 */
class ReadOnlyDbBreaker {
  private state: BreakerState = 'closed';
  private trippedAtMs: number | null = null;
  private degradedUntilMs: number | null = null;
  private tripCount = 0;
  private observedErrors = 0;
  private lastErrorAtMs: number | null = null;

  private get enabled(): boolean {
    return config.DB_OUTAGE_BREAKER_ENABLED !== false;
  }

  private get windowMs(): number {
    return config.DB_OUTAGE_BREAKER_WINDOW_MS ?? 60_000;
  }

  /**
   * Record a database error. Non-25006 errors are ignored. Safe to call from
   * any error path and never throws — a breaker bug must not mask the original
   * database failure.
   */
  recordError(error: unknown, context?: Record<string, unknown>): void {
    try {
      if (!isReadOnlyTransactionError(error)) return;
      this.observedErrors += 1;
      this.lastErrorAtMs = Date.now();
      if (!this.enabled) {
        logger.error(
          { ...context, marker: READ_ONLY_ALERT_MARKER, breakerEnabled: false },
          `${READ_ONLY_ALERT_MARKER}: read-only database write failure observed (breaker disabled)`
        );
        return;
      }
      const wasDegraded = this.state === 'degraded';
      this.state = 'degraded';
      this.trippedAtMs = wasDegraded ? this.trippedAtMs : this.lastErrorAtMs;
      this.degradedUntilMs = this.lastErrorAtMs + this.windowMs;
      if (!wasDegraded) {
        this.tripCount += 1;
        // CRITICAL on the FIRST 25006: contributing factor #7 of the incident
        // was that no alert fired until a player reported frozen matches.
        logger.fatal(
          {
            ...context,
            marker: READ_ONLY_ALERT_MARKER,
            sqlstate: READ_ONLY_SQLSTATE,
            tripCount: this.tripCount,
            degradedForMs: this.windowMs,
          },
          `${READ_ONLY_ALERT_MARKER}: database pool is read-only; entering degraded mode`
        );
      }
    } catch {
      // Never let breaker bookkeeping break the caller's error handling.
    }
  }

  /** True while the process should behave as if the database cannot accept writes. */
  isDegraded(): boolean {
    if (!this.enabled) return false;
    if (this.state !== 'degraded') return false;
    // The window only bounds how long we *wait for a probe*; expiry alone does
    // not clear the latch, because an expired window on a still-poisoned pool
    // would resume matchmaking straight back into failing writes. A successful
    // probe (recordProbeSuccess) is the only exit.
    return true;
  }

  /**
   * Called when a rollback-only write probe COMMITS-worthy succeeds. This is the
   * only path that clears degraded mode.
   */
  recordProbeSuccess(): void {
    if (this.state !== 'degraded') return;
    // Require the trip window to have elapsed before trusting a single probe:
    // during contamination only a SUBSET of pooled backends is poisoned, so a
    // probe can land on a healthy connection while writes still fail elsewhere.
    // Waiting out the window means the probe reflects a settled pool.
    const now = Date.now();
    if (this.degradedUntilMs !== null && now < this.degradedUntilMs) return;
    const degradedMs = this.trippedAtMs === null ? 0 : now - this.trippedAtMs;
    this.state = 'closed';
    this.trippedAtMs = null;
    this.degradedUntilMs = null;
    logger.warn(
      {
        marker: READ_ONLY_ALERT_MARKER,
        degradedMs,
        observedErrors: this.observedErrors,
        tripCount: this.tripCount,
      },
      `${READ_ONLY_ALERT_MARKER}: write probe succeeded; leaving degraded mode`
    );
  }

  /** A failed probe re-arms the window so recovery cannot happen mid-outage. */
  recordProbeFailure(error: unknown): void {
    if (!isReadOnlyTransactionError(error)) return;
    this.recordError(error, { source: 'write_probe' });
  }

  snapshot(): BreakerSnapshot {
    return {
      enabled: this.enabled,
      state: this.enabled ? this.state : 'closed',
      degraded: this.isDegraded(),
      trippedAtMs: this.trippedAtMs,
      degradedUntilMs: this.degradedUntilMs,
      tripCount: this.tripCount,
      observedErrors: this.observedErrors,
      lastErrorAtMs: this.lastErrorAtMs,
    };
  }

  /** Test-only reset. */
  resetForTests(): void {
    this.state = 'closed';
    this.trippedAtMs = null;
    this.degradedUntilMs = null;
    this.tripCount = 0;
    this.observedErrors = 0;
    this.lastErrorAtMs = null;
  }
}

export const readOnlyDbBreaker = new ReadOnlyDbBreaker();

/** Convenience guard for call sites that only need the boolean. */
export function isDbWriteOutage(): boolean {
  return readOnlyDbBreaker.isDegraded();
}

/** Error surfaced to clients for actions we refuse to start during an outage. */
export class DbWriteOutageError extends Error {
  readonly code = 'DB_WRITE_OUTAGE';
  readonly retryable = true;
  constructor(message = 'The service is temporarily unable to save game data. Please try again shortly.') {
    super(message);
    this.name = 'DbWriteOutageError';
  }
}
