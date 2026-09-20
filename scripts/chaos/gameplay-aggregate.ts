import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

interface HttpRouteReport {
  name: string;
  sent: number;
  completed: number;
  errorRatePct: number;
  p95: number;
  p99: number;
}

interface WorkerReport {
  target: string;
  config: {
    sockets: number;
    totalRps: number | null;
    includeSpend: boolean;
  };
  http: {
    totalSent: number;
    totalCompleted: number;
    approximateServerErrors: number;
    routes: HttpRouteReport[];
  };
  sockets: {
    clients: number;
    matchesStarted: number;
    matchesCompleted: number;
    matchesExpectedToComplete: number;
    failures: unknown[];
    wrongfulForfeits: number;
    deadSearch: number;
    banRollback: number;
    gateAbandon: number;
    legacyDraftStall: number;
    bootStageViolations: unknown[];
    latenciesMs: Record<string, number[]>;
  } | null;
  verdict: { ok: boolean; violations: string[] };
}

interface AggregateRoute {
  name: string;
  sent: number;
  completed: number;
  worstWorkerErrorRatePct: number;
  worstWorkerP95Ms: number;
  worstWorkerP99Ms: number;
}

export interface GameplayAggregate {
  schemaVersion: 1;
  expectedClients: number;
  expectedHttpRps: number;
  includeSpendExpected: boolean;
  workers: number;
  clients: number;
  matchesStarted: number;
  matchesCompleted: number;
  matchesExpectedToComplete: number;
  socketFailures: number;
  wrongfulForfeits: number;
  bootStageViolations: number;
  http: {
    configuredRps: number;
    sent: number;
    completed: number;
    approximateServerErrors: number;
    routes: AggregateRoute[];
  };
  latencyMs: {
    queueJoinToMatchStartP95: number;
    answerToAckP95: number;
  };
  verdict: { ok: boolean; violations: string[] };
}

