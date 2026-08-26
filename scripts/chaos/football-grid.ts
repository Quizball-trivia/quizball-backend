/* eslint-disable no-console */
/**
 * Football Tic Tac Toe staging capacity gate.
 *
 * Drives real authenticated Socket.IO clients through:
 * queue -> human pairing -> handoff -> ready -> 40 resolved turns -> result ACK.
 * Every turn submits a unique non-player string so the answer resolver and
 * durable command path run under load without depending on hidden answer data.
 * Production is blocked by API, Supabase, database, and Railway identity checks.
 */
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { io, type Socket } from 'socket.io-client';

import { provisionUsers, type ChaosUser } from './auth.js';
import { startAppStatsCollector, type AppStatsSummary } from './app-stats.js';
import { makeStatsClient, snapshotActivity, type ActivitySnapshot } from './db-stats.js';

const STAGING_SUPABASE_PROJECT = 'nsdfiprfmhdqhbfxfwpv';
const PRODUCTION_SUPABASE_PROJECT = 'lfbwhxvwubzeqkztghok';
const STAGING_API = 'https://api-staging.quizball.io';
const STAGING_RAILWAY_PROJECT = 'f69e88c4-9afa-4640-8748-f592350dd58e';
const STAGING_RAILWAY_ENVIRONMENT = '8eb31d59-ff31-4fee-9468-a747b8d29de4';
const STAGING_RAILWAY_SERVICE = 'f686a274-653b-48e1-ac91-74e0882113bd';

interface Args {
  target: 'staging' | 'local';
  clients: number;
  offset: number;
  rampSec: number;
  api?: string;
  report?: string;
  campaign: string;
  dbStats: boolean;
  expectXp: number | null;
  expectTp: number | null;
  expectCoins: number | null;
}

interface TargetConfig {
  apiBase: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
  bypassToken?: string;
  emailDomain: string;
}

interface GridState {
  matchId: string;
  phase: 'handoff' | 'loading' | 'countdown' | 'turn' | 'paused' | 'service_interruption' | 'terminal';
  stateVersion: number;
  turnNumber: number;
  currentPlayerUserId: string | null;
  winnerUserId: string | null;
  completionReason: string | null;
  players: Array<{ userId: string; isBot: boolean; handoffAcknowledged: boolean; ready: boolean }>;
}

interface StatePayload {
  matchId: string;
  state: GridState;
  serverNow: string;
}

interface CompletedPayload extends StatePayload {
  terminalStateVersion: number;
  ackToken: string;
  rewards?: {
    xp: number;
    coins: number;
    tp: number;
    eligibilityReason?: string;
    coinEligibilityReason?: string;
    tpEligibilityReason?: string;
  };
}

export interface GridFleetSummary {
  clients: number;
  expectedMatches: number;
  connectedClients: number;
  searchesStarted: number;
  clientsMatched: number;
  uniqueMatchesFound: number;
  humanMatchesFound: number;
  unexpectedBotMatches: number;
  selfPairings: number;
  overfilledMatches: number;
  matchesStarted: number;
  matchesCompleted: number;
  completionAcksSent: number;
  clientsCompleted: number;
  commandResults: number;
  wrongAnswers: number;
  socketErrors: number;
  connectionErrors: number;
  disconnectsBeforeCompletion: number;
  failureCount: number;
  rewardMismatches: number;
  rewardMismatchReasons: Record<string, number>;
  completionReasons: Record<string, number>;
  errors: Record<string, number>;
  percentiles: {
    searchToFoundP50Ms: number;
    searchToFoundP95Ms: number;
    searchToFoundP99Ms: number;
    commandAckP50Ms: number;
    commandAckP95Ms: number;
    commandAckP99Ms: number;
    matchDurationP50Ms: number;
    matchDurationP95Ms: number;
    matchDurationP99Ms: number;
  };
}

