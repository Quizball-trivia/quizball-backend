import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { FriendlyAggregate } from './friendly-aggregate.js';
import type { GameplayAggregate } from './gameplay-aggregate.js';

export interface MixedProductAggregate {
  schemaVersion: 1;
  expectedTotalClients: number;
  clients: {
    total: number;
    ranked: number;
    party: number;
  };
  ranked: GameplayAggregate;
  party: FriendlyAggregate;
  verdict: { ok: boolean; violations: string[] };
}

function value(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function aggregateMixedProductReports(
  ranked: GameplayAggregate,
  party: FriendlyAggregate,
  expectedTotalClients: number
): MixedProductAggregate {
  if (!Number.isInteger(expectedTotalClients) || expectedTotalClients <= 0) {
    throw new Error('expectedTotalClients must be a positive integer.');
  }
  const total = ranked.clients + party.clients;
  const violations: string[] = [];
  if (!ranked.verdict.ok) {
    violations.push(`ranked failed: ${ranked.verdict.violations.join('; ') || 'unknown violation'}`);
  }
  if (!party.verdict.ok) {
    violations.push(`party failed: ${party.verdict.violations.join('; ') || 'unknown violation'}`);
  }
  if (total !== expectedTotalClients) {
    violations.push(`total clients ${total}/${expectedTotalClients}`);
  }
  if (!ranked.includeSpendExpected) {
    violations.push('ranked workload did not require economy and daily completion traffic');
  }
  return {
    schemaVersion: 1,
    expectedTotalClients,
    clients: { total, ranked: ranked.clients, party: party.clients },
    ranked,
    party,
    verdict: { ok: violations.length === 0, violations },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const expectedTotalClients = Number(value(argv, 'expected-total-clients'));
  const rankedPath = value(argv, 'ranked');
  const partyPath = value(argv, 'party');
  const reportArg = value(argv, 'report');
  if (!rankedPath || !partyPath || !reportArg) {
    throw new Error(
      'Usage: mixed-product-aggregate.ts --expected-total-clients=N '
      + '--ranked=ranked.json --party=party.json --report=aggregate.json'
    );
  }
  const ranked = JSON.parse(readFileSync(rankedPath, 'utf8')) as GameplayAggregate;
  const party = JSON.parse(readFileSync(partyPath, 'utf8')) as FriendlyAggregate;
  const aggregate = aggregateMixedProductReports(ranked, party, expectedTotalClients);
  const reportPath = isAbsolute(reportArg) ? reportArg : resolve(process.cwd(), reportArg);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(
    `MIXED PRODUCT AGGREGATE: ${aggregate.verdict.ok ? 'PASS' : 'FAIL'} `
    + `${aggregate.clients.total}/${aggregate.expectedTotalClients} clients; `
    + `ranked=${aggregate.ranked.clients}, party=${aggregate.party.clients}`
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
