import { Writable } from 'stream';
import { config } from './config.js';

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 100;
const MAX_BUFFER_SIZE = 5000;

type LokiValue = [string, string];

function lokiEnabled(): boolean {
  return Boolean(
    config.GRAFANA_LOKI_URL
    && config.GRAFANA_LOKI_USER
    && config.GRAFANA_LOKI_API_KEY
  );
}

class LokiLogStream extends Writable {
  private buffer: LokiValue[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight = false;

  constructor() {
    super({ decodeStrings: false });

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const trimmed = line.trim();
      if (!trimmed) {
        callback();
        return;
      }

      if (this.buffer.length >= MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }

      this.buffer.push([`${Date.now()}000000`, trimmed]);

      if (this.buffer.length >= MAX_BATCH_SIZE) {
        void this.flush();
      }

      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Failed to buffer log line'));
    }
  }

  async flush(): Promise<void> {
    if (!lokiEnabled() || this.flushInFlight || this.buffer.length === 0) return;
    this.flushInFlight = true;

    const batch = this.buffer.splice(0, MAX_BATCH_SIZE);

    try {
      const response = await fetch(config.GRAFANA_LOKI_URL!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(
            `${config.GRAFANA_LOKI_USER!}:${config.GRAFANA_LOKI_API_KEY!}`
          ).toString('base64')}`,
        },
        body: JSON.stringify({
          streams: [
            {
              stream: {
                service_name: process.env.OTEL_SERVICE_NAME?.trim() || 'quizball-backend',
                deployment_environment: config.NODE_ENV,
                job: config.GRAFANA_LOKI_JOB,
              },
              values: batch,
            },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Loki push failed: ${response.status} ${body}`);
      }
    } catch (error) {
      // Re-queue failed batch at the front, trimming oldest entries if needed.
      this.buffer = [...batch, ...this.buffer].slice(0, MAX_BUFFER_SIZE);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[loki] ${message}\n`);
    } finally {
      this.flushInFlight = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.buffer.length > 0 && !this.flushInFlight) {
      await this.flush();
      if (this.buffer.length > 0) {
        break;
      }
    }
  }
}

let lokiStream: LokiLogStream | null = null;

export function getLokiLogStream(): Writable | null {
  if (!lokiEnabled()) return null;
  if (!lokiStream) {
    lokiStream = new LokiLogStream();
  }
  return lokiStream;
}

export async function shutdownLokiLogStream(): Promise<void> {
  if (!lokiStream) return;
  const stream = lokiStream;
  lokiStream = null;
  await stream.shutdown();
}