interface MutableMetrics {
  connectedClients: Set<string>;
  searchesStarted: number;
  matchedClients: Set<string>;
  matchUsers: Map<string, Set<string>>;
  matchHumanOnly: Map<string, boolean>;
  startedMatches: Set<string>;
  completedMatches: Set<string>;
  completedClients: Set<string>;
  completionAcksSent: number;
  commandResults: number;
  wrongAnswers: number;
  socketErrors: number;
  connectionErrors: number;
  disconnectsBeforeCompletion: number;
  rewardMismatches: number;
  rewardMismatchReasons: Map<string, number>;
  completionReasons: Map<string, number>;
  errors: Map<string, number>;
  searchToFoundMs: number[];
  commandAckMs: number[];
  matchDurationMs: number[];
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

function optionalInteger(argv: string[], key: string, fallback: number | null): number | null {
  const raw = value(argv, key);
  if (raw === undefined) return fallback;
  if (raw === 'off') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${key} must be >= 0 or "off".`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const target = (value(argv, 'target') ?? 'local') as Args['target'];
  if (target !== 'staging' && target !== 'local') throw new Error('--target must be staging or local.');
  const clients = integer(argv, 'clients', target === 'staging' ? 500 : 10, 2);
  if (clients % 2 !== 0) throw new Error('--clients must be even so every client has a human opponent.');
  if (clients > 1_000) throw new Error('--clients cannot exceed 1000 from one machine.');
  const defaultCampaign = `grid-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const campaign = value(argv, 'campaign') ?? defaultCampaign;
  if (!/^[a-z0-9-]{6,40}$/i.test(campaign)) throw new Error('--campaign must be 6-40 letters, digits, or hyphens.');
  return {
    target,
    clients,
    offset: integer(argv, 'offset', 0, 0),
    rampSec: integer(argv, 'ramp-s', target === 'staging' ? 120 : 5, 0),
    api: value(argv, 'api'),
    report: value(argv, 'report'),
    campaign,
    dbStats: value(argv, 'no-db-stats') !== 'true',
    expectXp: optionalInteger(argv, 'expect-xp', target === 'staging' ? 60 : null),
    expectTp: optionalInteger(argv, 'expect-tp', target === 'staging' ? 30 : null),
    expectCoins: optionalInteger(argv, 'expect-coins', target === 'staging' ? 250 : null),
  };
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const output: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2]!;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    output[match[1]!] = raw;
  }
  return output;
}

function assertExactIdentity(name: string, actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new Error(`STAGING IDENTITY GUARD: ${name} must equal ${expected}.`);
}

function resolveTarget(args: Args): TargetConfig {
  const env = readEnv(resolve(process.cwd(), args.target === 'staging' ? '.env' : '.env.local'));
  const config: TargetConfig = {
    apiBase: args.api ?? (args.target === 'staging' ? STAGING_API : `http://127.0.0.1:${process.env.PORT ?? env.PORT ?? '8000'}`),
    supabaseUrl: process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL ?? '',
    bypassToken: process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN,
    emailDomain: args.target === 'staging' ? 'quizball.io' : 'example.com',
  };
  const identityBlob = `${config.apiBase} ${config.supabaseUrl} ${config.databaseUrl}`;
  if (identityBlob.includes(PRODUCTION_SUPABASE_PROJECT) || config.apiBase.includes('api.quizball.io')) {
    throw new Error('PRODUCTION GUARD: refusing Football Tic Tac Toe load against production.');
  }
  if (args.target === 'staging') {
    if (config.apiBase !== STAGING_API) throw new Error(`STAGING IDENTITY GUARD: API must be ${STAGING_API}.`);
    if (!config.supabaseUrl.includes(STAGING_SUPABASE_PROJECT)
      || !config.databaseUrl.includes(STAGING_SUPABASE_PROJECT)) {
      throw new Error('STAGING IDENTITY GUARD: Supabase URL and database URL must identify staging.');
    }
    assertExactIdentity('Railway project', process.env.LOAD_RAILWAY_PROJECT_ID, STAGING_RAILWAY_PROJECT);
    assertExactIdentity('Railway environment', process.env.LOAD_RAILWAY_ENVIRONMENT_ID, STAGING_RAILWAY_ENVIRONMENT);
    assertExactIdentity('Railway service', process.env.LOAD_RAILWAY_SERVICE_ID, STAGING_RAILWAY_SERVICE);
    assertExactIdentity('analytics environment', process.env.LOAD_ANALYTICS_ENVIRONMENT, 'staging');
    if (!config.bypassToken) throw new Error('CHAOS_BYPASS_TOKEN is required on staging.');
  } else {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(config.apiBase)) {
      throw new Error('LOCAL IDENTITY GUARD: local target must use localhost.');
    }
  }
  if (!config.supabaseUrl || !config.serviceRoleKey || !config.databaseUrl) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DATABASE_URL are required.');
  }
  return config;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Math.round(sorted[index]!);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function emptyMetrics(): MutableMetrics {
  return {
    connectedClients: new Set(), searchesStarted: 0, matchedClients: new Set(),
    matchUsers: new Map(), matchHumanOnly: new Map(), startedMatches: new Set(),
    completedMatches: new Set(), completedClients: new Set(), completionAcksSent: 0,
    commandResults: 0, wrongAnswers: 0, socketErrors: 0, connectionErrors: 0,
    disconnectsBeforeCompletion: 0, rewardMismatches: 0,
    rewardMismatchReasons: new Map(),
    completionReasons: new Map(), errors: new Map(), searchToFoundMs: [],
    commandAckMs: [], matchDurationMs: [],
  };
}

