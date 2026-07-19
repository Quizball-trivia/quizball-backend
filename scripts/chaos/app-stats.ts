export interface AppInstancePeak {
  samples: number;
  healthFailures: number;
  pool: {
    active: number;
    queued: number;
    maxWaitMs: number;
    newRejections: number;
    newTimeouts: number;
  };
  authAdmission: {
    active: number;
    queued: number;
    maxQueued: number;
    maxWaitMs: number;
    newRejections: number;
    newTimeouts: number;
  };
  socketDbTasks: {
    active: number;
    queued: number;
    maxQueued: number;
    maxWaitMs: number;
    newRejections: number;
    newTimeouts: number;
  };
  runtime: {
    cpuPct: number;
    cpuCorePct: number;
    cpuCapacityCores: number;
    eventLoopP99Ms: number;
    eventLoopMaxMs: number;
    rssMb: number;
    heapUsedMb: number;
  };
}

export interface AppStatsSummary {
  intervalMs: number;
  requestFailures: number;
  instances: Record<string, AppInstancePeak>;
}

interface HealthPayload {
  ok?: boolean;
  pool?: {
    active?: number;
    queued?: number;
    maxWaitMs?: number;
    rejections?: number;
    timeouts?: number;
  };
  authAdmission?: {
    active?: number;
    queued?: number;
    maxQueued?: number;
    maxWaitMs?: number;
    rejections?: number;
    timeouts?: number;
  };
  socketDbTasks?: {
    active?: number;
    queued?: number;
    maxQueued?: number;
    maxWaitMs?: number;
    rejections?: number;
    timeouts?: number;
  };
  runtime?: {
    instance?: string;
    cpuPct?: number;
    cpuCorePct?: number;
    cpuCapacityCores?: number;
    eventLoopDelayMs?: { p99?: number; max?: number };
    memoryMb?: { rss?: number; heapUsed?: number };
  };
}

interface InstanceAccumulator {
  peak: AppInstancePeak;
  firstRejections: number;
  lastRejections: number;
  firstTimeouts: number;
  lastTimeouts: number;
  firstAuthRejections: number;
  lastAuthRejections: number;
  firstAuthTimeouts: number;
  lastAuthTimeouts: number;
  firstSocketTaskRejections: number;
  lastSocketTaskRejections: number;
  firstSocketTaskTimeouts: number;
  lastSocketTaskTimeouts: number;
}

export interface AppStatsCollector {
  stop: () => Promise<AppStatsSummary>;
}

/**
 * Poll the real DB readiness endpoint while load is running. After the candidate
 * build is deployed, each response includes its replica id, admission queue,
 * event-loop delay, and memory. Older staging builds remain compatible and are
 * grouped under `unknown` until replaced.
 */
