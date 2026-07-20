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
    if (this.pending.size === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = new Map(this.pending);
    this.pending.clear();

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

    // Requests may have arrived while the resolver was in flight.
    if (this.pending.size > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delayMs);
      this.timer.unref?.();
    }
  }
}