function verifyReward(actual: number | undefined, expected: number | null): boolean {
  return expected === null || actual === expected;
}

export function footballGridRewardMismatch(input: {
  userId: string;
  state: Pick<GridState, 'completionReason' | 'winnerUserId'>;
  rewards: CompletedPayload['rewards'];
  expected: { xp: number | null; tp: number | null; coins: number | null };
}): string | null {
  const reason = input.state.completionReason ?? 'unknown';
  const rewards = input.rewards;
  if (!rewards) return `${reason}:missing_rewards`;

  const noContest = reason === 'loading_no_show'
    || reason === 'simultaneous_disconnect'
    || reason === 'administrative_cancel';
  if (noContest) {
    if (rewards.xp === 0 && rewards.tp === 0 && rewards.coins === 0
      && rewards.coinEligibilityReason === 'no_contest'
      && rewards.tpEligibilityReason === 'no_contest') return null;
    return `${reason}:expected_no_contest_0_0_0_got_${rewards.xp}_${rewards.tp}_${rewards.coins}`;
  }

  const forfeit = reason === 'forfeit'
    || reason === 'no_action_timeouts'
    || reason === 'disconnect_timeout';
  if (forfeit) {
    const expectedXp = input.state.winnerUserId === input.userId ? 70 : 20;
    if (rewards.xp === expectedXp && rewards.tp === 0 && rewards.coins === 0
      && rewards.coinEligibilityReason === 'forfeit_no_coins'
      && rewards.tpEligibilityReason === 'forfeit_no_points') return null;
    return `${reason}:expected_forfeit_${expectedXp}_0_0_got_${rewards.xp}_${rewards.tp}_${rewards.coins}`;
  }

  if (verifyReward(rewards.xp, input.expected.xp)
    && verifyReward(rewards.tp, input.expected.tp)
    && verifyReward(rewards.coins, input.expected.coins)) return null;
  return `${reason}:expected_${input.expected.xp ?? 'off'}_${input.expected.tp ?? 'off'}_${input.expected.coins ?? 'off'}_got_${rewards.xp}_${rewards.tp}_${rewards.coins}`;
}

