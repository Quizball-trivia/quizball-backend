import { SocketDbTaskLimiter } from './socket-db-task-limiter.js';

/** Share queued work by key; changes during a read get one fresh follow-up read. */
export class KeyedTaskCoalescer {
  private readonly pending = new Map<string, { task: () => Promise<void>; promise: Promise<void> }>();
  private readonly limiter: SocketDbTaskLimiter;

  constructor(concurrency: number, queueLimit: number, waitTimeoutMs: number) {
    this.limiter = new SocketDbTaskLimiter(concurrency, queueLimit, waitTimeoutMs);
  }

  run(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) {
      existing.task = task;
      return existing.promise;
    }
    const entry = { task, promise: Promise.resolve() };
    this.pending.set(key, entry);
    entry.promise = this.limiter.run(async () => {
      for (;;) {
        const current = entry.task;
        try {
          await current();
        } catch (error) {
          // A newer commit arrived during the failed read: send that one instead of dropping it with this error.
          if (entry.task !== current) continue;
          throw error;
        }
        if (entry.task !== current) continue;
        // A new commit must not join an already-finished delivery.
        this.pending.delete(key);
        return;
      }
    }).finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    });
    return entry.promise;
  }
}
