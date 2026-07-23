export interface SocketRuntimeStats {
  active: number;
  peak: number;
  accepted: number;
}

/** Process-local Socket.IO connection counters exposed through /health/db. */
export class SocketRuntimeTracker {
  private active = 0;
  private peak = 0;
  private accepted = 0;

  connected(): void {
    this.active += 1;
    this.accepted += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  disconnected(): void {
    this.active = Math.max(0, this.active - 1);
  }

  stats(): SocketRuntimeStats {
    return { active: this.active, peak: this.peak, accepted: this.accepted };
  }
}

export const socketRuntimeTracker = new SocketRuntimeTracker();
