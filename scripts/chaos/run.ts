/* eslint-disable no-console */
// Chaos engineering harness — drives every game/API route at a target RPS to
// find where the backend + DB degrade, and surfaces missing-index hot spots via
// pg_stat_statements + EXPLAIN.
//
// Usage:
//   tsx scripts/chaos/run.ts --target=staging --rps=100 --duration=30 --users=25
//   tsx scripts/chaos/run.ts --target=staging --rps=50 --duration=20 --include-spend
//   tsx scripts/chaos/run.ts --target=local --rps=200 --duration=15
//   tsx scripts/chaos/run.ts --target=staging --sockets=5 --duration=300 --rps=50
//
// Flags:
//   --target        staging | local  (PROD IS BLOCKED — see guard)
//   --rps           target requests/sec PER route (default 100)
//   --duration      seconds (default 30; 300 when --sockets > 0)
//   --users         size of the test-user fleet to provision (default 25)
//   --offset        first numeric test-user suffix for distributed shards (default 0)
//   --include-spend also hit bounded economy routes (coin purchase/daily complete)
//   --only          comma list of route names to restrict to
//   --no-db-stats   skip the pg_stat_statements capture
//   --api           override API base URL
//   --db            override Postgres URL (for stats)
//   --sockets       concurrent ranked socket clients (default 0 = off)
//   --flap-rate     average reconnect flaps per socket match (default 0)
//   --flap-stage    search | draft | gate | match; repeatable/comma list (default match)
//   --legacy-protocol  socket clients skip old-mobile-missing UI-ready/reveal acks
//   --ramp-s        seconds to stagger socket queue joins (default 10)
//   --matches-per-client  socket matches per client; overrides duration stop when duration omitted
//   --start-at      synchronized UTC time/epoch for distributed workers (optional)
//   --expect-socket-error  socket error prefix expected from an injected fault; repeatable/comma list

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CHAOS_ROUTES, SPEND_ROUTES, type ChaosRoute } from './routes.js';
import { discoverRouteFixtures } from './fixtures.js';
import { ensureCoinPurchaseFixtures, ensureTickets, provisionUsers } from './auth.js';
import { runAllRoutes, runMixedRoutes } from './engine.js';
import { summarize, renderTable } from './metrics.js';
import { runLoginStorm } from './login-storm.js';
import { startAppStatsCollector, type AppStatsSummary } from './app-stats.js';
import { evaluateChaosRun } from './slo.js';
import {
  assertSocketTargetSafe,
  renderSocketFleetSummary,
  runSocketFleet,
  type FlapStage,
  type SocketFleetSummary,
} from './socket-fleet.js';
import {
  makeStatsClient,
  hasPgStatStatements,
  resetStatStatements,
  topStatements,
  snapshotActivity,
  explainQuery,
  type ActivitySnapshot,
} from './db-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

interface Args {
  target: 'staging' | 'local';
  rps: number;
  duration: number;
  users: number;
  offset: number;
  includeSpend: boolean;
  only: string[] | null;
  dbStats: boolean;
  api?: string;
  db?: string;
  sockets: number;
  flapRate: number;
  flapStages: FlapStage[];
  legacyProtocol: boolean;
  rampSec: number;
  matchesPerClient?: number;
  durationWasExplicit: boolean;
  drainSec: number;
  totalRps?: number;
  loginStorm: boolean;
  loginRampSec: number;
  reportPath?: string;
  startAtMs?: number;
  expectedSocketErrorPrefixes: string[];
}

