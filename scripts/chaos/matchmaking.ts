/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { provisionUsers, ensureTickets } from './auth.js';
import { startAppStatsCollector, type AppStatsSummary } from './app-stats.js';
import {
  makeStatsClient,
  snapshotActivity,
  type ActivitySnapshot,
} from './db-stats.js';
import {
  evaluateMatchmakingFleet,
  renderMatchmakingFleet,
  runMatchmakingFleet,
} from './matchmaking-fleet.js';

interface Args {
  target: 'staging' | 'local';
  clients: number;
  offset: number;
  connectRampSec: number;
  joinRampSec: number;
  timeoutSec: number;
  cleanupWaitSec: number;
  maxP95Ms: number;
  api?: string;
  report?: string;
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

function parseArgs(argv: string[]): Args {
  const target = (value(argv, 'target') ?? 'local') as Args['target'];
  if (target !== 'staging' && target !== 'local') {
    throw new Error('--target must be staging or local. Production is blocked.');
  }
  const clients = integer(argv, 'clients', 100, 2);
  if (clients % 2 !== 0) throw new Error('--clients must be even.');
  if (clients > 10_000) throw new Error('--clients cannot exceed 10000 in one worker.');
  return {
    target,
    clients,
    offset: integer(argv, 'offset', 0, 0),
    connectRampSec: integer(argv, 'connect-ramp-s', clients >= 1_000 ? 60 : 10, 0),
    // Connections are established before measurement; compress queue joins
    // into one second so this is a flash-crowd test, not a gentle arrival ramp.
    joinRampSec: integer(argv, 'join-ramp-s', 1, 0),
    timeoutSec: integer(argv, 'timeout-s', 30, 1),
    cleanupWaitSec: integer(argv, 'cleanup-wait-s', 5, 1),
    maxP95Ms: integer(argv, 'max-p95-ms', 8_000, 1),
    api: value(argv, 'api'),
    report: value(argv, 'report'),
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
  const apiBase = args.api
    ?? (args.target === 'staging'
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
  const targetBlob = `${config.apiBase} ${config.supabaseUrl} ${config.databaseUrl}`;
  if (targetBlob.includes('api.quizball.io') || targetBlob.includes('lfbwhxvwubzeqkztghok')) {
    throw new Error('PROD GUARD: matchmaking test resolved to production. Aborting.');
  }
  if (args.target === 'staging' && !config.supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
    throw new Error('PROD GUARD: staging test does not resolve to the staging Supabase project.');
  }
  if (!config.supabaseUrl || !config.serviceRoleKey || !config.databaseUrl) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL are required.');
  }
  if (args.target === 'staging' && !config.bypassToken) {
    throw new Error(
      'CHAOS_BYPASS_TOKEN is required for staging so one load-generator IP does not measure the app limiter.'
    );
  }
  return config;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run chaos:matchmaking -- --target=local|staging --clients=100 [--offset=0]');
    console.log('Production targets are always blocked. Client count must be even.');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  console.log('═'.repeat(72));
  console.log('MATCHMAKING QUEUE-STORM (PRODUCTION BLOCKED)');
  console.log(`target=${args.target} clients=${args.clients} shard=${args.offset}..${args.offset + args.clients - 1}`);
  console.log(`connectRamp=${args.connectRampSec}s joinRamp=${args.joinRampSec}s timeout=${args.timeoutSec}s`);
  console.log('═'.repeat(72));

  console.log(`Provisioning/authenticating ${args.clients} non-production queue users…`);
  const users = await provisionUsers({
    apiBase: target.apiBase,
    supabaseUrl: target.supabaseUrl,
    serviceRoleKey: target.serviceRoleKey,
    count: args.clients,
    startIndex: args.offset,
    password: 'ChaosTest12345!',
    emailPrefix: 'matchmaking',
    emailDomain: target.emailDomain,
    concurrency: 10,
    loginIntervalMs: args.target === 'staging' ? 2_200 : 0,
    bypassToken: target.bypassToken,
  });
  await ensureTickets({
    target: args.target,
    apiBase: target.apiBase,
    supabaseUrl: target.supabaseUrl,
    databaseUrl: target.databaseUrl,
    userIds: users.map((user) => user.userId),
    tickets: 5,
  });

  const sql = makeStatsClient(target.databaseUrl);
  const before = await snapshotActivity(sql);
  let peak: ActivitySnapshot | null = before;
  let sampleInFlight = false;
  const sampler = setInterval(() => {
    if (sampleInFlight) return;
    sampleInFlight = true;
    void snapshotActivity(sql)
      .then((snapshot) => { peak = mergeActivityPeak(peak, snapshot); })
      .catch(() => {})
      .finally(() => { sampleInFlight = false; });
  }, 1_000);
  const appCollector = startAppStatsCollector(target.apiBase, target.bypassToken, 1_000);

  const fleet = await runMatchmakingFleet({
    apiBase: target.apiBase,
    users,
    clients: args.clients,
    connectRampSec: args.connectRampSec,
    joinRampSec: args.joinRampSec,
    matchTimeoutSec: args.timeoutSec,
    cleanupWaitSec: args.cleanupWaitSec,
  });
  clearInterval(sampler);
  while (sampleInFlight) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  const after = await snapshotActivity(sql);
  peak = mergeActivityPeak(peak, after);
  const app = await appCollector.stop();
  await sql.end({ timeout: 5 });

  const fleetVerdict = evaluateMatchmakingFleet(fleet, args.maxP95Ms);
  const infraViolations = evaluateInfrastructure(peak, app, args.target === 'staging' ? 2 : 1);
  const verdict = {
    ok: fleetVerdict.ok && infraViolations.length === 0,
    maxMatchFoundP95Ms: fleetVerdict.maxMatchFoundP95Ms,
    violations: [...fleetVerdict.violations, ...infraViolations],
  };
  const report = {
    schemaVersion: 1,
    target: args.target,
    config: args,
    fleet,
    database: { before, peak, after },
    application: app,
    verdict,
  };
  const defaultPath = resolve(
    process.cwd(),
    'scripts/chaos/reports',
    `matchmaking-${args.target}-${args.clients}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  const reportPath = args.report
    ? (isAbsolute(args.report) ? args.report : resolve(process.cwd(), args.report))
    : defaultPath;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('\n' + renderMatchmakingFleet(fleet));
  console.log(`DB peak=${peak?.total ?? 0}/${peak?.maxConnections ?? 0} (${peak?.utilizationPct ?? 0}%) active=${peak?.active ?? 0} locks=${peak?.waitingOnLock ?? 0}`);
  console.log(`SLO VERDICT: ${verdict.ok ? 'PASS' : 'FAIL'}`);
  for (const violation of verdict.violations) console.log(`  - ${violation}`);
  console.log(`Full JSON report: ${reportPath}`);
  if (!verdict.ok) process.exitCode = 1;
}

function evaluateInfrastructure(
  dbPeak: ActivitySnapshot | null,
  app: AppStatsSummary,
  expectedInstances: number
): string[] {
  const violations: string[] = [];
  if (dbPeak && dbPeak.utilizationPct > 75) {
    violations.push(`DB connections ${dbPeak.utilizationPct}% > 75%`);
  }
  if (app.requestFailures > 0) violations.push(`app telemetry failures: ${app.requestFailures}`);
  const instances = Object.entries(app.instances).filter(([name]) => name !== 'unknown');
  if (instances.length < expectedInstances) {
    violations.push(`app replicas observed ${instances.length}/${expectedInstances}`);
  }
  for (const [name, instance] of instances) {
    if (instance.healthFailures > 0) violations.push(`${name} readiness failures: ${instance.healthFailures}`);
    if (instance.pool.newRejections > 0 || instance.pool.newTimeouts > 0) {
      violations.push(`${name} DB sheds=${instance.pool.newRejections} timeouts=${instance.pool.newTimeouts}`);
    }
    if (instance.pool.maxWaitMs > 1_000) violations.push(`${name} DB wait ${instance.pool.maxWaitMs}ms > 1000ms`);
    if (instance.runtime.eventLoopP99Ms > 100) violations.push(`${name} event-loop p99 ${instance.runtime.eventLoopP99Ms}ms > 100ms`);
    if (instance.runtime.cpuPct > 90) violations.push(`${name} CPU capacity ${instance.runtime.cpuPct}% > 90%`);
  }
  return violations;
}

function mergeActivityPeak(
  current: ActivitySnapshot | null,
  next: ActivitySnapshot
): ActivitySnapshot {
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
    longestActiveSec: Math.max(current.longestActiveSec, next.longestActiveSec),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
