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
//   --include-spend also hit ticket/coin-draining routes (daily/complete)
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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CHAOS_ROUTES, SPEND_ROUTES, type ChaosRoute } from './routes.js';
import { ensureTickets, provisionUsers } from './auth.js';
import { runAllRoutes } from './engine.js';
import { summarize, renderTable } from './metrics.js';
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
} from './db-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

interface Args {
  target: 'staging' | 'local';
  rps: number;
  duration: number;
  users: number;
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
  const target = (get('target') ?? 'staging') as 'staging' | 'local';
  const flapStages = parseFlapStages(getAll('flap-stage'));
  return {
    target,
    rps: num('rps', 100),
    duration: num('duration', sockets > 0 ? 300 : 30),
    users: Math.max(0, Math.floor(num('users', 25))),
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

function resolveTarget(args: Args): TargetConfig {
  if (args.target === 'staging') {
    const env = readEnvFile(resolve(REPO_ROOT, '.env'));
    const cfg: TargetConfig = {
      apiBase: args.api ?? 'https://api-staging.quizball.io',
      supabaseUrl: env.SUPABASE_URL ?? '',
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      databaseUrl: args.db ?? env.DATABASE_URL ?? '',
      emailDomain: 'quizball.io',
      bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
    };
    // HARD PROD GUARD: refuse to run if anything points at the prod project.
    const PROD_PROJECT = 'lfbwhxvwubzeqkztghok';
    const blob = `${cfg.apiBase} ${cfg.supabaseUrl} ${cfg.databaseUrl}`;
    if (blob.includes(PROD_PROJECT) || blob.includes('api.quizball.io')) {
      throw new Error(
        'PROD GUARD: target resolves to production. The chaos harness refuses to run against prod. ' +
          'Point --api/--db at staging.'
      );
    }
    if (!cfg.supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
      throw new Error(
        `PROD GUARD: staging SUPABASE_URL expected to be the staging project, got "${cfg.supabaseUrl}". Aborting.`
      );
    }
    return cfg;
  }
  // local
  const env = readEnvFile(resolve(REPO_ROOT, '.env.local'));
  return {
    apiBase: args.api ?? 'http://localhost:3000',
    supabaseUrl: env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: args.db ?? env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54322/postgres',
    emailDomain: 'example.com',
    bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  if (args.sockets > 0) assertSocketTargetSafe(target.apiBase);

  console.log('━'.repeat(72));
  console.log('CHAOS HARNESS');
  console.log(`  target      : ${args.target}  (${target.apiBase})`);
  console.log(`  rps/route   : ${args.rps}`);
  console.log(`  duration    : ${args.duration}s`);
  console.log(`  users       : ${args.users}`);
  console.log(`  include-spend: ${args.includeSpend}`);
  if (args.sockets > 0) {
    console.log(`  sockets     : ${args.sockets}`);
    console.log(`  flap-rate   : ${args.flapRate}`);
    console.log(`  flap-stage  : ${args.flapStages.join(',')}`);
    console.log(`  legacy-protocol: ${args.legacyProtocol}`);
    console.log(`  ramp        : ${args.rampSec}s`);
    if (args.matchesPerClient !== undefined) console.log(`  matches/client: ${args.matchesPerClient}`);
  }
  console.log('━'.repeat(72));

  // 1) Build the route set.
  let routes: ChaosRoute[] = [...CHAOS_ROUTES];
  if (args.includeSpend) routes = routes.concat(SPEND_ROUTES);
  if (args.only) routes = routes.filter((r) => args.only!.includes(r.name));
  if (routes.length === 0) throw new Error('No routes selected.');
  console.log(`Routes under test: ${routes.length}`);
  console.log(`Offered load (peak): ${args.rps * routes.length} req/s total\n`);

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
    users = await provisionUsers({
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      serviceRoleKey: target.serviceRoleKey,
      count: userCount,
      password: 'ChaosTest12345!',
      emailPrefix: 'chaos',
      emailDomain: target.emailDomain,
      concurrency: 10,
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

  // 3) DB stats: reset before.
  const sql = args.dbStats && target.databaseUrl ? makeStatsClient(target.databaseUrl) : null;
  let pgss = false;
  let activityBefore = null;
  if (sql) {
    pgss = await hasPgStatStatements(sql);
    activityBefore = await snapshotActivity(sql);
    if (pgss) {
      await resetStatStatements(sql);
      console.log('pg_stat_statements reset. Live activity before:', activityBefore, '\n');
    } else {
      console.log('pg_stat_statements not available — DB-side stats limited to pg_stat_activity.\n');
    }
  }

  // 4) Sample activity mid-run (peak pressure snapshot).
  let activityPeak = activityBefore;
  let peakTimer: NodeJS.Timeout | null = null;
  if (sql) {
    peakTimer = setInterval(async () => {
      try {
        const snap = await snapshotActivity(sql);
        if (!activityPeak || snap.active > activityPeak.active) activityPeak = snap;
        if (snap.waitingOnLock > 0 || snap.idleInTxn > 2) {
          console.log(
            `  [db] active=${snap.active} idle_in_txn=${snap.idleInTxn} lock_waits=${snap.waitingOnLock} longest=${snap.longestActiveSec}s`
          );
        }
      } catch {
        /* ignore mid-run stat errors */
      }
    }, 1000);
  }

  // 5) Run.
  console.log(socketEnabled ? 'Firing HTTP load + socket fleet…\n' : 'Firing load…\n');
  const httpStart = Date.now();
  const httpPromise = runAllRoutes(routes, {
    apiBase: target.apiBase,
    rps: args.rps,
    durationSec: args.duration,
    users,
    maxInflight: 2000,
    timeoutMs: 15000,
    bypassToken: target.bypassToken,
  }).then((results) => ({
    results,
    elapsedSec: (Date.now() - httpStart) / 1000,
  }));
  const socketPromise = socketEnabled
    ? runSocketFleet({
        apiBase: target.apiBase,
        durationSec: args.duration,
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
  const [{ results, elapsedSec }, socketSummary] = await Promise.all([httpPromise, socketPromise]);
  if (peakTimer) clearInterval(peakTimer);

  // 6) Report.
  const reports = results
    .map((m) => summarize(m, elapsedSec))
    .sort((a, b) => b.p95 - a.p95);
  console.log('\n' + '═'.repeat(72));
  console.log('RESULTS (sorted by p95 latency, slowest first)');
  console.log('═'.repeat(72));
  console.log(renderTable(reports));

  const totalSent = reports.reduce((s, r) => s + r.sent, 0);
  const totalOk = reports.reduce((s, r) => s + r.completed, 0);
  const totalErr = reports.reduce((s, r) => s + (r.errorRatePct / 100) * r.completed, 0);
  console.log('\nTotals:');
  console.log(`  sent=${totalSent}  completed=${totalOk}  effective=${(totalOk / elapsedSec).toFixed(0)} req/s  server-errors≈${Math.round(totalErr)}`);

  if (socketSummary) {
    console.log('\n' + '═'.repeat(72));
    console.log(renderSocketFleetSummary(socketSummary));
    const reportPath = writeSocketReport(socketSummary);
    console.log(`\nSocket JSON report: ${reportPath}`);
  }

  // 7) DB stats after.
  if (sql) {
    const activityAfter = await snapshotActivity(sql);
    console.log('\nDB activity — peak during run:', activityPeak);
    console.log('DB activity — after run     :', activityAfter);
    if (pgss) {
      const top = await topStatements(sql, 20);
      console.log('\n' + '═'.repeat(72));
      console.log('TOP QUERIES BY TOTAL DB TIME (this run)');
      console.log('═'.repeat(72));
      for (const s of top) {
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
      for (const s of top.slice(0, 12)) {
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
    await sql.end();
  }

  console.log('\nDone.');
  if (socketSummary && (
    socketSummary.wrongfulForfeits > 0 ||
    socketSummary.deadSearch > 0 ||
    socketSummary.banRollback > 0 ||
    socketSummary.gateAbandon > 0 ||
    socketSummary.legacyDraftStall > 0 ||
    socketSummary.matchesCompleted === 0
  )) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nCHAOS RUN FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