function value(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function aggregateGameplayReports(
  reports: WorkerReport[],
  expectedClients: number,
  expectedHttpRps: number,
  includeSpendExpected: boolean
): GameplayAggregate {
  if (!Number.isInteger(expectedClients) || expectedClients <= 0 || expectedClients % 2 !== 0) {
    throw new Error('expectedClients must be a positive even integer.');
  }
  if (!Number.isInteger(expectedHttpRps) || expectedHttpRps <= 0) {
    throw new Error('expectedHttpRps must be a positive integer.');
  }

  const violations: string[] = [];
  const routes = new Map<string, AggregateRoute>();
  const queueLatencies: number[] = [];
  const answerLatencies: number[] = [];
  let clients = 0;
  let matchesStarted = 0;
  let matchesCompleted = 0;
  let matchesExpectedToComplete = 0;
  let socketFailures = 0;
  let wrongfulForfeits = 0;
  let bootStageViolations = 0;
  let configuredRps = 0;
  let sent = 0;
  let completed = 0;
  let approximateServerErrors = 0;

  if (reports.length < 2) violations.push(`worker reports ${reports.length}/2 minimum`);
  reports.forEach((report, worker) => {
    if (report.target !== 'staging') violations.push(`worker ${worker} target is ${report.target}`);
    if (!report.verdict.ok) {
      violations.push(`worker ${worker} failed: ${report.verdict.violations.join('; ') || 'unknown violation'}`);
    }
    if (report.config.includeSpend !== includeSpendExpected) {
      violations.push(`worker ${worker} includeSpend=${report.config.includeSpend}`);
    }
    configuredRps += report.config.totalRps ?? 0;
    sent += report.http.totalSent;
    completed += report.http.totalCompleted;
    approximateServerErrors += report.http.approximateServerErrors;

    for (const route of report.http.routes) {
      const current = routes.get(route.name) ?? {
        name: route.name,
        sent: 0,
        completed: 0,
        worstWorkerErrorRatePct: 0,
        worstWorkerP95Ms: 0,
        worstWorkerP99Ms: 0,
      };
      current.sent += route.sent;
      current.completed += route.completed;
      current.worstWorkerErrorRatePct = Math.max(current.worstWorkerErrorRatePct, route.errorRatePct);
      current.worstWorkerP95Ms = Math.max(current.worstWorkerP95Ms, route.p95);
      current.worstWorkerP99Ms = Math.max(current.worstWorkerP99Ms, route.p99);
      routes.set(route.name, current);
    }

    const sockets = report.sockets;
    if (!sockets) {
      violations.push(`worker ${worker} has no socket report`);
      return;
    }
    clients += sockets.clients;
    matchesStarted += sockets.matchesStarted;
    matchesCompleted += sockets.matchesCompleted;
    matchesExpectedToComplete += sockets.matchesExpectedToComplete;
    socketFailures += sockets.failures.length;
    wrongfulForfeits += sockets.wrongfulForfeits;
    bootStageViolations += sockets.bootStageViolations.length
      + sockets.deadSearch
      + sockets.banRollback
      + sockets.gateAbandon
      + sockets.legacyDraftStall;
    queueLatencies.push(...(sockets.latenciesMs.queueJoinToMatchStart ?? []));
    answerLatencies.push(...(sockets.latenciesMs.answerToAck ?? []));
  });

  if (clients !== expectedClients) violations.push(`socket clients ${clients}/${expectedClients}`);
  if (matchesStarted !== expectedClients) violations.push(`matches started ${matchesStarted}/${expectedClients}`);
  if (matchesExpectedToComplete !== expectedClients) {
    violations.push(`matches expected to complete ${matchesExpectedToComplete}/${expectedClients}`);
  }
  if (matchesCompleted !== expectedClients) {
    violations.push(`matches completed ${matchesCompleted}/${expectedClients}`);
  }
  if (socketFailures > 0) violations.push(`socket failures ${socketFailures}`);
  if (wrongfulForfeits > 0) violations.push(`wrongful forfeits ${wrongfulForfeits}`);
  if (bootStageViolations > 0) violations.push(`boot-stage violations ${bootStageViolations}`);
  if (configuredRps !== expectedHttpRps) {
    violations.push(`configured HTTP RPS ${configuredRps}/${expectedHttpRps}`);
  }
  if (completed !== sent) violations.push(`HTTP completed ${completed}/${sent}`);
  if (approximateServerErrors > 0) violations.push(`approximate server errors ${approximateServerErrors}`);

  if (includeSpendExpected) {
    for (const routeName of ['store.purchase.coins', 'daily.complete']) {
      const route = routes.get(routeName);
      if (!route || route.sent === 0) violations.push(`spend route ${routeName} was not exercised`);
    }
  }

  return {
    schemaVersion: 1,
    expectedClients,
    expectedHttpRps,
    includeSpendExpected,
    workers: reports.length,
    clients,
    matchesStarted,
    matchesCompleted,
    matchesExpectedToComplete,
    socketFailures,
    wrongfulForfeits,
    bootStageViolations,
    http: {
      configuredRps,
      sent,
      completed,
      approximateServerErrors,
      routes: [...routes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    latencyMs: {
      queueJoinToMatchStartP95: percentile(queueLatencies, 0.95),
      answerToAckP95: percentile(answerLatencies, 0.95),
    },
    verdict: { ok: violations.length === 0, violations },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const expectedClients = Number(value(argv, 'expected-clients'));
  const expectedHttpRps = Number(value(argv, 'expected-http-rps'));
  const includeSpendExpected = value(argv, 'include-spend') === 'true';
  const reportArg = value(argv, 'report');
  const inputs = argv.filter((arg) => !arg.startsWith('--'));
  if (inputs.length === 0) {
    throw new Error(
      'Usage: gameplay-aggregate.ts --expected-clients=N --expected-http-rps=N '
      + '[--include-spend=true] [--report=path] worker.json...'
    );
  }
  const reports = inputs.map((path) => JSON.parse(readFileSync(path, 'utf8')) as WorkerReport);
  const aggregate = aggregateGameplayReports(
    reports,
    expectedClients,
    expectedHttpRps,
    includeSpendExpected
  );
  const reportPath = reportArg
    ? (isAbsolute(reportArg) ? reportArg : resolve(process.cwd(), reportArg))
    : resolve(process.cwd(), 'scripts/chaos/reports/gameplay-aggregate.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(
    `GAMEPLAY AGGREGATE: ${aggregate.verdict.ok ? 'PASS' : 'FAIL'} `
    + `${aggregate.matchesCompleted}/${aggregate.expectedClients} complete clients, `
    + `${aggregate.http.completed}/${aggregate.http.sent} HTTP, `
    + `queue p95=${aggregate.latencyMs.queueJoinToMatchStartP95}ms`
  );
  for (const violation of aggregate.verdict.violations) console.log(`  - ${violation}`);
  console.log(`Aggregate JSON report: ${reportPath}`);
  if (!aggregate.verdict.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