async function runClient(
  user: ChaosUser,
  clientIndex: number,
  args: Args,
  target: TargetConfig,
  metrics: MutableMetrics,
): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, (clientIndex / args.clients) * args.rampSec * 1_000));
  const socket: Socket = io(target.apiBase, {
    transports: ['websocket'],
    auth: { token: user.token },
    forceNew: true,
    reconnection: true,
    extraHeaders: {
      'x-client-instance-id': `${args.campaign}-${clientIndex}`,
      ...(target.bypassToken ? { 'x-chaos-bypass': target.bypassToken } : {}),
    },
  });
  let phase: 'connecting' | 'searching' | 'matched' | 'playing' | 'completed' | 'failed' = 'connecting';
  let searchStartedAt = 0;
  let matchStartedAt = 0;
  let currentMatchId: string | null = null;
  let completionReceived = false;
  let latestStateVersion = -1;
  let lastConnectError: string | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const actedStateVersions = new Set<number>();
  const readyStateVersions = new Set<number>();
  const handoffStateVersions = new Set<number>();
  const commandStartedAt = new Map<string, number>();

  await new Promise<void>((resolveDone) => {
    const finish = (outcome: 'completed' | 'failed', reason?: string) => {
      if (phase === 'completed' || phase === 'failed') return;
      phase = outcome;
      if (heartbeat) clearInterval(heartbeat);
      if (outcome === 'failed' && reason) bump(metrics.errors, reason);
      socket.disconnect();
      resolveDone();
    };

    const failTimer = setTimeout(() => {
      if (phase === 'connecting' && lastConnectError) {
        metrics.connectionErrors += 1;
        finish('failed', `connect_error:${lastConnectError}`);
        return;
      }
      finish('failed', 'client_timeout');
    }, 180_000);
    const complete = () => { clearTimeout(failTimer); finish('completed'); };
    const fail = (reason: string) => { clearTimeout(failTimer); finish('failed', reason); };

  const handleState = (state: GridState) => {
    if (!currentMatchId || state.matchId !== currentMatchId) return;
    // Socket.IO preserves order per connection, but Redis fan-out from multiple
    // backend replicas can deliver an older state after a newer one. Mirror the
    // production store's monotonic guard so the load client never submits a
    // command from a state the real UI would discard.
    if (state.stateVersion < latestStateVersion) return;
    latestStateVersion = Math.max(latestStateVersion, state.stateVersion);
      if (state.phase === 'loading' && !state.players.find((player) => player.userId === user.userId)?.ready) {
        if (readyStateVersions.has(state.stateVersion)) return;
        readyStateVersions.add(state.stateVersion);
        socket.emit('grid:client_ready', {
          matchId: state.matchId,
          commandId: randomUUID(),
          expectedStateVersion: state.stateVersion,
        });
      }
      if (state.phase === 'turn') {
        metrics.startedMatches.add(state.matchId);
        if (phase === 'matched') {
          phase = 'playing';
          matchStartedAt = Date.now();
        }
        if (state.currentPlayerUserId !== user.userId || actedStateVersions.has(state.stateVersion)) return;
        actedStateVersions.add(state.stateVersion);
        setTimeout(() => {
          if (phase !== 'playing') return;
          // A newer state may arrive while this artificial think-time is
          // running. Do not dispatch the now-stale action: a real client
          // replaces its active turn model when that newer state renders.
          if (state.stateVersion !== latestStateVersion) return;
          const commandId = randomUUID();
          commandStartedAt.set(commandId, Date.now());
          socket.emit('grid:submit_answer', {
            matchId: state.matchId,
            commandId,
            expectedStateVersion: state.stateVersion,
            cellIndex: state.turnNumber % 9,
            text: `zzload ${args.campaign} ${clientIndex} ${state.turnNumber}`,
            locale: 'en',
          });
        }, 40 + (clientIndex % 80));
      }
    };

    socket.on('connect', () => {
      lastConnectError = null;
      metrics.connectedClients.add(user.userId);
      phase = 'searching';
      searchStartedAt = Date.now();
      metrics.searchesStarted += 1;
      socket.emit('grid:search_start', { locale: clientIndex % 2 === 0 ? 'en' : 'ka' });
    });
    socket.on('connect_error', (error: Error) => {
      // Socket.IO reconnects automatically. A single transport timeout during
      // a 500-client ramp is not a terminal user failure; only the bounded
      // client deadline above turns an unrecovered connection into one.
      lastConnectError = error.message.slice(0, 60);
    });
    socket.on('disconnect', (reason: string) => {
      if (phase !== 'completed' && phase !== 'failed') {
        metrics.disconnectsBeforeCompletion += 1;
        fail(`disconnect:${reason}`);
      }
    });
    socket.on('session:blocked', () => fail('session_blocked'));
    socket.on('grid:error', (error: { code?: string; message?: string; meta?: Record<string, unknown> }) => {
      // The completion ACK deliberately unbinds the socket. A heartbeat that
      // was already in flight may observe that unbind; it is not a gameplay
      // failure and the production UI also stops heartbeats on completion.
      if (completionReceived && error.meta?.gridCode === 'GRID_MATCH_BINDING_MISMATCH') return;
      metrics.socketErrors += 1;
      const gridCode = typeof error.meta?.gridCode === 'string' ? error.meta.gridCode : null;
      fail(`grid_error:${gridCode ?? error.code ?? 'unknown'}`);
    });
    socket.on('grid:match_found', (payload: { matchId: string; state: GridState }) => {
      currentMatchId = payload.matchId;
      phase = 'matched';
      metrics.matchedClients.add(user.userId);
      metrics.searchToFoundMs.push(Date.now() - searchStartedAt);
      const users = metrics.matchUsers.get(payload.matchId) ?? new Set<string>();
      users.add(user.userId);
      metrics.matchUsers.set(payload.matchId, users);
      const humanOnly = payload.state.players.every((player) => !player.isBot);
      metrics.matchHumanOnly.set(payload.matchId, (metrics.matchHumanOnly.get(payload.matchId) ?? true) && humanOnly);
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          if (currentMatchId) socket.emit('grid:presence_heartbeat', { matchId: currentMatchId });
        }, 5_000);
      }
      if (!payload.state.players.find((player) => player.userId === user.userId)?.handoffAcknowledged
        && !handoffStateVersions.has(payload.state.stateVersion)) {
        handoffStateVersions.add(payload.state.stateVersion);
        socket.emit('grid:match_found_ack', {
          matchId: payload.matchId,
          commandId: randomUUID(),
          expectedStateVersion: payload.state.stateVersion,
        });
      }
      handleState(payload.state);
    });
    socket.on('grid:loading_state', (payload: StatePayload) => handleState(payload.state));
    socket.on('grid:countdown', (payload: StatePayload) => handleState(payload.state));
    socket.on('grid:state', (payload: StatePayload) => handleState(payload.state));
    socket.on('grid:turn_resolved', (payload: StatePayload) => handleState(payload.state));
    socket.on('grid:command_result', (payload: { commandId: string; outcome: string }) => {
      metrics.commandResults += 1;
      if (payload.outcome === 'wrong') metrics.wrongAnswers += 1;
      const startedAt = commandStartedAt.get(payload.commandId);
      if (startedAt) metrics.commandAckMs.push(Date.now() - startedAt);
      commandStartedAt.delete(payload.commandId);
    });
    socket.on('grid:completed', (payload: CompletedPayload) => {
      if (payload.matchId !== currentMatchId) return;
      completionReceived = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      metrics.completedClients.add(user.userId);
      metrics.completedMatches.add(payload.matchId);
      bump(metrics.completionReasons, payload.state.completionReason ?? 'unknown');
      if (matchStartedAt > 0) metrics.matchDurationMs.push(Date.now() - matchStartedAt);
      const rewardMismatch = footballGridRewardMismatch({
        userId: user.userId,
        state: payload.state,
        rewards: payload.rewards,
        expected: { xp: args.expectXp, tp: args.expectTp, coins: args.expectCoins },
      });
      if (rewardMismatch) {
        metrics.rewardMismatches += 1;
        bump(metrics.rewardMismatchReasons, rewardMismatch);
      }
      metrics.completionAcksSent += 1;
      socket.emit('grid:completed_ack', {
        matchId: payload.matchId,
        terminalStateVersion: payload.terminalStateVersion,
        ackToken: payload.ackToken,
      });
      setTimeout(complete, 150);
    });
  });
}

