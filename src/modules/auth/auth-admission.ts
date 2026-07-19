import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { RateLimitError } from '../../core/errors.js';

export type AuthAdmissionRejectReason = 'queue_full' | 'wait_timeout';

export interface AuthAdmissionStats {
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

export class AuthOverloadedError extends RateLimitError {
  constructor(readonly reason: AuthAdmissionRejectReason) {
    super('Authentication is busy, please retry shortly', {
      source: 'application_auth_bulkhead',
      reason,
    });
    this.name = 'AuthOverloadedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: AuthOverloadedError) => void;
  queuedAt: number;
  timer: NodeJS.Timeout;
  settled: boolean;
}

/**
 * Bounds concurrent requests to hosted Supabase Auth.
 *
 * Auth operations open their own database transactions outside the API's
 * postgres.js pool. Without a separate bulkhead, a distributed signup/login
 * storm can exhaust the shared Postgres connection budget even though the app
 * pool is correctly capped. Excess requests receive a retryable 429 instead of
 * turning upstream connection exhaustion into a burst of 502 responses.
 */
export class AuthAdmissionController {
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
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Auth admission limit must be positive');
    if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new Error('Auth admission queue limit must be non-negative');
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1) throw new Error('Auth admission wait timeout must be positive');
  }

  stats(): AuthAdmissionStats {
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
      return Promise.reject(new AuthOverloadedError('queue_full'));
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
          reject(new AuthOverloadedError('wait_timeout'));
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
        this.maxWaitMs = Math.max(this.maxWaitMs, performance.now() - waiter.queuedAt);
        this.acquisitions += 1;
        this.queuedAcquisitions += 1;
        waiter.resolve(this.makeRelease());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

// Runtime fallbacks keep unit tests with intentionally partial config mocks
// safe; parsed staging/prod configuration always supplies these defaults.
const authAdmission = new AuthAdmissionController(
  config.AUTH_INFLIGHT_LIMIT ?? 4,
  config.AUTH_QUEUE_LIMIT ?? 16,
  config.AUTH_ACQUIRE_TIMEOUT_MS ?? 2_000,
);

export async function withAuthAdmission<T>(operation: () => PromiseLike<T> | T): Promise<T> {
  try {
    return await authAdmission.run(operation);
  } catch (error) {
    if (error instanceof AuthOverloadedError) {
      const stats = authAdmission.stats();
      if (stats.rejections % 50 === 1) {
        logger.warn({ ...stats, reason: error.reason }, 'Auth admission gate shedding load');
      }
    }
    throw error;
  }
}

export function authAdmissionStats(): AuthAdmissionStats {
  return authAdmission.stats();
}
