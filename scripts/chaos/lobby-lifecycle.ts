/* eslint-disable no-console */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { ChaosLoginError, ensureChaosUsers, ensureTickets, loginChaosUser, type ChaosUser } from './auth.js';
import { startAppStatsCollector, type AppStatsSummary } from './app-stats.js';
import {
  runLobbyLifecycleFleet,
  SCENARIOS,
  socketlessUsers,
  type LobbyFleetSummary,
  type ScenarioKind,
} from './lobby-lifecycle-fleet.js';
import {
  ageLobby,
  checkLobbyInvariants,
  resetLobbyFixtures,
  type LobbyInvariantReport,
} from './lobby-lifecycle-invariants.js';

/**
 * Lobby-lifecycle chaos runner. Drives N real socket clients through the
 * abandon / disconnect / reload / start-and-vanish storylines, optionally
 * kills and restarts the backend mid-run (local only — that is how the
 * 15s disconnect-grace timers get lost in production deploys), then asks
 * the database what was left behind and whether every player can still
 * press Play Ranked.
 *
 *   npm run chaos:lobby -- --target=local --clients=20 --env-file=.env.harness --manage-backend
 *   npm run chaos:lobby -- --target=local --clients=500 --env-file=.env.harness --manage-backend --restart-at-s=90,240
 *   npm run chaos:lobby -- --target=staging --clients=100
 */
interface Args {
  target: 'staging' | 'local';
  clients: number;
  offset: number;
  concurrency: number;
  rampSec: number;
  graceWaitMs: number;
  loginIntervalMs: number;
  scenarios?: ScenarioKind[];
  seed: number;
  envFile?: string;
  api?: string;
  report?: string;
  manageBackend: boolean;
  backendCmd: string;
  restartAtSec: number[];
  restartSignal: NodeJS.Signals;
  /** abandon_then_restart storyline may restart the backend (local only). */
  scenarioRestarts: number;
  /** backdate abandoned lobbies by N minutes before the ranked probe (0 = off). */
  ageStrandedMin: number;
}