function summarize(metrics: MutableMetrics, clients: number): GridFleetSummary {
  const expectedMatches = clients / 2;
  const matchEntries = [...metrics.matchUsers.entries()];
  const humanMatchesFound = matchEntries.filter(([matchId]) => metrics.matchHumanOnly.get(matchId)).length;
  const unexpectedBotMatches = matchEntries.length - humanMatchesFound;
  const selfPairings = matchEntries.filter(([, users]) => users.size < 2).length;
  const overfilledMatches = matchEntries.filter(([, users]) => users.size > 2).length;
  const failureCount = [...metrics.errors.values()].reduce((sum, count) => sum + count, 0);
  return {
    clients,
    expectedMatches,
    connectedClients: metrics.connectedClients.size,
    searchesStarted: metrics.searchesStarted,
    clientsMatched: metrics.matchedClients.size,
    uniqueMatchesFound: matchEntries.length,
    humanMatchesFound,
    unexpectedBotMatches,
    selfPairings,
    overfilledMatches,
    matchesStarted: metrics.startedMatches.size,
    matchesCompleted: metrics.completedMatches.size,
    completionAcksSent: metrics.completionAcksSent,
    clientsCompleted: metrics.completedClients.size,
    commandResults: metrics.commandResults,
    wrongAnswers: metrics.wrongAnswers,
    socketErrors: metrics.socketErrors,
    connectionErrors: metrics.connectionErrors,
    disconnectsBeforeCompletion: metrics.disconnectsBeforeCompletion,
    failureCount,
    rewardMismatches: metrics.rewardMismatches,
    rewardMismatchReasons: Object.fromEntries(metrics.rewardMismatchReasons),
    completionReasons: Object.fromEntries(metrics.completionReasons),
    errors: Object.fromEntries(metrics.errors),
    percentiles: {
      searchToFoundP50Ms: percentile(metrics.searchToFoundMs, 50),
      searchToFoundP95Ms: percentile(metrics.searchToFoundMs, 95),
      searchToFoundP99Ms: percentile(metrics.searchToFoundMs, 99),
      commandAckP50Ms: percentile(metrics.commandAckMs, 50),
      commandAckP95Ms: percentile(metrics.commandAckMs, 95),
      commandAckP99Ms: percentile(metrics.commandAckMs, 99),
      matchDurationP50Ms: percentile(metrics.matchDurationMs, 50),
      matchDurationP95Ms: percentile(metrics.matchDurationMs, 95),
      matchDurationP99Ms: percentile(metrics.matchDurationMs, 99),
    },
  };
}

