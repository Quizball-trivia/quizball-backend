export interface DbWatchdogOptions {
  probe: () => Promise<unknown>;
  intervalMs: number;
  timeoutMs: number;
  maxFailures: number;
  onFailure: (error: unknown, failures: number, maxFailures: number) => void;
  onRecovery?: (previousFailures: number) => void;
  onFatal: (error: unknown) => void;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`database watchdog timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
}

/** Periodically proves that this process can acquire and use its DB pool. */
export class DbWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private failures = 0;
  private fatal = false;

  constructor(private readonly options: DbWatchdogOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.tickInFlight || this.fatal) return;
    this.tickInFlight = true;
    try {
      await Promise.race([
        this.options.probe(),
        timeoutAfter(this.options.timeoutMs),
      ]);
      if (this.failures > 0) this.options.onRecovery?.(this.failures);
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.options.onFailure(error, this.failures, this.options.maxFailures);
      if (this.failures >= this.options.maxFailures) {
        this.fatal = true;
        this.stop();
        this.options.onFatal(error);
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
