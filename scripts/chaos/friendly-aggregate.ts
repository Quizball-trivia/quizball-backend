import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

interface WorkerReport {
  target: string;
  fleet: {
    clients: number;
    pairs: number;
    connectedClients: number;
    lobbiesCreated: number;
    joinedPairs: number;
    matchesStarted: number;
    matchesCompleted: number;
    clientsReceivingFinalResults: number;
    socketErrors: number;
    failureCount?: number;
    failures: unknown[];
    latenciesMs: {
      connectToLobbyReady: number[];
      lobbyCreateToMatchStart: number[];
      matchStartToFinalResults: number[];
    };
  };
  verdict: { ok: boolean; violations: string[] };
}

export interface FriendlyAggregate {
  schemaVersion: 1;
  expectedClients: number;
  workers: number;
  clients: number;
  pairs: number;
  connectedClients: number;
  lobbiesCreated: number;
  joinedPairs: number;
  matchesStarted: number;
  matchesCompleted: number;
  clientsReceivingFinalResults: number;
  socketErrors: number;
  pairFailures: number;
  latencyMs: {
    connectToLobbyReadyP95: number;
    lobbyCreateToMatchStartP95: number;
    matchStartToFinalResultsP95: number;
  };
  verdict: { ok: boolean; violations: string[] };
}

function value(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function aggregateFriendlyReports(
  reports: WorkerReport[],
  expectedClients: number
): FriendlyAggregate {
  if (!Number.isInteger(expectedClients) || expectedClients <= 0 || expectedClients % 2 !== 0) {
    throw new Error('expectedClients must be a positive even integer.');
  }
  const totals = {
    clients: 0,
    pairs: 0,
    connectedClients: 0,
    lobbiesCreated: 0,
    joinedPairs: 0,
    matchesStarted: 0,
    matchesCompleted: 0,
    clientsReceivingFinalResults: 0,
    socketErrors: 0,
    pairFailures: 0,
  };
  const connect: number[] = [];
  const start: number[] = [];
  const finish: number[] = [];
  const violations: string[] = [];
  if (reports.length < 2) violations.push(`worker reports ${reports.length}/2 minimum`);
  reports.forEach((report, worker) => {
    if (report.target !== 'staging') violations.push(`worker ${worker} target is ${report.target}`);
    if (!report.verdict.ok) {
      violations.push(`worker ${worker} failed: ${report.verdict.violations.join('; ') || 'unknown violation'}`);
    }
    const fleet = report.fleet;
    totals.clients += fleet.clients;
    totals.pairs += fleet.pairs;
    totals.connectedClients += fleet.connectedClients;
    totals.lobbiesCreated += fleet.lobbiesCreated;
    totals.joinedPairs += fleet.joinedPairs;
    totals.matchesStarted += fleet.matchesStarted;
    totals.matchesCompleted += fleet.matchesCompleted;
    totals.clientsReceivingFinalResults += fleet.clientsReceivingFinalResults;
    totals.socketErrors += fleet.socketErrors;
    totals.pairFailures += fleet.failureCount ?? fleet.failures.length;
    connect.push(...fleet.latenciesMs.connectToLobbyReady);
    start.push(...fleet.latenciesMs.lobbyCreateToMatchStart);
    finish.push(...fleet.latenciesMs.matchStartToFinalResults);
  });
  const expectedPairs = expectedClients / 2;
  if (totals.clients !== expectedClients) violations.push(`clients ${totals.clients}/${expectedClients}`);
  if (totals.connectedClients !== expectedClients) violations.push(`connected ${totals.connectedClients}/${expectedClients}`);
  if (totals.pairs !== expectedPairs) violations.push(`pairs ${totals.pairs}/${expectedPairs}`);
  for (const key of ['lobbiesCreated', 'joinedPairs', 'matchesStarted', 'matchesCompleted'] as const) {
    if (totals[key] !== expectedPairs) violations.push(`${key} ${totals[key]}/${expectedPairs}`);
  }
  if (totals.clientsReceivingFinalResults !== expectedClients) {
    violations.push(`final clients ${totals.clientsReceivingFinalResults}/${expectedClients}`);
  }
  if (totals.socketErrors > 0) violations.push(`socket errors ${totals.socketErrors}`);
  if (totals.pairFailures > 0) violations.push(`pair failures ${totals.pairFailures}`);
  return {
    schemaVersion: 1,
    expectedClients,
    workers: reports.length,
    ...totals,
    latencyMs: {
      connectToLobbyReadyP95: percentile(connect, 0.95),
      lobbyCreateToMatchStartP95: percentile(start, 0.95),
      matchStartToFinalResultsP95: percentile(finish, 0.95),
    },
    verdict: { ok: violations.length === 0, violations },
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function main(): void {
  const argv = process.argv.slice(2);
  const expectedClients = Number(value(argv, 'expected-clients'));
  const reportArg = value(argv, 'report');
  const inputs = argv.filter((argument) => !argument.startsWith('--'));
  if (inputs.length === 0) {
    throw new Error('Usage: friendly-aggregate.ts --expected-clients=N [--report=path] worker.json...');
  }
  const reports = inputs.map((path) => JSON.parse(readFileSync(path, 'utf8')) as WorkerReport);
  const aggregate = aggregateFriendlyReports(reports, expectedClients);
  const reportPath = reportArg
    ? (isAbsolute(reportArg) ? reportArg : resolve(process.cwd(), reportArg))
    : resolve(process.cwd(), 'scripts/chaos/reports/friendly-aggregate.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(
    `PARTY AGGREGATE: ${aggregate.verdict.ok ? 'PASS' : 'FAIL'} `
    + `${aggregate.matchesCompleted}/${aggregate.pairs} matches, `
    + `${aggregate.clientsReceivingFinalResults}/${aggregate.clients} final clients, `
    + `start p95=${aggregate.latencyMs.lobbyCreateToMatchStartP95}ms`
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