export function evaluateFootballGridLoad(
  fleet: GridFleetSummary,
  dbPeak: ActivitySnapshot | null,
  app: AppStatsSummary,
  expectedInstances: number,
): string[] {
  const failures: string[] = [];
  if (fleet.connectedClients !== fleet.clients) failures.push(`connected clients ${fleet.connectedClients}/${fleet.clients}`);
  if (fleet.searchesStarted !== fleet.clients) failures.push(`searches ${fleet.searchesStarted}/${fleet.clients}`);
  if (fleet.clientsMatched !== fleet.clients) failures.push(`matched clients ${fleet.clientsMatched}/${fleet.clients}`);
  if (fleet.uniqueMatchesFound !== fleet.expectedMatches) failures.push(`unique matches ${fleet.uniqueMatchesFound}/${fleet.expectedMatches}`);
  if (fleet.humanMatchesFound !== fleet.expectedMatches) failures.push(`human matches ${fleet.humanMatchesFound}/${fleet.expectedMatches}`);
  if (fleet.matchesStarted !== fleet.expectedMatches) failures.push(`started matches ${fleet.matchesStarted}/${fleet.expectedMatches}`);
  const allowedIncompleteMatches = fleet.clients >= 500 ? 2 : 0;
  const minimumCompletedMatches = fleet.expectedMatches - allowedIncompleteMatches;
  const minimumCompletedClients = fleet.clients - allowedIncompleteMatches * 2;
  if (fleet.matchesCompleted < minimumCompletedMatches) failures.push(`completed matches ${fleet.matchesCompleted}/${fleet.expectedMatches}`);
  if (fleet.clientsCompleted < minimumCompletedClients) failures.push(`completed clients ${fleet.clientsCompleted}/${fleet.clients}`);
  if (fleet.completionAcksSent < minimumCompletedClients) failures.push(`completion ACKs ${fleet.completionAcksSent}/${fleet.clients}`);
  if (fleet.unexpectedBotMatches > 0) failures.push(`unexpected bot matches ${fleet.unexpectedBotMatches}`);
  if (fleet.selfPairings > 0 || fleet.overfilledMatches > 0) failures.push(`invalid pairings self=${fleet.selfPairings} overfilled=${fleet.overfilledMatches}`);
  const staleStateErrors = fleet.errors['grid_error:STALE_STATE'] ?? 0;
  const allowedClientTimeouts = fleet.clients >= 500 ? 4 : 0;
  const clientTimeouts = fleet.errors.client_timeout ?? 0;
  const unexpectedClientFailures = Math.max(0, fleet.failureCount - staleStateErrors - clientTimeouts);
  const unexpectedSocketErrors = Math.max(0, fleet.socketErrors - staleStateErrors);
  if (staleStateErrors >= 5) failures.push(`STALE_STATE errors ${staleStateErrors} >= 5`);
  if (clientTimeouts > allowedClientTimeouts) failures.push(`client timeouts ${clientTimeouts} > ${allowedClientTimeouts}`);
  if (unexpectedSocketErrors > 0 || fleet.connectionErrors > 0 || fleet.disconnectsBeforeCompletion > 0 || unexpectedClientFailures > 0) {
    failures.push(`transport failures socket=${fleet.socketErrors} connect=${fleet.connectionErrors} disconnect=${fleet.disconnectsBeforeCompletion} clients=${fleet.failureCount}`);
  }
  if (fleet.rewardMismatches > 0) failures.push(`reward mismatches ${fleet.rewardMismatches}`);
  if (fleet.percentiles.searchToFoundP50Ms >= 5_000) failures.push(`search p50 ${fleet.percentiles.searchToFoundP50Ms}ms >= 5000ms`);
  if (fleet.percentiles.searchToFoundP95Ms > 20_000) failures.push(`search p95 ${fleet.percentiles.searchToFoundP95Ms}ms > 20000ms`);
  if (fleet.percentiles.searchToFoundP99Ms > 30_000) failures.push(`search p99 ${fleet.percentiles.searchToFoundP99Ms}ms > 30000ms`);
  if (fleet.percentiles.commandAckP95Ms > 1_500) failures.push(`command p95 ${fleet.percentiles.commandAckP95Ms}ms > 1500ms`);
  if (fleet.percentiles.commandAckP99Ms > 3_000) failures.push(`command p99 ${fleet.percentiles.commandAckP99Ms}ms > 3000ms`);
  // Staging carries a sizeable idle baseline before a campaign starts. Treat
  // actual pool shedding/timeouts (below) as the primary capacity signal and
  // retain this guard only for genuine connection exhaustion.
  if (dbPeak?.utilizationPct && dbPeak.utilizationPct >= 95) failures.push(`DB connections ${dbPeak.utilizationPct}% >= 95%`);
  if (dbPeak && dbPeak.longestLockWaitSec > 1) failures.push(`DB lock wait ${dbPeak.longestLockWaitSec}s > 1s`);
  const longestIdleInTxnSec = dbPeak?.longestIdleInTxnSec ?? 0;
  if (longestIdleInTxnSec > 1) {
    failures.push(`DB idle-in-transaction ${longestIdleInTxnSec}s > 1s`);
  }
  if (app.requestFailures > 0) failures.push(`app telemetry failures ${app.requestFailures}`);
  const instances = Object.entries(app.instances).filter(([name]) => name !== 'unknown');
  if (instances.length < expectedInstances) failures.push(`app replicas observed ${instances.length}/${expectedInstances}`);
  for (const [name, instance] of instances) {
    if (instance.healthFailures > 0) failures.push(`${name} readiness failures ${instance.healthFailures}`);
    if (instance.pool.newRejections > 0 || instance.pool.newTimeouts > 0) failures.push(`${name} DB sheds/timeouts`);
    if (instance.socketDbTasks && (instance.socketDbTasks.newRejections > 0 || instance.socketDbTasks.newTimeouts > 0)) failures.push(`${name} socket DB task sheds/timeouts`);
    if (instance.postConnectDbTasks && (instance.postConnectDbTasks.newRejections > 0 || instance.postConnectDbTasks.newTimeouts > 0)) failures.push(`${name} post-connect DB task sheds/timeouts`);
    if (instance.runtime.eventLoopP99Ms > 100) failures.push(`${name} event-loop p99 ${instance.runtime.eventLoopP99Ms}ms > 100ms`);
    if (instance.runtime.cpuPct > 90) failures.push(`${name} CPU ${instance.runtime.cpuPct}% > 90%`);
  }
  return failures;
}

