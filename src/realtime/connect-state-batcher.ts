import type { SessionStatePayload } from './socket.types.js';

type StateResolver = (
  userIds: string[],
) => Promise<Map<string, SessionStatePayload>>;

type PendingRequest = {
  resolve: (snapshot: SessionStatePayload) => void;
  reject: (error: unknown) => void;
};

/**
 * Coalesces the session-state reads produced by a socket connection burst.
 *
 * A single state lookup already uses batched match + lobby queries. Without
 * this process-local coalescer, 5,000 fresh sockets still execute those two
 * queries independently and overwhelm the application admission queue before
 * any gameplay command runs.
 */
export class ConnectStateBatcher {
  private readonly pending = new Map<string, PendingRequest[]>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly resolver: StateResolver,
    private readonly delayMs = 50,
    private readonly maxBatchSize = 250,
  ) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error('Connect state batch delay must be non-negative');
    }
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new Error('Connect state max batch size must be positive');
    }
  }

  resolve(userId: string): Promise<SessionStatePayload> {
    return new Promise((resolve, reject) => {
      const requests = this.pending.get(userId) ?? [];
      requests.push({ resolve, reject });
      this.pending.set(userId, requests);

      // The active drain loop will pick this request up in its next serialized
      // chunk; it does not need another timer or concurrent flush attempt.
      if (this.flushing) return;
      if (this.pending.size >= this.maxBatchSize) {
        void this.flush();
        return;
      }
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.delayMs);
        this.timer.unref?.();
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      // Deliberately serialize fixed-size chunks. During a mass reconnect,
      // repeatedly starting a new 250-user resolver while the previous one is
      // still in flight would recreate the very DB burst this batcher exists
      // to prevent.
      while (this.pending.size > 0) {
        const entries = [...this.pending.entries()].slice(0, this.maxBatchSize);
        const batch = new Map(entries);
        entries.forEach(([userId]) => this.pending.delete(userId));

        try {
          const snapshots = await this.resolver([...batch.keys()]);
          for (const [userId, requests] of batch) {
            const snapshot = snapshots.get(userId);
            if (!snapshot) {
              const error = new Error(`Connect state resolver omitted user ${userId}`);
              requests.forEach((request) => request.reject(error));
              continue;
            }
            requests.forEach((request) => request.resolve(snapshot));
          }
        } catch (error) {
          for (const requests of batch.values()) {
            requests.forEach((request) => request.reject(error));
          }
        }
      }
    } finally {
      this.flushing = false;
    }

    // Defensive race guard for requests arriving after the loop's final check.
    if (this.pending.size > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delayMs);
      this.timer.unref?.();
    }
  }
}
