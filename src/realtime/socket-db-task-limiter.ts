export type SocketDbTaskRejectReason = 'queue_full' | 'wait_timeout';

export interface SocketDbTaskStats {
  active: number;
  queued: number;
  limit: number;
  queueLimit: number;
  acquisitions: number;
  queuedAcquisitions: number;
  rejections: number;
  timeouts: number;
  maxQueued: number;
  maxWaitMs: number;
}

export class SocketDbTaskOverloadedError extends Error {
  constructor(readonly reason: SocketDbTaskRejectReason) {
    super(`Socket DB task rejected: ${reason}`);
    this.name = 'SocketDbTaskOverloadedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: SocketDbTaskOverloadedError) => void;
  queuedAt: number;
  timer: NodeJS.Timeout;
  settled: boolean;
}

/**
 * Keeps DB-heavy socket disconnect workflows from all reaching the database
 * bulkhead at once. A mass network flap can produce thousands of lobby and
 * match cleanup callbacks in one event-loop turn; those workflows are safe to
 * run shortly after the disconnect and must not crowd out foreground traffic.
 */
export class SocketDbTaskLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private acquisitions = 0;
  private queuedAcquisitions = 0;
  private rejections = 0;
  private timeouts = 0;
  private maxQueued = 0;
  private maxWaitMs = 0;

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
    private readonly waitTimeoutMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Socket DB task limit must be positive');
    if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new Error('Socket DB task queue limit must be non-negative');
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1) throw new Error('Socket DB task wait timeout must be positive');
  }

  stats(): SocketDbTaskStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      limit: this.limit,
      queueLimit: this.queueLimit,
      acquisitions: this.acquisitions,
      queuedAcquisitions: this.queuedAcquisitions,
      rejections: this.rejections,
      timeouts: this.timeouts,
      maxQueued: this.maxQueued,
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

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      this.acquisitions += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.queueLimit) {
      this.rejections += 1;
      return Promise.reject(new SocketDbTaskOverloadedError('queue_full'));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        queuedAt: performance.now(),
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.rejections += 1;
          this.timeouts += 1;
          reject(new SocketDbTaskOverloadedError('wait_timeout'));
        }, this.waitTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      this.maxQueued = Math.max(this.maxQueued, this.waiters.length);
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
        const waitMs = performance.now() - waiter.queuedAt;
        this.maxWaitMs = Math.max(this.maxWaitMs, waitMs);
        this.acquisitions += 1;
        this.queuedAcquisitions += 1;
        waiter.resolve(this.makeRelease());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

// At most eight cleanup workflows per replica may generate DB work. The queue
// can hold both lobby + match callbacks for a 5k-user fleet with headroom; a
// 30s wait ceiling covers the measured 5k-user teardown while still bounding
// stale cleanup to one disconnect-grace window.
export const socketDbTaskLimiter = new SocketDbTaskLimiter(8, 12_000, 30_000);
