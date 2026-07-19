import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  analyzeMatchmakingPairs,
  type MatchmakingFleetSummary,
  type MatchmakingPairObservation,
} from './matchmaking-fleet.js';

interface WorkerReport {
  target: string;
  pairValidation?: string;
  fleet: MatchmakingFleetSummary;
  verdict: { ok: boolean; violations: string[] };
}

export interface MatchmakingAggregate {
  schemaVersion: 1;
  expectedClients: number;
  workers: number;
  clients: number;
  uniqueClients: number;
  connectedClients: number;
  connectionRetries: number;
  searchStartedClients: number;
  humanMatchedClients: number;
  humanPairs: number;
  aiFallbackClients: number;
  unmatchedClients: number;
  duplicateMatchFoundClients: number;
  selfMatchedClients: number;
  invalidPairClients: number;
  duplicateUserIds: string[];
  matchFoundP95Ms: number;
  maxMatchFoundP95Ms: number;
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

export function aggregateMatchmakingReports(
  reports: WorkerReport[],
  expectedClients: number,
  maxMatchFoundP95Ms = 8_000
): MatchmakingAggregate {
  const violations: string[] = [];
  if (expectedClients <= 0 || expectedClients % 2 !== 0) {
    throw new Error('expectedClients must be a positive even integer.');
  }
  if (!Number.isFinite(maxMatchFoundP95Ms) || maxMatchFoundP95Ms <= 0) {
    throw new Error('maxMatchFoundP95Ms must be a positive finite number.');
  }
  if (reports.length < 2) violations.push(`worker reports ${reports.length}/2 minimum`);

  const observations: MatchmakingPairObservation[] = [];
  const latencies: number[] = [];
  const seenUsers = new Set<string>();
  const duplicateUserIds = new Set<string>();
  let clients = 0;
  let connectedClients = 0;
  let connectionRetries = 0;
  let searchStartedClients = 0;
  let unmatchedClients = 0;
  let duplicateMatchFoundClients = 0;

  reports.forEach((report, index) => {
    if (report.target !== 'staging') violations.push(`worker ${index} target is ${report.target}`);
    if (report.pairValidation !== 'deferred_to_aggregate') {
      violations.push(`worker ${index} did not defer cross-worker pair validation`);
    }
    if (!report.verdict.ok) {
      violations.push(`worker ${index} failed: ${report.verdict.violations.join('; ') || 'unknown violation'}`);
    }
    clients += report.fleet.clients;
    connectedClients += report.fleet.connectedClients;
    connectionRetries += report.fleet.connectionRetries ?? 0;
    searchStartedClients += report.fleet.searchStartedClients;
    unmatchedClients += report.fleet.unmatchedClients;
    duplicateMatchFoundClients += report.fleet.duplicateMatchFoundClients;
    latencies.push(...report.fleet.matchFoundLatencyMs);
    for (const observation of report.fleet.pairObservations) {
      if (seenUsers.has(observation.userId)) duplicateUserIds.add(observation.userId);
      seenUsers.add(observation.userId);
      observations.push(observation);
    }
  });

  const pairs = analyzeMatchmakingPairs(observations);
  const p95 = percentile(latencies, 0.95);
  if (clients !== expectedClients) violations.push(`reported clients ${clients}/${expectedClients}`);
  if (observations.length !== expectedClients) {
    violations.push(`pair observations ${observations.length}/${expectedClients}`);
  }
  if (seenUsers.size !== expectedClients) violations.push(`unique clients ${seenUsers.size}/${expectedClients}`);
  if (duplicateUserIds.size > 0) violations.push(`duplicate user ids ${duplicateUserIds.size}`);
  if (connectedClients !== expectedClients) violations.push(`connected clients ${connectedClients}/${expectedClients}`);
  if (searchStartedClients !== expectedClients) {
    violations.push(`queue acknowledgements ${searchStartedClients}/${expectedClients}`);
  }
  if (pairs.humanMatchedClients !== expectedClients) {
    violations.push(`human matches ${pairs.humanMatchedClients}/${expectedClients}`);
  }
  if (pairs.humanPairs !== expectedClients / 2) {
    violations.push(`reciprocal human pairs ${pairs.humanPairs}/${expectedClients / 2}`);
  }
  if (pairs.aiFallbackClients > 0) violations.push(`AI fallback clients ${pairs.aiFallbackClients}`);
  if (unmatchedClients > 0) violations.push(`unmatched clients ${unmatchedClients}`);
  if (duplicateMatchFoundClients > 0) {
    violations.push(`duplicate match_found clients ${duplicateMatchFoundClients}`);
  }
  if (pairs.selfMatchedClients > 0) violations.push(`self-matched clients ${pairs.selfMatchedClients}`);
  if (pairs.invalidUserIds.size > 0) violations.push(`invalid pair clients ${pairs.invalidUserIds.size}`);
  if (p95 > maxMatchFoundP95Ms) {
    violations.push(`match_found p95 ${p95}ms > ${maxMatchFoundP95Ms}ms`);
  }

  return {
    schemaVersion: 1,
    expectedClients,
    workers: reports.length,
    clients,
    uniqueClients: seenUsers.size,
    connectedClients,
    connectionRetries,
    searchStartedClients,
    humanMatchedClients: pairs.humanMatchedClients,
    humanPairs: pairs.humanPairs,
    aiFallbackClients: pairs.aiFallbackClients,
    unmatchedClients,
    duplicateMatchFoundClients,
    selfMatchedClients: pairs.selfMatchedClients,
    invalidPairClients: pairs.invalidUserIds.size,
    duplicateUserIds: [...duplicateUserIds].slice(0, 100),
    matchFoundP95Ms: p95,
    maxMatchFoundP95Ms,
    verdict: { ok: violations.length === 0, violations },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const expectedClients = Number(value(argv, 'expected-clients'));
  const maxP95 = Number(value(argv, 'max-p95-ms') ?? 8_000);
  const reportArg = value(argv, 'report');
  const inputs = argv.filter((arg) => !arg.startsWith('--'));
  if (!Number.isInteger(expectedClients) || expectedClients <= 0 || inputs.length === 0) {
    throw new Error(
      'Usage: matchmaking-aggregate.ts --expected-clients=N [--max-p95-ms=8000] [--report=path] worker.json...'
    );
  }
  const reports = inputs.map((path) => JSON.parse(readFileSync(path, 'utf8')) as WorkerReport);
  const aggregate = aggregateMatchmakingReports(reports, expectedClients, maxP95);
  const reportPath = reportArg
    ? (isAbsolute(reportArg) ? reportArg : resolve(process.cwd(), reportArg))
    : resolve(process.cwd(), 'scripts/chaos/reports/matchmaking-aggregate.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(
    `MATCHMAKING AGGREGATE: ${aggregate.verdict.ok ? 'PASS' : 'FAIL'} ` +
    `${aggregate.humanMatchedClients}/${aggregate.expectedClients} clients, ` +
    `${aggregate.humanPairs}/${aggregate.expectedClients / 2} reciprocal pairs, ` +
    `p95=${aggregate.matchFoundP95Ms}ms`
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
