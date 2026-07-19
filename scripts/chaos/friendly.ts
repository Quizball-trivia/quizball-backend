/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { provisionUsers } from './auth.js';
import { startAppStatsCollector, type AppStatsSummary } from './app-stats.js';
import { makeStatsClient, snapshotActivity, type ActivitySnapshot } from './db-stats.js';
import { runFriendlyPartyFleet } from './friendly-fleet.js';

interface Args {
  target: 'staging' | 'local';
  clients: number;
  offset: number;
  rampSec: number;
  startAtMs?: number;
  api?: string;
  report?: string;
  dbStats: boolean;
}

interface TargetConfig {
  apiBase: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
  bypassToken?: string;
  emailDomain: string;
}

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? undefined : argv[exact + 1];
  const prefix = `--${key}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function integer(argv: string[], key: string, fallback: number, minimum: number): number {
  const parsed = Number(value(argv, key) ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`--${key} must be an integer >= ${minimum}.`);
  }
  return parsed;
}

function parseStartAt(argv: string[]): number | undefined {
  const raw = value(argv, 'start-at');
  if (!raw) return undefined;
  const numeric = Number(raw);
  const parsed = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    throw new Error('--start-at must be a future ISO timestamp or Unix epoch.');
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const target = (value(argv, 'target') ?? 'local') as Args['target'];
  if (target !== 'staging' && target !== 'local') {
    throw new Error('--target must be staging or local. Production is blocked.');
  }
  const clients = integer(argv, 'clients', 100, 2);
  if (clients % 2 !== 0) throw new Error('--clients must be even.');
  if (clients > 10_000) throw new Error('--clients cannot exceed 10000 per worker.');
  return {
    target,
    clients,
    offset: integer(argv, 'offset', 0, 0),
    rampSec: integer(argv, 'ramp-s', clients >= 1_000 ? 120 : 30, 0),
    startAtMs: parseStartAt(argv),
    api: value(argv, 'api'),
    report: value(argv, 'report'),
    dbStats: !(argv.includes('--no-db-stats') || value(argv, 'no-db-stats') === 'true'),
  };
}

function readEnv(path: string): Record<string, string> {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2]!;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    out[match[1]!] = raw;
  }
  return out;
}

function resolveTarget(args: Args): TargetConfig {
  const env = readEnv(resolve(process.cwd(), args.target === 'staging' ? '.env' : '.env.local'));
  const apiBase = args.api ?? (args.target === 'staging'
    ? 'https://api-staging.quizball.io'
    : `http://127.0.0.1:${process.env.PORT ?? env.PORT ?? '8000'}`);
  const config: TargetConfig = {
    apiBase,
    supabaseUrl: process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL ?? '',
    bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
    emailDomain: args.target === 'staging' ? 'quizball.io' : 'example.com',
  };
  const blob = `${config.apiBase} ${config.supabaseUrl} ${config.databaseUrl}`;
  if (blob.includes('api.quizball.io') || blob.includes('lfbwhxvwubzeqkztghok')) {
    throw new Error('PROD GUARD: friendly fleet resolved to production.');
  }
  if (args.target === 'staging') {
    if (!config.supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')
      || !config.databaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
      throw new Error('PROD GUARD: friendly staging fleet requires staging Supabase and database URLs.');
    }
    if (!config.bypassToken) throw new Error('CHAOS_BYPASS_TOKEN is required on staging.');
  }
  if (!config.supabaseUrl || !config.serviceRoleKey || !config.databaseUrl) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL are required.');
  }
  return config;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: tsx scripts/chaos/friendly.ts --target=local|staging --clients=100 [--offset=0]');
    console.log('Drives real friendly party-quiz lobbies. Production is always blocked.');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  console.log('═'.repeat(72));
  console.log('FRIENDLY PARTY-QUIZ FLEET (PRODUCTION BLOCKED)');
  console.log(`target=${args.target} clients=${args.clients} pairs=${args.clients / 2} shard=${args.offset}..${args.offset + args.clients - 1}`);
  console.log(`ramp=${args.rampSec}s${args.startAtMs ? ` start=${new Date(args.startAtMs).toISOString()}` : ''}`);
  console.log('═'.repeat(72));

  const users = await provisionUsers({
    apiBase: target.apiBase,
    supabaseUrl: target.supabaseUrl,
    serviceRoleKey: target.serviceRoleKey,
    count: args.clients,
    startIndex: args.offset,
    password: 'ChaosTest12345!',
    emailPrefix: 'party',
    emailDomain: target.emailDomain,
    concurrency: args.target === 'local' && args.clients >= 1_000 ? 2 : 10,
    loginIntervalMs: args.target === 'staging' ? 2_200 : 0,
    bypassToken: target.bypassToken,
  });
  if (args.startAtMs) {
    const waitMs = args.startAtMs - Date.now();
    if (waitMs < -5_000) throw new Error(`Missed synchronized start ${new Date(args.startAtMs).toISOString()}.`);
    if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  const sql = args.dbStats ? makeStatsClient(target.databaseUrl) : null;
  const before = sql ? await snapshotActivity(sql) : null;
  let peak = before;
  let sampleInFlight = false;
  const sampler = sql ? setInterval(() => {
    if (sampleInFlight) return;
    sampleInFlight = true;
    void snapshotActivity(sql)
      .then((snapshot) => { peak = mergeActivityPeak(peak, snapshot); })
      .catch(() => {})
      .finally(() => { sampleInFlight = false; });
  }, 1_000) : null;
  const appCollector = startAppStatsCollector(target.apiBase, target.bypassToken, 1_000);
  const fleet = await runFriendlyPartyFleet({
    apiBase: target.apiBase,
    users,
    clients: args.clients,
    rampSec: args.rampSec,
  });
  if (sampler) clearInterval(sampler);
  while (sampleInFlight) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  const after = sql ? await snapshotActivity(sql) : null;
  if (after) peak = mergeActivityPeak(peak, after);
  const app = await appCollector.stop();
  if (sql) await sql.end({ timeout: 5 });

  const violations = evaluate(fleet, peak, app, args.target === 'staging' ? 2 : 1);
  const verdict = { ok: violations.length === 0, violations };
  const report = {
    schemaVersion: 1,
    target: args.target,
    config: args,
    fleet,
    database: { before, peak, after },
    application: app,
    verdict,
  };
  const defaultPath = resolve(process.cwd(), 'scripts/chaos/reports', `friendly-${args.target}-${args.clients}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const reportPath = args.report
    ? (isAbsolute(args.report) ? args.report : resolve(process.cwd(), args.report))
    : defaultPath;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `PARTY VERDICT: ${verdict.ok ? 'PASS' : 'FAIL'} `
    + `${fleet.matchesCompleted}/${fleet.pairs} matches, `
    + `${fleet.clientsReceivingFinalResults}/${fleet.clients} final clients, `
    + `start p95=${fleet.percentiles.lobbyCreateToMatchStartP95}ms`
  );
  for (const violation of violations) console.log(`  - ${violation}`);
  console.log(`Full JSON report: ${reportPath}`);
  if (!verdict.ok) process.exitCode = 1;
}

function evaluate(
  fleet: Awaited<ReturnType<typeof runFriendlyPartyFleet>>,
  dbPeak: ActivitySnapshot | null,
  app: AppStatsSummary,
  expectedInstances: number
): string[] {
  const violations: string[] = [];
  if (fleet.connectedClients !== fleet.clients) violations.push(`connected clients ${fleet.connectedClients}/${fleet.clients}`);
  if (fleet.lobbiesCreated !== fleet.pairs) violations.push(`lobbies created ${fleet.lobbiesCreated}/${fleet.pairs}`);
  if (fleet.joinedPairs !== fleet.pairs) violations.push(`joined pairs ${fleet.joinedPairs}/${fleet.pairs}`);
  if (fleet.matchesStarted !== fleet.pairs) violations.push(`matches started ${fleet.matchesStarted}/${fleet.pairs}`);
  if (fleet.matchesCompleted !== fleet.pairs) violations.push(`matches completed ${fleet.matchesCompleted}/${fleet.pairs}`);
  if (fleet.clientsReceivingFinalResults !== fleet.clients) {
    violations.push(`clients receiving final results ${fleet.clientsReceivingFinalResults}/${fleet.clients}`);
  }
  if (fleet.socketErrors > 0) violations.push(`socket error events ${fleet.socketErrors}`);
  if (fleet.failureCount > 0) violations.push(`friendly pair failures ${fleet.failureCount}`);
  if (dbPeak && dbPeak.utilizationPct > 75) violations.push(`DB connections ${dbPeak.utilizationPct}% > 75%`);
  // Millisecond row-lock handoffs are normal when hundreds of games update
  // shared objective/achievement rows. Fail on a sustained wait, not on the
  // existence of a lock waiter in one 1-second sample.
  if (dbPeak && dbPeak.longestLockWaitSec > 1) {
    violations.push(
      `DB lock wait ${dbPeak.longestLockWaitSec}s > 1s (${dbPeak.waitingOnLock} waiters)`
    );
  }
  if (app.requestFailures > 0) violations.push(`app telemetry failures ${app.requestFailures}`);
  const instances = Object.entries(app.instances).filter(([name]) => name !== 'unknown');
  if (instances.length < expectedInstances) violations.push(`app replicas observed ${instances.length}/${expectedInstances}`);
  for (const [name, instance] of instances) {
    if (instance.healthFailures > 0) violations.push(`${name} readiness failures ${instance.healthFailures}`);
    if (instance.pool.newRejections > 0 || instance.pool.newTimeouts > 0) {
      violations.push(`${name} DB sheds=${instance.pool.newRejections} timeouts=${instance.pool.newTimeouts}`);
    }
    if (instance.socketDbTasks && (instance.socketDbTasks.newRejections > 0 || instance.socketDbTasks.newTimeouts > 0)) {
      violations.push(`${name} socket DB task sheds=${instance.socketDbTasks.newRejections} timeouts=${instance.socketDbTasks.newTimeouts}`);
    }
    if (instance.runtime.eventLoopP99Ms > 100) violations.push(`${name} event-loop p99 ${instance.runtime.eventLoopP99Ms}ms > 100ms`);
    if (instance.runtime.cpuPct > 90) violations.push(`${name} CPU capacity ${instance.runtime.cpuPct}% > 90%`);
  }
  return violations;
}

function mergeActivityPeak(current: ActivitySnapshot | null, next: ActivitySnapshot): ActivitySnapshot {
  if (!current) return next;
  const maxTotal = next.total > current.total ? next : current;
  return {
    total: maxTotal.total,
    maxConnections: maxTotal.maxConnections,
    utilizationPct: maxTotal.utilizationPct,
    active: Math.max(current.active, next.active),
    idle: Math.max(current.idle, next.idle),
    idleInTxn: Math.max(current.idleInTxn, next.idleInTxn),
    waitingOnLock: Math.max(current.waitingOnLock, next.waitingOnLock),
    longestLockWaitSec: Math.max(current.longestLockWaitSec, next.longestLockWaitSec),
    longestActiveSec: Math.max(current.longestActiveSec, next.longestActiveSec),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
