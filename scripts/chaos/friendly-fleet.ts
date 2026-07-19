import { setTimeout as sleep } from 'node:timers/promises';

import {
  autoAnswer,
  autoDraft,
  autoHalftime,
  autoRecover,
} from '../../game-regression/staging/bot-behaviors.mjs';
import {
  clearActiveMatch,
  connectStaging,
  type StagingClient,
} from '../../game-regression/staging/staging-client.mjs';
import type { ChaosUser } from './auth.js';
import { assertSocketTargetSafe } from './socket-fleet.js';

const CONNECT_TIMEOUT_MS = 20_000;
const LOBBY_START_TIMEOUT_MS = 90_000;
const MATCH_FINISH_TIMEOUT_MS = 420_000;
const MAX_FAILURE_DETAILS = 500;

export interface FriendlyFleetConfig {
  apiBase: string;
  users: ChaosUser[];
  clients: number;
  rampSec: number;
}

export interface FriendlyFleetFailure {
  pairIndex: number;
  stage: string;
  detail: string;
}

export interface FriendlyFleetSummary {
  startedAt: string;
  endedAt: string;
  elapsedSec: number;
  clients: number;
  pairs: number;
  connectedClients: number;
  lobbiesCreated: number;
  joinedPairs: number;
  matchesStarted: number;
  matchesCompleted: number;
  clientsReceivingFinalResults: number;
  socketErrors: number;
  failureCount: number;
  failures: FriendlyFleetFailure[];
  latenciesMs: {
    connectToLobbyReady: number[];
    lobbyCreateToMatchStart: number[];
    matchStartToFinalResults: number[];
  };
  percentiles: {
    connectToLobbyReadyP95: number;
    lobbyCreateToMatchStartP95: number;
    matchStartToFinalResultsP95: number;
  };
}

interface MutableMetrics {
  connectedClients: number;
  lobbiesCreated: number;
  joinedPairs: number;
  matchesStarted: number;
  matchesCompleted: number;
  clientsReceivingFinalResults: number;
  socketErrors: number;
  failureCount: number;
  failures: FriendlyFleetFailure[];
  connectToLobbyReadyMs: number[];
  lobbyCreateToMatchStartMs: number[];
  matchStartToFinalResultsMs: number[];
}

export async function runFriendlyPartyFleet(
  cfg: FriendlyFleetConfig
): Promise<FriendlyFleetSummary> {
  assertSocketTargetSafe(cfg.apiBase);
  if (!Number.isInteger(cfg.clients) || cfg.clients <= 0 || cfg.clients % 2 !== 0) {
    throw new Error('Friendly fleet clients must be a positive even integer.');
  }
  if (cfg.users.length < cfg.clients) {
    throw new Error(`Friendly fleet needs ${cfg.clients} users, got ${cfg.users.length}.`);
  }
  const startedAtMs = Date.now();
  const metrics: MutableMetrics = {
    connectedClients: 0,
    lobbiesCreated: 0,
    joinedPairs: 0,
    matchesStarted: 0,
    matchesCompleted: 0,
    clientsReceivingFinalResults: 0,
    socketErrors: 0,
    failureCount: 0,
    failures: [],
    connectToLobbyReadyMs: [],
    lobbyCreateToMatchStartMs: [],
    matchStartToFinalResultsMs: [],
  };
  const pairs = cfg.clients / 2;
  const work = Array.from({ length: pairs }, (_, pairIndex) => {
    const rampMs = pairs > 1 ? Math.round(cfg.rampSec * 1_000 * pairIndex / pairs) : 0;
    const userA = cfg.users[pairIndex * 2]!;
    const userB = cfg.users[pairIndex * 2 + 1]!;
    return runPair(pairIndex, userA, userB, rampMs, cfg.apiBase, metrics);
  });
  await Promise.allSettled(work);
  const endedAtMs = Date.now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedSec: (endedAtMs - startedAtMs) / 1_000,
    clients: cfg.clients,
    pairs,
    connectedClients: metrics.connectedClients,
    lobbiesCreated: metrics.lobbiesCreated,
    joinedPairs: metrics.joinedPairs,
    matchesStarted: metrics.matchesStarted,
    matchesCompleted: metrics.matchesCompleted,
    clientsReceivingFinalResults: metrics.clientsReceivingFinalResults,
    socketErrors: metrics.socketErrors,
    failureCount: metrics.failureCount,
    failures: metrics.failures,
    latenciesMs: {
      connectToLobbyReady: metrics.connectToLobbyReadyMs,
      lobbyCreateToMatchStart: metrics.lobbyCreateToMatchStartMs,
      matchStartToFinalResults: metrics.matchStartToFinalResultsMs,
    },
    percentiles: {
      connectToLobbyReadyP95: percentile(metrics.connectToLobbyReadyMs, 0.95),
      lobbyCreateToMatchStartP95: percentile(metrics.lobbyCreateToMatchStartMs, 0.95),
      matchStartToFinalResultsP95: percentile(metrics.matchStartToFinalResultsMs, 0.95),
    },
  };
}