interface TargetConfig {
  apiBase: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
  bypassToken?: string;
  emailDomain: string;
  env: Record<string, string>;
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
  const clients = integer(argv, 'clients', 20, 1);
  if (clients > 5_000) throw new Error('--clients cannot exceed 5000 per worker.');
  const scenariosRaw = value(argv, 'scenarios');
  const scenarios = scenariosRaw
    ? scenariosRaw.split(',').map((kind) => kind.trim()).filter(Boolean) as ScenarioKind[]
    : undefined;
  if (scenarios) {
    const known = new Set(SCENARIOS.map((spec) => spec.kind));
    for (const kind of scenarios) {
      if (!known.has(kind)) throw new Error(`Unknown scenario "${kind}". Known: ${[...known].join(', ')}`);
    }
  }
  const restartRaw = value(argv, 'restart-at-s');
  const restartAtSec = restartRaw
    ? restartRaw.split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const manageBackend = argv.includes('--manage-backend');
  const scenarioRestarts = integer(argv, 'scenario-restarts', 0, 0);
  if ((restartAtSec.length > 0 || scenarioRestarts > 0) && !manageBackend) {
    throw new Error('--restart-at-s / --scenario-restarts require --manage-backend (the harness must own the process it kills).');
  }
  if (manageBackend && target !== 'local') {
    throw new Error('--manage-backend is local-only.');
  }
  const restartSignal = (value(argv, 'restart-signal') ?? 'SIGKILL') as NodeJS.Signals;
  if (restartSignal !== 'SIGKILL' && restartSignal !== 'SIGTERM') {
    throw new Error('--restart-signal must be SIGKILL (crash) or SIGTERM (deploy).');
  }
  return {
    target,
    clients,
    offset: integer(argv, 'offset', 0, 0),
    concurrency: integer(argv, 'concurrency', target === 'local' ? 40 : 25, 1),
    rampSec: integer(argv, 'ramp-s', clients >= 200 ? 60 : 10, 0),
    // 15s server grace + limiter slack. Below ~18s the harness measures its
    // own impatience instead of the server's cleanup.
    graceWaitMs: integer(argv, 'grace-wait-ms', 22_000, 16_000),
    // Supabase Auth throttles password logins per IP; ~27/min stays under it.
    loginIntervalMs: integer(argv, 'login-interval-ms', clients > 20 ? 2_200 : 0, 0),
    scenarios,
    seed: integer(argv, 'seed', 1337, 0),
    envFile: value(argv, 'env-file'),
    api: value(argv, 'api'),
    report: value(argv, 'report'),
    manageBackend,
    backendCmd: value(argv, 'backend-cmd') ?? 'node_modules/.bin/tsx src/bootstrap.ts',
    restartAtSec,
    restartSignal,
    scenarioRestarts,
    ageStrandedMin: integer(argv, 'age-stranded-min', 0, 0),
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
  const envPath = resolve(process.cwd(), args.envFile ?? (args.target === 'staging' ? '.env' : '.env.local'));
  const env = readEnv(envPath);
  if (Object.keys(env).length === 0) throw new Error(`No env vars read from ${envPath}.`);
  const port = env.PORT ?? process.env.PORT ?? '8000';
  const apiBase = args.api ?? (args.target === 'staging'
    ? 'https://api-staging.quizball.io'
    : `http://127.0.0.1:${port}`);
  const config: TargetConfig = {
    apiBase,
    supabaseUrl: env.SUPABASE_URL ?? '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    bypassToken: env.CHAOS_BYPASS_TOKEN ?? process.env.CHAOS_BYPASS_TOKEN,
    emailDomain: args.target === 'staging' ? 'quizball.io' : 'example.com',
    env,
  };
  const blob = `${config.apiBase} ${config.supabaseUrl} ${config.databaseUrl}`;
  if (blob.includes('api.quizball.io') || blob.includes('lfbwhxvwubzeqkztghok')) {
    throw new Error('PROD GUARD: lobby-lifecycle fleet resolved to production.');
  }
  if (args.target === 'staging') {
    if (!config.databaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) {
      throw new Error('PROD GUARD: staging run requires the staging database URL.');
    }
    if (!config.bypassToken) throw new Error('CHAOS_BYPASS_TOKEN is required on staging.');
  } else if (!/@(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(config.databaseUrl)) {
    // Running "local" against the staging database is the trap that produced
    // phantom presence forfeits before (staging sweepers vs local Redis).
    throw new Error(`Local target requires a localhost DATABASE_URL in ${envPath}, got a remote one.`);
  }
  if (!config.supabaseUrl || !config.serviceRoleKey || !config.databaseUrl) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL are required.');
  }
  return config;
}

const TOKEN_CACHE_MAX_AGE_MS = 45 * 60 * 1_000;

/**
 * Supabase Auth rate-limits password logins per source IP, and every harness
 * login funnels through one IP. Pace the logins and keep the access tokens
 * (valid for an hour) so a re-run with the same shard costs nothing.
 */
async function provisionWithTokenCache(args: Args, target: TargetConfig): Promise<ChaosUser[]> {
  const cachePath = resolve(process.cwd(), 'scripts/chaos/reports', `.lobby-tokens-${args.target}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  let cache: Record<string, { userId: string; token: string; at: number }> = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8')) as typeof cache;
  } catch {
    cache = {};
  }
  const cfg = {
    apiBase: target.apiBase,
    supabaseUrl: target.supabaseUrl,
    serviceRoleKey: target.serviceRoleKey,
    count: args.clients,
    startIndex: args.offset,
    password: 'ChaosTest12345!',
    emailPrefix: 'lobby',
    emailDomain: target.emailDomain,
    concurrency: 10,
    bypassToken: target.bypassToken,
  };
  const wantedEmails = Array.from(
    { length: cfg.count },
    (_, i) => `${cfg.emailPrefix}+u${cfg.startIndex + i}@${cfg.emailDomain}`,
  );
  // ensureChaosUsers resets every account's password, which invalidates the
  // sessions behind cached tokens (introspection then 403s). So the cache is
  // all-or-nothing: reuse it only when it covers the whole shard and a sample
  // token still authenticates; otherwise re-provision and re-login everyone.
  const freshCached = wantedEmails.filter((email) => {
    const cached = cache[email];
    return cached && Date.now() - cached.at < TOKEN_CACHE_MAX_AGE_MS;
  });
  const cacheCoversShard = freshCached.length === wantedEmails.length;
  let useCache = false;
  // Partial cache (a run that died mid-login): the accounts already exist with
  // the known password, so log in only the missing ones instead of resetting
  // every password (which would invalidate the sessions behind the cache).
  const partialResume = !cacheCoversShard && freshCached.length > 0;
  if (cacheCoversShard) {
    // Every token is checked, not a sample: one revoked session among 500
    // would otherwise surface as a mysterious socket auth failure mid-run.
    const tokenOk = async (token: string): Promise<boolean> => {
      const res = await fetch(`${target.apiBase}/api/v1/users/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(target.bypassToken ? { 'x-chaos-bypass': target.bypassToken } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      return Boolean(res?.ok);
    };
    let checked = 0;
    let valid = 0;
    const queue = [...wantedEmails];
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (queue.length > 0) {
        const email = queue.shift()!;
        checked++;
        if (await tokenOk(cache[email]!.token)) valid++;
      }
    }));
    useCache = valid === checked;
    if (!useCache) console.log(`token cache: ${checked - valid}/${checked} tokens no longer authenticate; re-provisioning`);
  }
  const emails = useCache || partialResume ? wantedEmails : await ensureChaosUsers(cfg);
  if (!useCache && !partialResume) cache = {};
  if (partialResume) console.log(`token cache: resuming, ${freshCached.length}/${wantedEmails.length} cached`);
  const users: ChaosUser[] = [];
  let fresh = 0;
  let nextLoginAt = Date.now();
  for (const email of emails) {
    const cached = cache[email];
    if ((useCache || partialResume) && cached && Date.now() - cached.at < TOKEN_CACHE_MAX_AGE_MS) {
      users.push({ email, password: cfg.password, userId: cached.userId, token: cached.token });
      continue;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const waitMs = nextLoginAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      nextLoginAt = Date.now() + args.loginIntervalMs;
      try {
        const { token, userId } = await loginChaosUser(cfg, email);
        cache[email] = { userId, token, at: Date.now() };
        users.push({ email, password: cfg.password, userId, token });
        fresh++;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const status = error instanceof ChaosLoginError ? error.status : 0;
        if (status !== 429 && !(error instanceof ChaosLoginError && error.retryable)) throw error;
        // 429 = the auth rate limiter; back off hard instead of hammering it.
        // Transport errors (staging blips) get a growing but bounded wait.
        const backoffMs = status === 429 ? 30_000 * (attempt + 1) : Math.min(30_000, 2_000 * (attempt + 1));
        console.log(`login ${email} got ${status || 'transport error'}; backing off ${backoffMs / 1000}s`);
        await sleep(backoffMs);
      }
    }
    if (lastError) throw lastError;
    if (fresh % 25 === 0) writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  }
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  console.log(`tokens: ${users.length - fresh} cached, ${fresh} fresh logins`);
  return users;
}