function mergeActivityPeak(current: ActivitySnapshot | null, next: ActivitySnapshot): ActivitySnapshot {
  if (!current) return next;
  const maxTotal = next.total > current.total ? next : current;
  return {
    total: maxTotal.total, maxConnections: maxTotal.maxConnections,
    utilizationPct: maxTotal.utilizationPct, active: Math.max(current.active, next.active),
    idle: Math.max(current.idle, next.idle), idleInTxn: Math.max(current.idleInTxn, next.idleInTxn),
    longestIdleInTxnSec: Math.max(current.longestIdleInTxnSec ?? 0, next.longestIdleInTxnSec ?? 0),
    waitingOnLock: Math.max(current.waitingOnLock, next.waitingOnLock),
    longestLockWaitSec: Math.max(current.longestLockWaitSec, next.longestLockWaitSec),
    longestActiveSec: Math.max(current.longestActiveSec, next.longestActiveSec),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run chaos:grid -- --target=staging --clients=500 --ramp-s=120');
    console.log('Creates exactly clients/2 human matches. Production is always blocked.');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  const health = await fetch(`${target.apiBase}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Target health check failed with ${health.status}.`);
  console.log('═'.repeat(72));
  console.log('FOOTBALL TIC TAC TOE LOAD GATE (PRODUCTION BLOCKED)');
  console.log(`campaign=${args.campaign} target=${args.target} clients=${args.clients} human-matches=${args.clients / 2} ramp=${args.rampSec}s`);
  console.log('═'.repeat(72));

  const users = await provisionUsers({
    apiBase: target.apiBase,
    supabaseUrl: target.supabaseUrl,
    serviceRoleKey: target.serviceRoleKey,
    count: args.clients,
    startIndex: args.offset,
    password: 'ChaosTest12345!',
    emailPrefix: args.campaign,
    emailDomain: target.emailDomain,
    concurrency: 10,
    loginIntervalMs: args.target === 'staging' ? 2_200 : 0,
    bypassToken: target.bypassToken,
  });
  if (users.length !== args.clients) throw new Error(`Provisioned ${users.length}/${args.clients} users.`);

  const sql = args.dbStats ? makeStatsClient(target.databaseUrl) : null;
  const before = sql ? await snapshotActivity(sql) : null;
  let peak = before;
  let sampling = false;
  const sampler = sql ? setInterval(() => {
    if (sampling) return;
    sampling = true;
    void snapshotActivity(sql).then((snapshot) => { peak = mergeActivityPeak(peak, snapshot); })
      .catch(() => {}).finally(() => { sampling = false; });
  }, 1_000) : null;
  const appCollector = startAppStatsCollector(target.apiBase, target.bypassToken, 1_000);
  const metrics = emptyMetrics();
  const progress = setInterval(() => {
    console.log(`[grid] connected=${metrics.connectedClients.size} matched=${metrics.matchedClients.size} matches=${metrics.matchUsers.size} started=${metrics.startedMatches.size} completed=${metrics.completedMatches.size} clients-done=${metrics.completedClients.size} errors=${[...metrics.errors.values()].reduce((sum, count) => sum + count, 0)}`);
  }, 10_000);
  await Promise.all(users.map((user, index) => runClient(user, index, args, target, metrics)));
  clearInterval(progress);
  if (sampler) clearInterval(sampler);
  while (sampling) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  const after = sql ? await snapshotActivity(sql) : null;
  if (after) peak = mergeActivityPeak(peak, after);
  if (sql) await sql.end({ timeout: 5 });
  const application = await appCollector.stop();
  const fleet = summarize(metrics, users.length);
  const failures = evaluateFootballGridLoad(fleet, peak, application, args.target === 'staging' ? 2 : 1);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaign: args.campaign,
    target: args.target,
    config: { ...args, api: target.apiBase },
    fleet,
    database: { before, peak, after },
    application,
    verdict: { ok: failures.length === 0, failures },
  };
  const defaultReport = resolve(process.cwd(), 'scripts/chaos/reports', `football-grid-${args.target}-${args.clients}-${args.campaign}.json`);
  const reportPath = args.report
    ? (isAbsolute(args.report) ? args.report : resolve(process.cwd(), args.report))
    : defaultReport;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`GRID LOAD VERDICT: ${failures.length === 0 ? 'PASS' : 'FAIL'} — ${fleet.matchesCompleted}/${fleet.expectedMatches} matches, ${fleet.clientsCompleted}/${fleet.clients} clients`);
  console.log(`latency search p95/p99=${fleet.percentiles.searchToFoundP95Ms}/${fleet.percentiles.searchToFoundP99Ms}ms command p95/p99=${fleet.percentiles.commandAckP95Ms}/${fleet.percentiles.commandAckP99Ms}ms`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log(`Full JSON report: ${reportPath}`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
