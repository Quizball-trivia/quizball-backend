import type { ActivitySnapshot } from './db-stats.js';
import type { RouteReport } from './metrics.js';
import type { SocketFleetSummary } from './socket-fleet.js';
import type { AppStatsSummary } from './app-stats.js';

export interface ChaosSloThresholds {
  maxHttpErrorPct: number;
  maxUnexpectedClientErrorPct: number;
  maxRouteP95Ms: number;
  maxRouteP99Ms: number;
  maxDbConnectionUtilizationPct: number;
  maxDbLockWaiters: number;
  maxDbLongestActiveSec: number;
  maxQueueJoinP95Ms: number;
  maxAppDbWaitMs: number;
  maxEventLoopP99Ms: number;
  maxCpuPct: number;
  maxCpuCorePct: number;
}

export const DEFAULT_CHAOS_SLOS: ChaosSloThresholds = {
  maxHttpErrorPct: 1,
  maxUnexpectedClientErrorPct: 0.1,
  maxRouteP95Ms: 1_500,
  maxRouteP99Ms: 3_000,
  // Preserve at least 20% global headroom for Supabase services, health probes,
  // and reconnect bursts. On the 60-connection staging tier this fails at 49+
  // sessions while allowing the proven 47-session gameplay peak.
  maxDbConnectionUtilizationPct: 80,
  maxDbLockWaiters: 0,
  maxDbLongestActiveSec: 30,
  // A client may remain in search for up to 120s before the harness gives up,
  // but that deadline is not an acceptable latency SLO. Capacity certification
  // uses the same strict queue target as the dedicated matchmaking fleet.
  maxQueueJoinP95Ms: 8_000,
  maxAppDbWaitMs: 1_000,
  maxEventLoopP99Ms: 100,
  maxCpuPct: 90,
  maxCpuCorePct: 90,
};

export interface ChaosVerdict {
  ok: boolean;
  violations: string[];
  thresholds: ChaosSloThresholds;
}