function parseStartAt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
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
  const getAll = (k: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      if (arg === `--${k}`) {
        values.push(argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : 'true');
      } else if (arg.startsWith(`--${k}=`)) {
        values.push(arg.slice(k.length + 3));
      }
    }
    return values;
  };
  const get = (k: string): string | undefined => {
    const values = getAll(k);
    return values[0];
  };
  const num = (k: string, fallback: number): number => {
    const raw = get(k);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${k} must be a number.`);
    return value;
  };
  const durationWasExplicit = get('duration') !== undefined;
  const sockets = Math.max(0, Math.floor(num('sockets', 0)));
  const matchesPerClientRaw = get('matches-per-client');
  const parsedMatchesPerClient = matchesPerClientRaw === undefined ? undefined : Math.floor(Number(matchesPerClientRaw));
  if (
    matchesPerClientRaw !== undefined
    && (parsedMatchesPerClient === undefined || !Number.isFinite(parsedMatchesPerClient) || parsedMatchesPerClient <= 0)
  ) {
    throw new Error('--matches-per-client must be a positive integer.');
  }
  const targetRaw = get('target') ?? 'staging';
  if (targetRaw !== 'staging' && targetRaw !== 'local') {
    throw new Error('--target must be staging or local. Production is not supported.');
  }
  const target = targetRaw;
  const flapStages = parseFlapStages(getAll('flap-stage'));
  const totalRpsRaw = get('total-rps');
  const totalRps = totalRpsRaw === undefined ? undefined : Number(totalRpsRaw);
  if (totalRps !== undefined && (!Number.isFinite(totalRps) || totalRps <= 0)) {
    throw new Error('--total-rps must be a positive number.');
  }
  const offset = num('offset', 0);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('--offset must be a non-negative integer.');
  }
  return {
    target,
    rps: num('rps', 100),
    duration: num('duration', sockets > 0 ? 300 : 30),
    users: Math.max(0, Math.floor(num('users', 25))),
    offset,
    includeSpend: get('include-spend') === 'true',
    only: get('only') ? get('only')!.split(',').map((s) => s.trim()) : null,
    dbStats: get('no-db-stats') !== 'true',
    api: get('api'),
    db: get('db'),
    sockets,
    flapRate: Math.max(0, num('flap-rate', 0)),
    flapStages,
    legacyProtocol: get('legacy-protocol') === 'true',
    rampSec: Math.max(0, num('ramp-s', 10)),
    matchesPerClient: parsedMatchesPerClient,
    durationWasExplicit,
    // Real penalty matches can run beyond the five-minute HTTP window. Give
    // them time to finish so the load generator does not create false
    // disconnect forfeits while still keeping the run bounded.
    drainSec: Math.max(0, num('drain-s', 360)),
    totalRps,
    loginStorm: get('login-storm') === 'true',
    loginRampSec: Math.max(0, num('login-ramp-s', 60)),
    reportPath: get('report'),
    startAtMs: parseStartAt(get('start-at')),
    expectedSocketErrorPrefixes: getAll('expect-socket-error')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function parseFlapStages(values: string[]): FlapStage[] {
  const raw = values.length > 0 ? values : ['match'];
  const parsed = raw.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const valid = new Set<FlapStage>(['search', 'draft', 'gate', 'match']);
  const out: FlapStage[] = [];
  for (const value of parsed) {
    if (!valid.has(value as FlapStage)) throw new Error(`--flap-stage must be one of search,draft,gate,match; got "${value}".`);
    const stage = value as FlapStage;
    if (!out.includes(stage)) out.push(stage);
  }
  return out.length > 0 ? out : ['match'];
}

function writeSocketReport(summary: SocketFleetSummary): string {
  const dir = resolve(REPO_ROOT, 'scripts/chaos/reports');
  mkdirSync(dir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, '-');
  const path = resolve(dir, `socket-fleet-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  return path;
}

function writeRunReport(pathOverride: string | undefined, report: unknown): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultPath = resolve(REPO_ROOT, 'scripts/chaos/reports', `chaos-run-${stamp}.json`);
  const path = pathOverride
    ? (isAbsolute(pathOverride) ? pathOverride : resolve(REPO_ROOT, pathOverride))
    : defaultPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

// Read a KEY from a dotenv-style file without pulling in a dep.
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

interface TargetConfig {
  apiBase: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
  emailDomain: string;
  bypassToken?: string;
}

function assertNoProductionTarget(cfg: TargetConfig): void {
  const blob = `${cfg.apiBase} ${cfg.supabaseUrl} ${cfg.databaseUrl}`;
  if (blob.includes('lfbwhxvwubzeqkztghok') || blob.includes('api.quizball.io')) {
    throw new Error(
      'PROD GUARD: target resolves to production. The chaos harness refuses to run against prod.'
    );
  }
}