interface ManagedBackend {
  restarts: Array<{ atSec: number; signal: string; downMs: number; reason: string }>;
  failures: Array<{ atSec: number; error: string }>;
  /** every restart that was actually started (succeeded or failed) */
  attempts: number;
  restart: (atSec: number, reason: string) => Promise<void>;
  /** resolves once every in-flight restart has settled */
  settle: () => Promise<void>;
  stop: () => Promise<void>;
}

async function waitHealthy(apiBase: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function startManagedBackend(args: Args, target: TargetConfig): Promise<ManagedBackend> {
  if (await waitHealthy(target.apiBase, 1_000)) {
    throw new Error(`${target.apiBase} already answers /health — stop that process, the harness must own the backend it restarts.`);
  }
  const [cmd, ...cmdArgs] = args.backendCmd.split(/\s+/);
  const logPath = resolve(process.cwd(), 'scripts/chaos/reports',
    `lobby-lifecycle-backend-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  console.log(`managed backend log: ${logPath}`);
  let child: ChildProcess | null = null;
  const launch = async (): Promise<void> => {
    // Own process group: `tsx` forks the real node server, and a signal to
    // the wrapper alone orphans it on the port (EADDRINUSE on relaunch).
    child = spawn(cmd!, cmdArgs, {
      cwd: process.cwd(),
      env: { ...process.env, ...target.env },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    const proc = child;
    proc.on('exit', (code, signal) => {
      if (proc === child) console.log(`backend exited code=${code} signal=${signal}`);
    });
    if (!(await waitHealthy(target.apiBase, 90_000))) {
      throw new Error(`backend did not become healthy at ${target.apiBase}`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`backend child exited (code ${proc.exitCode}) although ${target.apiBase} answers /health — another process owns the port`);
    }
  };
  const signalGroup = (proc: ChildProcess, signal: NodeJS.Signals): void => {
    if (!proc.pid) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  };
  const killCurrent = async (signal: NodeJS.Signals): Promise<void> => {
    const proc = child;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolveExit) => {
      proc.once('exit', () => resolveExit());
      signalGroup(proc, signal);
      setTimeout(() => { if (proc.exitCode === null) signalGroup(proc, 'SIGKILL'); }, 10_000).unref();
    });
    // The wrapper exits first; wait until nothing answers on the port so the
    // relaunch is a real restart rather than a probe of the dying server.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await waitHealthy(target.apiBase, 300)) await sleep(200);
  };
  await launch();
  const restarts: ManagedBackend['restarts'] = [];
  const failures: ManagedBackend['failures'] = [];
  let attempts = 0;
  let restartChain: Promise<void> = Promise.resolve();
  return {
    restarts,
    failures,
    get attempts() { return attempts; },
    // Serialized: two overlapping restarts would race each other for the port.
    restart: (atSec, reason) => {
      const run = restartChain.then(async () => {
        attempts++;
        const downAt = Date.now();
        console.log(`[chaos] ${args.restartSignal} backend at t+${atSec}s (${reason})`);
        try {
          await killCurrent(args.restartSignal);
          await launch();
        } catch (error) {
          failures.push({ atSec, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        const downMs = Date.now() - downAt;
        restarts.push({ atSec, signal: args.restartSignal, downMs, reason });
        console.log(`[chaos] backend back after ${downMs}ms`);
      });
      restartChain = run.catch(() => undefined);
      return run;
    },
    settle: () => restartChain,
    // Also chained: stopping in the middle of a relaunch would leave the new
    // detached child running on the port after the harness exits.
    stop: () => {
      const run = restartChain.then(() => killCurrent('SIGTERM'));
      restartChain = run.catch(() => undefined);
      return run;
    },
  };
}

function evaluate(
  fleet: LobbyFleetSummary,
  invariants: LobbyInvariantReport,
  app: AppStatsSummary | null,
): string[] {
  const violations: string[] = [];
  if (fleet.scenariosFailed > 0) violations.push(`scenario failures ${fleet.scenariosFailed}/${fleet.scenariosPlanned}`);
  if (fleet.rankedProbe.ok !== fleet.rankedProbe.total) {
    violations.push(`ranked probe blocked ${fleet.rankedProbe.total - fleet.rankedProbe.ok}/${fleet.rankedProbe.total}`);
  }
  if (fleet.rankedProbe.lobbyBlocks.length > 0) {
    violations.push(`${fleet.rankedProbe.lobbyBlocks.length} players blocked from ranked by a lobby they had left`);
  }
  violations.push(...invariants.violations);
  if (app) {
    for (const [name, instance] of Object.entries(app.instances)) {
      if (name === 'unknown') continue;
      if (instance.socketDbTasks && (instance.socketDbTasks.newRejections > 0 || instance.socketDbTasks.newTimeouts > 0)) {
        violations.push(`${name} socket DB task sheds=${instance.socketDbTasks.newRejections} timeouts=${instance.socketDbTasks.newTimeouts} (disconnect cleanup runs on this limiter)`);
      }
      if (instance.runtime.eventLoopP99Ms > 250) violations.push(`${name} event-loop p99 ${instance.runtime.eventLoopP99Ms}ms > 250ms`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: tsx scripts/chaos/lobby-lifecycle.ts --target=local|staging --clients=N [--env-file=.env.harness]');
    console.log('       [--manage-backend --restart-at-s=90,240 --scenario-restarts=3 --restart-signal=SIGKILL|SIGTERM]');
    console.log('       [--scenarios=create_abandon,guest_disconnect,...] [--concurrency=40] [--grace-wait-ms=22000] [--seed=1337]');
    console.log('       [--age-stranded-min=31]  backdate abandoned lobbies before the ranked probe (tests the >30min heal)');
    console.log(`Scenarios: ${SCENARIOS.map((spec) => `${spec.kind}(${spec.users})`).join(' ')}`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  console.log('═'.repeat(72));
  console.log('LOBBY LIFECYCLE FLEET (PRODUCTION BLOCKED)');
  console.log(`target=${args.target} api=${target.apiBase} clients=${args.clients} shard=${args.offset}..${args.offset + args.clients - 1}`);
  console.log(`concurrency=${args.concurrency} ramp=${args.rampSec}s grace-wait=${args.graceWaitMs}ms seed=${args.seed}`
    + `${args.scenarios ? ` scenarios=${args.scenarios.join(',')}` : ''}`
    + `${args.manageBackend ? ` managed-backend restarts=[${args.restartAtSec.join(',')}]s signal=${args.restartSignal}` : ''}`);
  console.log('═'.repeat(72));

  const backend = args.manageBackend ? await startManagedBackend(args, target) : null;
  try {
    const users = await provisionWithTokenCache(args, target);
    console.log(`provisioned ${users.length} users`);
    const userIds = users.map((user) => user.userId);
    await ensureTickets({
      target: args.target,
      apiBase: target.apiBase,
      supabaseUrl: target.supabaseUrl,
      databaseUrl: target.databaseUrl,
      userIds,
      tickets: 5,
    });
    const reset = await resetLobbyFixtures(target.databaseUrl, userIds);
    console.log(`fixture-reset abandoned-matches=${reset.abandonedMatches} closed-lobbies=${reset.closedLobbies} removed-member-rows=${reset.removedMemberRows}`);

    const appCollector = startAppStatsCollector(target.apiBase, target.bypassToken, 1_000);
    const fleetStartedAt = Date.now();
    const restartTimers = args.restartAtSec.map((atSec) => setTimeout(() => {
      void backend?.restart(atSec, 'scheduled').catch((error) => console.error('[chaos] restart failed', error));
    }, atSec * 1_000));
    // Storyline-driven restarts: at most N per run, spaced so the fleet gets
    // a steady state between faults.
    let scenarioRestartsLeft = args.scenarioRestarts;
    let lastScenarioRestartAt = 0;
    const requestRestart = backend && args.scenarioRestarts > 0
      ? async (): Promise<boolean> => {
        if (scenarioRestartsLeft <= 0 || Date.now() - lastScenarioRestartAt < 45_000) return false;
        scenarioRestartsLeft--;
        lastScenarioRestartAt = Date.now();
        try {
          await backend.restart(Math.round((Date.now() - fleetStartedAt) / 1000), 'storyline');
          return true;
        } catch {
          return false;
        }
      }
      : undefined;

    // A reconnect re-arms the server's disconnect cleanup, so a stranded row
    // can self-heal the moment its ranked probe reconnects — the end-of-run
    // audit alone would under-count. Watch the database DURING the run for
    // memberships of players the harness has had no socket for past the grace.
    const strandedSeen = new Map<string, { firstSeenAt: string; row: LobbyInvariantReport['orphanWaitingLobbies'][number] }>();
    let auditInFlight = false;
    const auditTimer = setInterval(() => {
      if (auditInFlight) return;
      const idle = socketlessUsers(args.graceWaitMs);
      if (idle.length === 0) return;
      auditInFlight = true;
      void checkLobbyInvariants(target.databaseUrl, idle)
        .then((report) => {
          for (const row of [...report.orphanWaitingLobbies, ...report.staleActiveLobbies]) {
            if (!strandedSeen.has(row.lobbyId)) {
              strandedSeen.set(row.lobbyId, { firstSeenAt: new Date().toISOString(), row });
              console.log(`[audit] stranded ${row.status} lobby ${row.lobbyId.slice(0, 8)} (${row.gameMode}) members=${row.memberCount} idle=${row.idleSec}s`);
            }
          }
        })
        .catch((error) => console.error('[audit] mid-run check failed', error))
        .finally(() => { auditInFlight = false; });
    }, 15_000);

    let done = 0;
    const fleet = await runLobbyLifecycleFleet({
      apiBase: target.apiBase,
      users,
      concurrency: args.concurrency,
      rampSec: args.rampSec,
      graceWaitMs: args.graceWaitMs,
      scenarioKinds: args.scenarios,
      seed: args.seed,
      requestRestart,
      maxRestartScenarios: args.scenarioRestarts,
      restartsSince: backend
        ? (sinceMs) => backend.restarts.filter((r) => fleetStartedAt + r.atSec * 1_000 >= sinceMs - 1_000).length
        : undefined,
      ageLobby: args.ageStrandedMin > 0 ? (lobbyId, minutes) => ageLobby(target.databaseUrl, lobbyId, minutes) : undefined,
      ageStrandedMinutes: args.ageStrandedMin,
      onScenarioDone: (result) => {
        done++;
        const mark = result.ok ? (result.restartDisrupted ? 'ok*' : 'ok ') : 'FAIL';
        const probes = result.rankedProbes.map((probe) => probe.outcome).join('/');
        console.log(`[${String(done).padStart(4)}] ${mark} ${result.kind.padEnd(28)} ${Math.round(result.durationMs / 1000)}s`
          + ` probe=${probes || '-'}${result.ok ? '' : ` — ${result.stage}: ${result.detail}`}`);
      },
    });
    for (const timer of restartTimers) clearTimeout(timer);
    // A scheduled restart may still be mid-relaunch; the audit must see a
    // server that has been up for a full grace, not one that is booting.
    await backend?.settle();
    clearInterval(auditTimer);
    while (auditInFlight) await sleep(100);
    const app = await appCollector.stop().catch(() => null);
    console.log(`fleet done in ${Math.round((Date.now() - fleetStartedAt) / 1000)}s; waiting one more grace before the DB audit`);
    await sleep(args.graceWaitMs);
    const invariants = await checkLobbyInvariants(target.databaseUrl, userIds);

    const strandedObserved = [...strandedSeen.values()];
    const violations = evaluate(fleet, invariants, app);
    if (backend) {
      if (backend.failures.length > 0) violations.push(`${backend.failures.length} backend restarts failed: ${backend.failures.map((f) => f.error).join('; ')}`);
      if (backend.restarts.length < backend.attempts) violations.push(`backend restarts completed ${backend.restarts.length}/${backend.attempts} attempted`);
    }
    // A stranded row that the player's next explicit ranked click heals is the
    // designed outcome; only rows still there at the end (or a blocked probe)
    // are failures. The mid-run count stays in the report as the leak rate.
    const strandedStillOpen = strandedObserved.filter((entry) =>
      invariants.orphanWaitingLobbies.some((row) => row.lobbyId === entry.row.lobbyId)
      || invariants.staleActiveLobbies.some((row) => row.lobbyId === entry.row.lobbyId));
    if (strandedStillOpen.length > 0) {
      violations.push(`${strandedStillOpen.length} lobbies observed stranded mid-run were never healed`);
    }
    const verdict = { ok: violations.length === 0, violations };
    const report = {
      schemaVersion: 1,
      target: args.target,
      config: { ...args, envFile: args.envFile ?? null },
      backendRestarts: backend?.restarts ?? [],
      backendRestartFailures: backend?.failures ?? [],
      backendRestartAttempts: backend?.attempts ?? 0,
      fleet,
      invariants,
      strandedObserved,
      application: app,
      verdict,
    };
    const defaultPath = resolve(process.cwd(), 'scripts/chaos/reports',
      `lobby-lifecycle-${args.target}-${args.clients}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const reportPath = args.report
      ? (isAbsolute(args.report) ? args.report : resolve(process.cwd(), args.report))
      : defaultPath;
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log('─'.repeat(72));
    for (const [kind, bucket] of Object.entries(fleet.byKind)) {
      const stages = Object.entries(bucket.failuresByStage).map(([stage, n]) => `${stage}=${n}`).join(' ');
      console.log(`${kind.padEnd(28)} ${bucket.ok}/${bucket.planned} ok${stages ? `  fail: ${stages}` : ''}`);
    }
    console.log(`ranked probe: ${fleet.rankedProbe.ok}/${fleet.rankedProbe.total} ok  ${JSON.stringify(fleet.rankedProbe.byOutcome)}`);
    console.log(`db audit: orphan-waiting=${invariants.orphanWaitingLobbies.length} stale-active=${invariants.staleActiveLobbies.length}`
      + ` in-flight-matches=${invariants.inFlightMatchLobbies.length} hostless=${invariants.hostlessLobbies.length}`
      + ` empty-open=${invariants.emptyOpenLobbies.length} hung-matches=${invariants.hungMatches.length}`
      + ` dangling-closed-member-rows=${invariants.danglingClosedMemberRows} users-in-active-matches=${invariants.usersInActiveMatches}`);
    console.log(`stranded observed mid-run: ${strandedObserved.length}  restart-disrupted storylines: ${fleet.restartDisrupted}`);
    console.log(`LOBBY VERDICT: ${verdict.ok ? 'PASS' : 'FAIL'}`);
    for (const violation of violations) console.log(`  - ${violation}`);
    console.log(`Full JSON report: ${reportPath}`);
    if (!verdict.ok) process.exitCode = 1;
  } finally {
    await backend?.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