export function evaluateChaosRun(
  routes: RouteReport[],
  socket: SocketFleetSummary | null,
  dbPeak: ActivitySnapshot | null,
  app: AppStatsSummary | null = null,
  thresholds: ChaosSloThresholds = DEFAULT_CHAOS_SLOS,
  expectedAppInstances = 2,
  expectedSocketErrorPrefixes: readonly string[] = []
): ChaosVerdict {
  const violations: string[] = [];
  const totalSent = routes.reduce((sum, route) => sum + route.sent, 0);
  const approximateErrors = routes.reduce(
    (sum, route) => sum + route.sent * route.errorRatePct / 100,
    0
  );
  const totalErrorPct = totalSent > 0 ? approximateErrors * 100 / totalSent : 0;
  if (totalErrorPct > thresholds.maxHttpErrorPct) {
    violations.push(`HTTP error rate ${totalErrorPct.toFixed(2)}% > ${thresholds.maxHttpErrorPct}%`);
  }
  const approximateClientErrors = routes.reduce(
    (sum, route) => sum + route.sent * route.clientErrPct / 100,
    0
  );
  const totalClientErrorPct = totalSent > 0 ? approximateClientErrors * 100 / totalSent : 0;
  if (totalClientErrorPct > thresholds.maxUnexpectedClientErrorPct) {
    violations.push(
      `unexpected HTTP 4xx rate ${totalClientErrorPct.toFixed(2)}% > ${thresholds.maxUnexpectedClientErrorPct}%`
    );
  }

  for (const route of routes.filter((candidate) => candidate.sent >= 10)) {
    if (route.p95 > thresholds.maxRouteP95Ms) {
      violations.push(`${route.name} p95 ${route.p95}ms > ${thresholds.maxRouteP95Ms}ms`);
    }
    if (route.p99 > thresholds.maxRouteP99Ms) {
      violations.push(`${route.name} p99 ${route.p99}ms > ${thresholds.maxRouteP99Ms}ms`);
    }
  }

  if (dbPeak && dbPeak.utilizationPct > thresholds.maxDbConnectionUtilizationPct) {
    violations.push(
      `DB connections ${dbPeak.utilizationPct.toFixed(1)}% (${dbPeak.total}/${dbPeak.maxConnections}) > ${thresholds.maxDbConnectionUtilizationPct}%`
    );
  }
  if (dbPeak && dbPeak.waitingOnLock > thresholds.maxDbLockWaiters) {
    violations.push(
      `DB lock waiters ${dbPeak.waitingOnLock} > ${thresholds.maxDbLockWaiters}`
    );
  }
  if (dbPeak && dbPeak.longestActiveSec > thresholds.maxDbLongestActiveSec) {
    violations.push(
      `DB longest active query ${dbPeak.longestActiveSec.toFixed(1)}s > ${thresholds.maxDbLongestActiveSec}s`
    );
  }

  if (socket) {
    if (socket.matchesPerClient !== undefined) {
      const expectedStarts = socket.clients * socket.matchesPerClient;
      if (socket.matchesStarted < expectedStarts) {
        violations.push(
          `socket match starts: ${socket.matchesStarted}/${expectedStarts} expected `
          + `(${socket.deadlineCutoffs.beforeMatchStart} cut off before match start)`
        );
      }
    }
    if (socket.matchesStarted === 0) violations.push('socket fleet started no matches');
    if (socket.matchesCompleted === 0) violations.push('socket fleet completed no matches');
    if (socket.matchesCompleted < socket.matchesExpectedToComplete) {
      violations.push(
        `incomplete socket matches: ${socket.matchesCompleted}/${socket.matchesExpectedToComplete} eligible `
        + `(${socket.deadlineCutoffs.duringMatch} cut off by test deadline)`
      );
    }
    if (socket.matchesStarted > 0 && socket.latenciesMs.answerToAck.length === 0) {
      violations.push('socket fleet observed no gameplay answer acknowledgements');
    }
    if (socket.matchesStarted > 0 && socket.latenciesMs.roundResultToNextQuestion.length === 0) {
      violations.push('socket fleet observed no completed gameplay rounds');
    }
    if (socket.wrongfulForfeits > 0) violations.push(`wrongful forfeits: ${socket.wrongfulForfeits}`);
    if (socket.deadSearch > 0) violations.push(`dead matchmaking searches: ${socket.deadSearch}`);
    if (socket.banRollback > 0) violations.push(`draft ban rollbacks: ${socket.banRollback}`);
    if (socket.gateAbandon > 0) violations.push(`kickoff gate abandons: ${socket.gateAbandon}`);
    if (socket.legacyDraftStall > 0) violations.push(`legacy draft stalls: ${socket.legacyDraftStall}`);
    const unexpectedSocketErrors = Object.entries(socket.socketErrors)
      .filter(([name]) => (
        !name.startsWith('stage_deadline_')
        && !expectedSocketErrorPrefixes.some((prefix) => name.startsWith(prefix))
      ))
      .reduce((sum, [, count]) => sum + count, 0);
    if (unexpectedSocketErrors > 0) {
      violations.push(`unexpected socket errors: ${unexpectedSocketErrors}`);
    }
    const queueP95 = socket.percentiles.queueJoinToMatchStart.p95;
    if (queueP95 > thresholds.maxQueueJoinP95Ms) {
      violations.push(`matchmaking p95 ${queueP95}ms > ${thresholds.maxQueueJoinP95Ms}ms`);
    }
  }

  if (app) {
    if (app.requestFailures > 0) violations.push(`app telemetry request failures: ${app.requestFailures}`);
    const knownInstances = Object.entries(app.instances).filter(([name]) => name !== 'unknown');
    if (knownInstances.length > 0 && knownInstances.length < expectedAppInstances) {
      violations.push(
        `per-replica telemetry observed only ${knownInstances.length}/${expectedAppInstances} instances`
      );
    }
    for (const [name, instance] of knownInstances) {
      if (instance.healthFailures > 0) {
        violations.push(`${name} DB readiness failures: ${instance.healthFailures}`);
      }
      if (instance.pool.newRejections > 0 || instance.pool.newTimeouts > 0) {
        violations.push(
          `${name} DB admission shed ${instance.pool.newRejections} requests (${instance.pool.newTimeouts} acquisition timeouts)`
        );
      }
      if (
        instance.authAdmission &&
        (instance.authAdmission.newRejections > 0 || instance.authAdmission.newTimeouts > 0)
      ) {
        violations.push(
          `${name} Auth admission shed ${instance.authAdmission.newRejections} requests ` +
          `(${instance.authAdmission.newTimeouts} wait timeouts)`
        );
      }
      if (
        instance.socketDbTasks &&
        (instance.socketDbTasks.newRejections > 0 || instance.socketDbTasks.newTimeouts > 0)
      ) {
        violations.push(
          `${name} socket DB task queue shed ${instance.socketDbTasks.newRejections} workflows ` +
          `(${instance.socketDbTasks.newTimeouts} wait timeouts)`
        );
      }
      if (
        instance.postConnectDbTasks &&
        (instance.postConnectDbTasks.newRejections > 0 || instance.postConnectDbTasks.newTimeouts > 0)
      ) {
        violations.push(
          `${name} post-connect DB task queue shed ${instance.postConnectDbTasks.newRejections} workflows ` +
          `(${instance.postConnectDbTasks.newTimeouts} wait timeouts)`
        );
      }
      if (instance.pool.maxWaitMs > thresholds.maxAppDbWaitMs) {
        violations.push(`${name} DB pool max wait ${instance.pool.maxWaitMs}ms > ${thresholds.maxAppDbWaitMs}ms`);
      }
      if (instance.runtime.eventLoopP99Ms > thresholds.maxEventLoopP99Ms) {
        violations.push(
          `${name} event-loop p99 ${instance.runtime.eventLoopP99Ms}ms > ${thresholds.maxEventLoopP99Ms}ms`
        );
      }
      if (instance.runtime.cpuPct > thresholds.maxCpuPct) {
        violations.push(
          `${name} CPU capacity ${instance.runtime.cpuPct}% > ${thresholds.maxCpuPct}%`
        );
      }
      // process.cpuUsage() includes libuv/worker-thread CPU, so this value can
      // legitimately exceed 100% on a multi-core container without saturating
      // the JavaScript event loop. On multi-core instances the capacity-wide
      // cpuPct and event-loop delay gates above are the authoritative signals.
      if (
        (instance.runtime.cpuCapacityCores ?? 1) <= 1
        && (instance.runtime.cpuCorePct ?? 0) > thresholds.maxCpuCorePct
      ) {
        violations.push(
          `${name} CPU core ${instance.runtime.cpuCorePct}% > ${thresholds.maxCpuCorePct}%`
        );
      }
    }
  }

  return { ok: violations.length === 0, violations, thresholds };
}