async function runPair(
  pairIndex: number,
  userA: ChaosUser,
  userB: ChaosUser,
  rampMs: number,
  apiBase: string,
  metrics: MutableMetrics
): Promise<void> {
  if (rampMs > 0) await sleep(rampMs);
  const connectedAt = Date.now();
  let clients: [StagingClient, StagingClient] | null = null;
  try {
    const host = connectStaging(apiBase, userA.token, userA.userId);
    const guest = connectStaging(apiBase, userB.token, userB.userId);
    clients = [host, guest];
    const connected = await Promise.all([
      waitConnected(host, CONNECT_TIMEOUT_MS),
      waitConnected(guest, CONNECT_TIMEOUT_MS),
    ]);
    metrics.connectedClients += connected.filter(Boolean).length;
    if (!connected.every(Boolean)) {
      fail(metrics, pairIndex, 'connect', `host=${connected[0]} guest=${connected[1]}`);
      return;
    }

    await Promise.all([clearActiveMatch(host), clearActiveMatch(guest)]);
    attachBots(host);
    attachBots(guest);

    let inviteCode: string | null = null;
    let memberCount = 0;
    let settingsSent = false;
    let settingsApplied = false;
    let joinedCounted = false;
    let allMembersReady = false;
    const lobbyCreatedAt = Date.now();
    host.socket.on('lobby:state', (state: {
      inviteCode?: string | null;
      members?: Array<{ isReady?: boolean }>;
      settings?: { gameMode?: string };
    }) => {
      memberCount = state.members?.length ?? 0;
      allMembersReady = memberCount >= 2
        && Boolean(state.members?.every((member) => member.isReady === true));
      if (!inviteCode && state.inviteCode) {
        inviteCode = state.inviteCode;
        metrics.lobbiesCreated++;
        guest.socket.emit('lobby:join_by_code', { inviteCode });
      }
      if (memberCount >= 2 && !joinedCounted) {
        joinedCounted = true;
        metrics.joinedPairs++;
      }
      if (memberCount >= 2 && !settingsSent) {
        settingsSent = true;
        host.socket.emit('lobby:update_settings', {
          gameMode: 'friendly_party_quiz',
          friendlyRandom: true,
        });
      }
      if (state.settings?.gameMode === 'friendly_party_quiz') settingsApplied = true;
    });
    host.socket.emit('lobby:create', { mode: 'friendly' });

    const lobbyReady = await host.waitFor(() => memberCount >= 2 && settingsApplied, 30_000);
    if (!lobbyReady) {
      fail(metrics, pairIndex, 'lobby_ready', `members=${memberCount} settings=${settingsApplied}`);
      return;
    }
    metrics.connectToLobbyReadyMs.push(Date.now() - connectedAt);
    host.socket.emit('lobby:ready', { ready: true });
    guest.socket.emit('lobby:ready', { ready: true });
    const readyConfirmed = await host.waitFor(() => allMembersReady, 30_000);
    if (!readyConfirmed) {
      fail(metrics, pairIndex, 'members_ready', `members=${memberCount} allReady=${allMembersReady}`);
      return;
    }
    host.socket.emit('lobby:start', {});

    const matchStarted = await host.waitFor(
      () => host.count('match:start') > 0 && host.count('match:question') > 0,
      LOBBY_START_TIMEOUT_MS
    );
    if (!matchStarted) {
      fail(metrics, pairIndex, 'match_start', 'no match:start/question');
      return;
    }
    metrics.matchesStarted++;
    const matchStartedAt = Date.now();
    metrics.lobbyCreateToMatchStartMs.push(matchStartedAt - lobbyCreatedAt);
    const matchId = host.latest<{ matchId?: string }>('match:start')?.matchId;
    const complete = await host.waitFor(
      () => hasFinal(host, matchId) && hasFinal(guest, matchId),
      MATCH_FINISH_TIMEOUT_MS
    );
    const finalClients = Number(hasFinal(host, matchId)) + Number(hasFinal(guest, matchId));
    metrics.clientsReceivingFinalResults += finalClients;
    if (!complete) {
      fail(metrics, pairIndex, 'match_finish', `final clients=${finalClients}/2 match=${matchId ?? 'unknown'}`);
      return;
    }
    metrics.matchesCompleted++;
    metrics.matchStartToFinalResultsMs.push(Date.now() - matchStartedAt);
    const errors = host.count('error') + guest.count('error');
    metrics.socketErrors += errors;
    if (errors > 0) fail(metrics, pairIndex, 'socket_error', `events=${errors}`);
  } catch (error) {
    fail(metrics, pairIndex, 'exception', error instanceof Error ? error.message : String(error));
  } finally {
    clients?.[0].disconnect();
    clients?.[1].disconnect();
  }
}

function attachBots(client: StagingClient): void {
  autoAnswer(client, {
    answerPlan: () => {
      const delayMs = 1_000 + Math.round(Math.random() * 7_000);
      return { mode: Math.random() < 0.68 ? 'correct' : 'wrong', timeMs: delayMs, delayMs };
    },
  });
  autoDraft(client);
  autoHalftime(client);
  autoRecover(client);
}

function hasFinal(client: StagingClient, matchId: string | undefined): boolean {
  if (!matchId) return client.count('match:final_results') > 0;
  return client.trace.byEvent('match:final_results')
    .some((event) => (event.payload as { matchId?: string }).matchId === matchId);
}

async function waitConnected(client: StagingClient, timeoutMs: number): Promise<boolean> {
  if (client.socket.connected) return true;
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.socket.off('connect', onConnect);
      client.socket.off('connect_error', onConnectError);
      resolveWait(connected);
    };
    const onConnect = () => finish(true);
    const onConnectError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.socket.once('connect', onConnect);
    client.socket.once('connect_error', onConnectError);
  });
}

function fail(metrics: MutableMetrics, pairIndex: number, stage: string, detail: string): void {
  metrics.failureCount++;
  if (metrics.failures.length < MAX_FAILURE_DETAILS) metrics.failures.push({ pairIndex, stage, detail });
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