function resolveTarget(args: Args): TargetConfig {
  if (args.target === 'staging') {
    const env = readEnvFile(resolve(REPO_ROOT, '.env'));
    const cfg: TargetConfig = {
      apiBase: args.api ?? 'https://api-staging.quizball.io',
      supabaseUrl: process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '',
      serviceRoleKey:
        process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      databaseUrl: args.db ?? process.env.DATABASE_URL ?? env.DATABASE_URL ?? '',
      emailDomain: 'quizball.io',
      bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
    };
    assertNoProductionTarget(cfg);
    if (!cfg.supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
      throw new Error(
        `PROD GUARD: staging SUPABASE_URL expected to be the staging project, got "${cfg.supabaseUrl}". Aborting.`
      );
    }
    return cfg;
  }
  // local
  const env = readEnvFile(resolve(REPO_ROOT, '.env.local'));
  const localPort = process.env.PORT ?? env.PORT ?? '8000';
  const cfg: TargetConfig = {
    apiBase: args.api ?? process.env.API_BASE_URL ?? env.API_BASE_URL ?? `http://localhost:${localPort}`,
    supabaseUrl: process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl:
      args.db
      ?? process.env.DATABASE_URL
      ?? env.DATABASE_URL
      ?? 'postgresql://postgres:postgres@localhost:54322/postgres',
    emailDomain: 'example.com',
    bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
  };
  // `--target=local --api=<prod>` must not bypass the production guard.
  assertNoProductionTarget(cfg);
  return cfg;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: tsx scripts/chaos/run.ts --target=local|staging [--total-rps=N|--rps=N] [--duration=S] [--users=N] [--sockets=N]');
    console.log('  --expect-socket-error=PREFIX  expected injected-fault socket error prefix; repeat or comma-separate');
    console.log('Production API, database, and Supabase targets are always blocked.');
    return;
  }
  const runStartedAt = new Date().toISOString();
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  if (args.sockets > 0) assertSocketTargetSafe(target.apiBase);

  console.log('━'.repeat(72));
  console.log('CHAOS HARNESS');
  console.log(`  target      : ${args.target}  (${target.apiBase})`);
  if (args.totalRps !== undefined) console.log(`  total HTTP rps: ${args.totalRps} (weighted mix)`);
  else console.log(`  rps/route   : ${args.rps}`);
  console.log(`  duration    : ${args.duration}s`);
  console.log(`  users       : ${args.users}`);
  console.log(`  user shard  : ${args.offset}..${args.offset + Math.max(args.users, args.sockets) - 1}`);
  console.log(`  include-spend: ${args.includeSpend}`);
  if (args.startAtMs) console.log(`  synchronized start: ${new Date(args.startAtMs).toISOString()}`);
  console.log(`  login-storm : ${args.loginStorm}${args.loginStorm ? ` (${args.loginRampSec}s ramp)` : ''}`);
  if (args.sockets > 0) {
    console.log(`  sockets     : ${args.sockets}`);
    console.log(`  flap-rate   : ${args.flapRate}`);
    console.log(`  flap-stage  : ${args.flapStages.join(',')}`);
    console.log(`  legacy-protocol: ${args.legacyProtocol}`);
    console.log(`  ramp        : ${args.rampSec}s`);
    console.log(`  drain       : ${args.drainSec}s max`);
    if (args.matchesPerClient !== undefined) console.log(`  matches/client: ${args.matchesPerClient}`);
  }
  console.log('━'.repeat(72));

  // 1) Build the route set.
  let routes: ChaosRoute[] = [...CHAOS_ROUTES];
  if (args.includeSpend) routes = routes.concat(SPEND_ROUTES);
  if (args.only) routes = routes.filter((r) => args.only!.includes(r.name));
  if (routes.length === 0) throw new Error('No routes selected.');
  console.log(`Routes under test: ${routes.length}`);
  console.log(
    `Offered load (peak): ${args.totalRps ?? args.rps * routes.length} req/s total` +
    `${args.totalRps !== undefined ? ' (weighted production mix)' : ''}\n`
  );

  // 2) Provision the user fleet (needed for any bearer route).
  const socketEnabled = args.sockets > 0;
  const needsAuth = routes.some((r) => r.auth === 'bearer') || socketEnabled;
  let users = [{ email: '', password: '', userId: '', token: '' }];
  if (needsAuth) {
    if (!target.serviceRoleKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY missing — cannot provision auth users.');
    }
    const userCount = Math.max(args.users, args.sockets);
    console.log(`Provisioning ${userCount} confirmed test users…`);
    if (args.target === 'staging') {
      console.log('  → pacing session bootstrap for this load generator\'s single source IP…');
    }
    users = await provisionUsers({
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      serviceRoleKey: target.serviceRoleKey,
      count: userCount,
      startIndex: args.offset,
      password: 'ChaosTest12345!',
      emailPrefix: 'chaos',
      emailDomain: target.emailDomain,
      concurrency: 10,
      // Supabase's /token bucket refills at 1 request per 2 seconds per source
      // IP. Use a little margin so preparation does not fail merely because
      // this fleet comes from one Mac.
      loginIntervalMs: args.target === 'staging' ? 2_200 : 0,
      bypassToken: target.bypassToken,
    });
    console.log(`  → ${users.length} users authenticated.\n`);
    if (users.length === 0) throw new Error('Provisioning produced 0 usable users.');
  }

  if (socketEnabled) {
    const socketUsers = users.slice(0, args.sockets);
    if (socketUsers.length < args.sockets) {
      throw new Error(`Socket fleet needs ${args.sockets} users, got ${socketUsers.length}.`);
    }
    console.log(`Restoring ranked tickets for ${socketUsers.length} socket users…`);
    await ensureTickets({
      target: args.target,
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      databaseUrl: target.databaseUrl,
      userIds: socketUsers.map((u) => u.userId),
      tickets: 5,
    });
    console.log('  → tickets ready.\n');
  }

  if (args.includeSpend) {
    console.log(`Preparing reversible coin-purchase fixtures for ${users.length} test users…`);
    await ensureCoinPurchaseFixtures({
      target: args.target,
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      databaseUrl: target.databaseUrl,
      userIds: users.map((u) => u.userId),
      coins: 20_000,
      productSlug: 'chance_card_5050',
    });
    console.log('  → economy fixtures ready.\n');
  }

  if (users.length < 2 && routes.some((route) => route.name === 'stats.head-to-head')) {
    throw new Error('stats.head-to-head requires at least two distinct load users.');
  }
  console.log('Discovering stable read fixtures…');
  const fixtures = await discoverRouteFixtures(target.apiBase, users[0]!, target.bypassToken);
  console.log('  → category/question/featured fixtures ready.\n');

  // Distributed workers authenticate independently and finish preparation at
  // slightly different times. Park early workers until a shared timestamp so
  // the measured traffic overlaps instead of becoming ten smaller serial runs.
  if (args.startAtMs) {
    const prepareStatsAt = args.startAtMs - 5_000;
    if (Date.now() > args.startAtMs + 5_000) {
      throw new Error(`Missed synchronized start ${new Date(args.startAtMs).toISOString()}.`);
    }
    const waitMs = prepareStatsAt - Date.now();
    if (waitMs > 0) {
      console.log(`Waiting ${(waitMs / 1000).toFixed(1)}s for the distributed start window…`);
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
  }

  // 3) DB stats: reset before.
  const sql = args.dbStats && target.databaseUrl ? makeStatsClient(target.databaseUrl) : null;
  let pgss = false;
  let activityBefore: ActivitySnapshot | null = null;
  const dbStatErrors: string[] = [];
  const activitySamples: Array<{ at: string; snapshot: ActivitySnapshot }> = [];
  if (sql) {
    try {
      pgss = await hasPgStatStatements(sql);
      activityBefore = await snapshotActivity(sql);
      activitySamples.push({ at: new Date().toISOString(), snapshot: activityBefore });
      if (pgss) {
        await resetStatStatements(sql);
        console.log('pg_stat_statements reset. Live activity before:', activityBefore, '\n');
      } else {
        console.log('pg_stat_statements not available — DB-side stats limited to pg_stat_activity.\n');
      }
    } catch (error) {
      const message = `before: ${errorMessage(error)}`;
      dbStatErrors.push(message);
      console.warn(`DB stats unavailable before run (${message}); load will continue.`);
    }
  }

  if (args.startAtMs) {
    const waitMs = args.startAtMs - Date.now();
    if (waitMs < -5_000) {
      throw new Error(`Missed synchronized start ${new Date(args.startAtMs).toISOString()} during DB preparation.`);
    }
    if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  // 4) Sample activity mid-run (peak pressure snapshot).
  let activityPeak = activityBefore;
  let peakTimer: NodeJS.Timeout | null = null;
  let dbSampleInFlight = false;
  if (sql) {
    peakTimer = setInterval(async () => {
      if (dbSampleInFlight) return;
      dbSampleInFlight = true;
      try {
        const snap = await snapshotActivity(sql);
        activitySamples.push({ at: new Date().toISOString(), snapshot: snap });
        activityPeak = mergeActivityPeak(activityPeak, snap);
        if (snap.waitingOnLock > 0 || snap.idleInTxn > 2) {
          console.log(
            `  [db] active=${snap.active} idle_in_txn=${snap.idleInTxn} lock_waits=${snap.waitingOnLock} longest=${snap.longestActiveSec}s`
          );
        }
      } catch {
        /* ignore mid-run stat errors */
      } finally {
        dbSampleInFlight = false;
      }
    }, 1000);
  }

  // 5) Run.
  console.log(socketEnabled ? 'Firing HTTP load + socket fleet…\n' : 'Firing load…\n');
  const httpStart = Date.now();
  const appStatsCollector = startAppStatsCollector(target.apiBase, target.bypassToken);
  const commonEngineConfig = {
    apiBase: target.apiBase,
    rps: args.rps,
    durationSec: args.duration,
    users,
    maxInflight: 2000,
    timeoutMs: 15_000,
    bypassToken: target.bypassToken,
    fixtures,
  };
  const httpRun = args.totalRps !== undefined
    ? runMixedRoutes(routes, {
        ...commonEngineConfig,
        totalRps: args.totalRps,
        rampSec: args.rampSec,
      })
    : runAllRoutes(routes, commonEngineConfig);
  const httpPromise = httpRun.then((results) => ({
    results,
    elapsedSec: (Date.now() - httpStart) / 1000,
  }));
  const loginPromise = args.loginStorm
    ? runLoginStorm({
        apiBase: target.apiBase,
        users,
        rampSec: args.loginRampSec,
        timeoutMs: 15_000,
        bypassToken: target.bypassToken,
      })
    : Promise.resolve([]);
  const socketPromise = socketEnabled
    ? runSocketFleet({
        apiBase: target.apiBase,
        durationSec: args.duration,
        drainSec: args.drainSec,
        durationWasExplicit: args.durationWasExplicit,
        sockets: args.sockets,
        flapRate: args.flapRate,
        flapStages: args.flapStages,
        legacyProtocol: args.legacyProtocol,
        rampSec: args.rampSec,
        matchesPerClient: args.matchesPerClient,
        users: users.slice(0, args.sockets),
      })
    : Promise.resolve<SocketFleetSummary | null>(null);
  const [{ results, elapsedSec }, socketSummary, arrivalMetrics] = await Promise.all([
    httpPromise,
    socketPromise,
    loginPromise,
  ]);
  if (peakTimer) clearInterval(peakTimer);
  const appStats: AppStatsSummary = await appStatsCollector.stop();

  // 6) Report.
  const reports = [...results, ...arrivalMetrics]
    .map((m) => summarize(m, elapsedSec))
    .sort((a, b) => b.p95 - a.p95);
  console.log('\n' + '═'.repeat(72));
  console.log('RESULTS (sorted by p95 latency, slowest first)');
  console.log('═'.repeat(72));
  console.log(renderTable(reports));

  const totalSent = reports.reduce((s, r) => s + r.sent, 0);
  const totalOk = reports.reduce((s, r) => s + r.completed, 0);
  const totalErr = reports.reduce((s, r) => s + (r.errorRatePct / 100) * r.sent, 0);
  console.log('\nTotals:');
  console.log(`  sent=${totalSent}  completed=${totalOk}  effective=${(totalOk / elapsedSec).toFixed(0)} req/s  server-errors≈${Math.round(totalErr)}`);

  if (socketSummary) {
    console.log('\n' + '═'.repeat(72));
    console.log(renderSocketFleetSummary(socketSummary));
    const reportPath = writeSocketReport(socketSummary);
    console.log(`\nSocket JSON report: ${reportPath}`);
  }

  // 7) DB stats after.
  let activityAfter: ActivitySnapshot | null = null;
  let topQueries: Awaited<ReturnType<typeof topStatements>> = [];
  if (sql) {
    try {
      activityAfter = await snapshotActivity(sql);
      activitySamples.push({ at: new Date().toISOString(), snapshot: activityAfter });
      activityPeak = mergeActivityPeak(activityPeak, activityAfter);
      console.log('\nDB activity — peak during run:', activityPeak);
      console.log('DB activity — after run     :', activityAfter);
      if (pgss) {
        topQueries = await topStatements(sql, 20);
      console.log('\n' + '═'.repeat(72));
      console.log('TOP QUERIES BY TOTAL DB TIME (this run)');
      console.log('═'.repeat(72));
      for (const s of topQueries) {
        const q = s.query.replace(/\s+/g, ' ').slice(0, 110);
        console.log(
          `  ${String(s.totalMs).padStart(9)}ms total · ${String(s.calls).padStart(6)} calls · ${String(s.meanMs).padStart(7)}ms mean · ${q}`
        );
      }
      // EXPLAIN the slowest read queries to flag seq scans.
      console.log('\n' + '═'.repeat(72));
      console.log('SEQ-SCAN / MISSING-INDEX CANDIDATES (EXPLAIN on slowest reads)');
      console.log('═'.repeat(72));
      let flagged = 0;
      for (const s of topQueries.slice(0, 12)) {
        const ex = await explainQuery(sql, s.query);
        if (ex?.hasSeqScan) {
          flagged++;
          console.log(`\n  ⚠ Seq Scan (${s.meanMs}ms mean, ${s.calls} calls):`);
          console.log(`    ${s.query.replace(/\s+/g, ' ').slice(0, 160)}`);
          console.log(
            ex.plan
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n')
          );
        }
      }
      if (flagged === 0) {
        console.log('  No seq scans found among EXPLAIN-able slowest reads (parameterized queries skipped).');
      }
      }
    } catch (error) {
      const message = `after: ${errorMessage(error)}`;
      dbStatErrors.push(message);
      console.warn(`DB stats unavailable after run (${message}); report will still be written.`);
    } finally {
      await sql.end().catch((error: unknown) => {
        dbStatErrors.push(`close: ${errorMessage(error)}`);
      });
    }
  }

  const expectedAppInstances = args.target === 'staging' ? 2 : 1;
  const verdict = evaluateChaosRun(
    reports,
    socketSummary,
    activityPeak,
    appStats,
    undefined,
    expectedAppInstances,
    args.expectedSocketErrorPrefixes
  );
  console.log('\n' + '═'.repeat(72));
  console.log(verdict.ok ? 'SLO VERDICT: PASS' : 'SLO VERDICT: FAIL');
  for (const violation of verdict.violations) console.log(`  - ${violation}`);

  const fullReportPath = writeRunReport(args.reportPath, {
    schemaVersion: 1,
    startedAt: runStartedAt,
    endedAt: new Date().toISOString(),
    target: args.target,
    config: {
      users: args.users,
      offset: args.offset,
      durationSec: args.duration,
      totalRps: args.totalRps ?? null,
      rpsPerRoute: args.totalRps === undefined ? args.rps : null,
      sockets: args.sockets,
      rampSec: args.rampSec,
      drainSec: args.drainSec,
      loginStorm: args.loginStorm,
      loginRampSec: args.loginRampSec,
      startAt: args.startAtMs ? new Date(args.startAtMs).toISOString() : null,
      expectedSocketErrorPrefixes: args.expectedSocketErrorPrefixes,
      includeSpend: args.includeSpend,
      flapRate: args.flapRate,
      flapStages: args.flapStages,
    },
    http: {
      elapsedSec,
      totalSent,
      totalCompleted: totalOk,
      approximateServerErrors: Math.round(totalErr),
      routes: reports,
    },
    sockets: socketSummary,
    application: appStats,
    database: {
      before: activityBefore,
      peak: activityPeak,
      after: activityAfter,
      samples: activitySamples,
      topQueries,
      errors: dbStatErrors,
    },
    verdict,
  });
  console.log(`Full JSON report: ${fullReportPath}`);
  console.log('\nDone.');
  if (!verdict.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nCHAOS RUN FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

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
    longestActiveSec: Math.max(current.longestActiveSec, next.longestActiveSec),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