export function startAppStatsCollector(
  apiBase: string,
  bypassToken: string | undefined,
  intervalMs = 1_000
): AppStatsCollector {
  const instances = new Map<string, InstanceAccumulator>();
  let requestFailures = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let activeSample: Promise<void> | null = null;

  const sample = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const headers: Record<string, string> = {};
      if (bypassToken) headers['x-chaos-bypass'] = bypassToken;
      const response = await fetch(`${apiBase}/health/db`, { headers, signal: controller.signal });
      const payload = await response.json() as HealthPayload;
      const key = payload.runtime?.instance ?? 'unknown';
      const rejections = payload.pool?.rejections ?? 0;
      const timeouts = payload.pool?.timeouts ?? 0;
      const authRejections = payload.authAdmission?.rejections ?? 0;
      const authTimeouts = payload.authAdmission?.timeouts ?? 0;
      const socketTaskRejections = payload.socketDbTasks?.rejections ?? 0;
      const socketTaskTimeouts = payload.socketDbTasks?.timeouts ?? 0;
      let accumulator = instances.get(key);
      if (!accumulator) {
        accumulator = {
          firstRejections: rejections,
          lastRejections: rejections,
          firstTimeouts: timeouts,
          lastTimeouts: timeouts,
          firstAuthRejections: authRejections,
          lastAuthRejections: authRejections,
          firstAuthTimeouts: authTimeouts,
          lastAuthTimeouts: authTimeouts,
          firstSocketTaskRejections: socketTaskRejections,
          lastSocketTaskRejections: socketTaskRejections,
          firstSocketTaskTimeouts: socketTaskTimeouts,
          lastSocketTaskTimeouts: socketTaskTimeouts,
          peak: {
            samples: 0,
            healthFailures: 0,
            pool: { active: 0, queued: 0, maxWaitMs: 0, newRejections: 0, newTimeouts: 0 },
            authAdmission: {
              active: 0,
              queued: 0,
              maxQueued: 0,
              maxWaitMs: 0,
              newRejections: 0,
              newTimeouts: 0,
            },
            socketDbTasks: {
              active: 0,
              queued: 0,
              maxQueued: 0,
              maxWaitMs: 0,
              newRejections: 0,
              newTimeouts: 0,
            },
            runtime: {
              cpuPct: 0,
              cpuCorePct: 0,
              cpuCapacityCores: 0,
              eventLoopP99Ms: 0,
              eventLoopMaxMs: 0,
              rssMb: 0,
              heapUsedMb: 0,
            },
          },
        };
        instances.set(key, accumulator);
      }
      accumulator.lastRejections = rejections;
      accumulator.lastTimeouts = timeouts;
      accumulator.lastAuthRejections = authRejections;
      accumulator.lastAuthTimeouts = authTimeouts;
      accumulator.lastSocketTaskRejections = socketTaskRejections;
      accumulator.lastSocketTaskTimeouts = socketTaskTimeouts;
      accumulator.peak.samples += 1;
      if (!response.ok || payload.ok === false) accumulator.peak.healthFailures += 1;
      accumulator.peak.pool.active = Math.max(accumulator.peak.pool.active, payload.pool?.active ?? 0);
      accumulator.peak.pool.queued = Math.max(accumulator.peak.pool.queued, payload.pool?.queued ?? 0);
      accumulator.peak.pool.maxWaitMs = Math.max(accumulator.peak.pool.maxWaitMs, payload.pool?.maxWaitMs ?? 0);
      accumulator.peak.authAdmission.active = Math.max(
        accumulator.peak.authAdmission.active,
        payload.authAdmission?.active ?? 0
      );
      accumulator.peak.authAdmission.queued = Math.max(
        accumulator.peak.authAdmission.queued,
        payload.authAdmission?.queued ?? 0
      );
      accumulator.peak.authAdmission.maxQueued = Math.max(
        accumulator.peak.authAdmission.maxQueued,
        payload.authAdmission?.maxQueued ?? 0
      );
      accumulator.peak.authAdmission.maxWaitMs = Math.max(
        accumulator.peak.authAdmission.maxWaitMs,
        payload.authAdmission?.maxWaitMs ?? 0
      );
      accumulator.peak.socketDbTasks.active = Math.max(
        accumulator.peak.socketDbTasks.active,
        payload.socketDbTasks?.active ?? 0
      );
      accumulator.peak.socketDbTasks.queued = Math.max(
        accumulator.peak.socketDbTasks.queued,
        payload.socketDbTasks?.queued ?? 0
      );
      accumulator.peak.socketDbTasks.maxQueued = Math.max(
        accumulator.peak.socketDbTasks.maxQueued,
        payload.socketDbTasks?.maxQueued ?? 0
      );
      accumulator.peak.socketDbTasks.maxWaitMs = Math.max(
        accumulator.peak.socketDbTasks.maxWaitMs,
        payload.socketDbTasks?.maxWaitMs ?? 0
      );
      accumulator.peak.runtime.cpuPct = Math.max(
        accumulator.peak.runtime.cpuPct,
        payload.runtime?.cpuPct ?? 0
      );
      accumulator.peak.runtime.cpuCorePct = Math.max(
        accumulator.peak.runtime.cpuCorePct,
        payload.runtime?.cpuCorePct ?? 0
      );
      accumulator.peak.runtime.cpuCapacityCores = Math.max(
        accumulator.peak.runtime.cpuCapacityCores,
        payload.runtime?.cpuCapacityCores ?? 0
      );
      accumulator.peak.runtime.eventLoopP99Ms = Math.max(
        accumulator.peak.runtime.eventLoopP99Ms,
        payload.runtime?.eventLoopDelayMs?.p99 ?? 0
      );
      accumulator.peak.runtime.eventLoopMaxMs = Math.max(
        accumulator.peak.runtime.eventLoopMaxMs,
        payload.runtime?.eventLoopDelayMs?.max ?? 0
      );
      accumulator.peak.runtime.rssMb = Math.max(
        accumulator.peak.runtime.rssMb,
        payload.runtime?.memoryMb?.rss ?? 0
      );
      accumulator.peak.runtime.heapUsedMb = Math.max(
        accumulator.peak.runtime.heapUsedMb,
        payload.runtime?.memoryMb?.heapUsed ?? 0
      );
    } catch {
      requestFailures += 1;
    } finally {
      clearTimeout(timeout);
    }
  };

  const loop = async () => {
    if (stopped) return;
    activeSample = sample();
    await activeSample;
    activeSample = null;
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };
  void loop();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (activeSample) await activeSample;
      const output: Record<string, AppInstancePeak> = {};
      for (const [key, accumulator] of instances) {
        accumulator.peak.pool.newRejections = Math.max(
          0,
          accumulator.lastRejections - accumulator.firstRejections
        );
        accumulator.peak.pool.newTimeouts = Math.max(
          0,
          accumulator.lastTimeouts - accumulator.firstTimeouts
        );
        accumulator.peak.authAdmission.newRejections = Math.max(
          0,
          accumulator.lastAuthRejections - accumulator.firstAuthRejections
        );
        accumulator.peak.authAdmission.newTimeouts = Math.max(
          0,
          accumulator.lastAuthTimeouts - accumulator.firstAuthTimeouts
        );
        accumulator.peak.socketDbTasks.newRejections = Math.max(
          0,
          accumulator.lastSocketTaskRejections - accumulator.firstSocketTaskRejections
        );
        accumulator.peak.socketDbTasks.newTimeouts = Math.max(
          0,
          accumulator.lastSocketTaskTimeouts - accumulator.firstSocketTaskTimeouts
        );
        output[key] = accumulator.peak;
      }
      return { intervalMs, requestFailures, instances: output };
    },
  };
}
