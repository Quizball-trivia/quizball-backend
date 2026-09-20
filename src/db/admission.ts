import { AppError, ErrorCode } from '../core/errors.js';

export interface DbAdmissionStats {
  active: number;
  queued: number;
  limit: number;
  queueLimit: number;
  rejections: number;
  timeouts: number;
  acquisitions: number;
  queuedAcquisitions: number;
  averageWaitMs: number;
  maxWaitMs: number;
}

export class DbOverloadedError extends AppError {
  readonly reason: 'queue_full' | 'acquire_timeout';

  constructor(reason: 'queue_full' | 'acquire_timeout') {
    super(
      'Database is busy, please retry shortly',
      503,
      ErrorCode.DB_OVERLOADED,
      { reason }
    );
    this.reason = reason;
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: DbOverloadedError) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
  queuedAt: number;
}

/**
 * Process-local bulkhead in front of postgres.js.
 *
 * postgres.js bounds open sockets with `max`, but its internal wait queue has no
 * acquisition deadline. During an upstream failure that can leave hundreds of
 * application promises waiting for a connection. This gate bounds both the
 * number executing and the number waiting before work reaches the driver.
 */
export class DbAdmissionController {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private rejections = 0;
  private timeouts = 0;
  private acquisitions = 0;
  private queuedAcquisitions = 0;
  private totalWaitMs = 0;
  private maxWaitMs = 0;

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
    private readonly acquireTimeoutMs: number
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('DB admission limit must be a positive integer');
    if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new Error('DB queue limit must be a non-negative integer');
    if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs < 1) throw new Error('DB acquire timeout must be positive');
  }

  stats(): DbAdmissionStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      limit: this.limit,
      queueLimit: this.queueLimit,
      rejections: this.rejections,
      timeouts: this.timeouts,
      acquisitions: this.acquisitions,
      queuedAcquisitions: this.queuedAcquisitions,
      averageWaitMs: this.acquisitions > 0
        ? Math.round((this.totalWaitMs / this.acquisitions) * 10) / 10
        : 0,
      maxWaitMs: Math.round(this.maxWaitMs * 10) / 10,
    };
  }

  async run<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Let the watchdog observe the real pool without waiting behind an ordinary
   * request backlog. A single priority waiter may exceed queueLimit.
   */
  async runPriority<T>(
    operation: () => PromiseLike<T> | T,
    acquireTimeoutMs = this.acquireTimeoutMs,
  ): Promise<T> {
    const release = await this.acquire(true, acquireTimeoutMs);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(priority = false, acquireTimeoutMs = this.acquireTimeoutMs): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      this.recordAcquisition(0, false);
      return Promise.resolve(this.makeRelease());
    }

    if (!priority && this.waiters.length >= this.queueLimit) {
      this.rejections += 1;
      return Promise.reject(new DbOverloadedError('queue_full'));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        queuedAt: performance.now(),
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.rejections += 1;
          this.timeouts += 1;
          reject(new DbOverloadedError('acquire_timeout'));
        }, acquireTimeoutMs),
      };
      waiter.timer.unref?.();
      if (priority) this.waiters.unshift(waiter);
      else this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        if (waiter.settled) continue;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        this.recordAcquisition(performance.now() - waiter.queuedAt, true);
        // The released execution slot transfers directly to this waiter.
        waiter.resolve(this.makeRelease());
        return;
      }

      this.active = Math.max(0, this.active - 1);
    };
  }

  private recordAcquisition(waitMs: number, queued: boolean): void {
    this.acquisitions += 1;
    if (queued) this.queuedAcquisitions += 1;
    this.totalWaitMs += waitMs;
    this.maxWaitMs = Math.max(this.maxWaitMs, waitMs);
  }
}
