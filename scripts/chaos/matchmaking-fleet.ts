import { setTimeout as sleep } from 'node:timers/promises';
import {
  clearActiveMatch,
  connectStaging,
  type StagingClient,
} from '../../game-regression/staging/staging-client.mjs';
import type { ChaosUser } from './auth.js';

export interface MatchmakingFleetConfig {
  apiBase: string;
  users: ChaosUser[];
  clients: number;
  connectRampSec: number;
  joinRampSec: number;
  matchTimeoutSec: number;
  cleanupWaitSec: number;
  cleanupRampSec: number;
  disconnectRampSec: number;
  /** Shared join timestamp used to synchronize independently prepared workers. */
  joinAtMs?: number;
}

interface ClientObservation {
  index: number;
  userId: string;
  client: StagingClient | null;
  connected: boolean;
  joinedAt: number | null;
  searchStartedAt: number | null;
  matchFoundAt: number | null;
  lobbyId: string | null;
  opponentId: string | null;
  matchFoundCount: number;
  cleanupSent: boolean;
  cleanupConfirmedAt: number | null;
  errors: string[];
}

export interface MatchmakingFleetSummary {
  startedAt: string;
  endedAt: string;
  elapsedSec: number;
  clients: number;
  connectedClients: number;
  searchStartedClients: number;
  humanMatchedClients: number;
  humanPairs: number;
  aiFallbackClients: number;
  unmatchedClients: number;
  duplicateMatchFoundClients: number;
  selfMatchedClients: number;
  invalidPairClients: number;
  cleanupUnconfirmedClients: number;
  matchFoundLatencyMs: number[];
  pairObservations: MatchmakingPairObservation[];
  percentiles: LatencyReport;
  errorHistogram: Record<string, number>;
  failures: Array<{
    clientIndex: number;
    userId: string;
    reason: string;
    lobbyId: string | null;
    opponentId: string | null;
  }>;
}

export interface MatchmakingVerdict {
  ok: boolean;
  maxMatchFoundP95Ms: number;
  violations: string[];
}

export interface MatchmakingPairObservation {
  userId: string;
  lobbyId: string | null;
  opponentId: string | null;
}

export interface MatchmakingPairAnalysis {
  humanMatchedClients: number;
  humanPairs: number;
  aiFallbackClients: number;
  selfMatchedClients: number;
  invalidUserIds: Set<string>;
}

interface LatencyReport {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export async function runMatchmakingFleet(
  cfg: MatchmakingFleetConfig
): Promise<MatchmakingFleetSummary> {
  assertMatchmakingTargetSafe(cfg.apiBase);
  if (cfg.clients <= 0) throw new Error('Matchmaking fleet requires clients > 0.');
  if (cfg.clients % 2 !== 0) {
    throw new Error('Matchmaking fleet requires an even client count so every user can human-pair.');
  }
  if (cfg.users.length < cfg.clients) {
    throw new Error(`Matchmaking fleet needs ${cfg.clients} users, got ${cfg.users.length}.`);
  }

  const startedAtMs = Date.now();
  const observations: ClientObservation[] = cfg.users.slice(0, cfg.clients).map((user, index) => ({
    index,
    userId: user.userId,
    client: null,
    connected: false,
    joinedAt: null,
    searchStartedAt: null,
    matchFoundAt: null,
    lobbyId: null,
    opponentId: null,
    matchFoundCount: 0,
    cleanupSent: false,
    cleanupConfirmedAt: null,
    errors: [],
  }));
  const cleanupDelayCapMs = Math.min(cfg.cleanupRampSec * 1_000, 900);
  const schedulePairCleanup = (observation: ClientObservation) => {
    if (!observation.lobbyId || !isCleanupLeader(observation)) return;
    // The server starts the draft 1.2s after match_found. Jitter one cleanup
    // request per lobby across at most 900ms to avoid a second synchronized
    // write spike while still cancelling before draft work begins. Comparing
    // the two user ids elects the same single leader even when the opponents
    // are running on different distributed load generators.
    const delayMs = deterministicDelay(observation.lobbyId, cleanupDelayCapMs);
    setTimeout(() => sendCleanup(observation), delayMs);
  };

  await Promise.all(observations.map(async (observation, index) => {
    const delayMs = cfg.clients > 1
      ? Math.round(cfg.connectRampSec * 1_000 * index / cfg.clients)
      : 0;
    if (delayMs > 0) await sleep(delayMs);
    const user = cfg.users[index]!;
    const client = connectStaging(cfg.apiBase, user.token, user.userId);
    observation.client = client;
    if (!(await waitConnected(client, 20_000))) {
      observation.errors.push('connect_timeout');
      return;
    }
    observation.connected = true;
    await clearActiveMatch(client);
    installObservers(observation, schedulePairCleanup);
  }));

  const connected = observations.filter((observation) => observation.connected);
  if (cfg.joinAtMs) {
    const waitMs = cfg.joinAtMs - Date.now();
    if (waitMs < -5_000) {
      throw new Error(`Matchmaking worker missed synchronized join time ${new Date(cfg.joinAtMs).toISOString()}.`);
    }
    if (waitMs > 0) await sleep(waitMs);
  }
  const joinStartedAt = Date.now();
  await Promise.all(connected.map(async (observation, index) => {
    const delayMs = connected.length > 1
      ? Math.round(cfg.joinRampSec * 1_000 * index / connected.length)
      : 0;
    if (delayMs > 0) await sleep(delayMs);
    observation.joinedAt = Date.now();
    observation.client!.socket.emit('ranked:queue_join', {
      searchMode: 'human_first',
    });
  }));

  const deadline = joinStartedAt
    + cfg.joinRampSec * 1_000
    + cfg.matchTimeoutSec * 1_000;
  while (Date.now() < deadline) {
    if (connected.every((observation) => observation.matchFoundAt !== null)) break;
    await sleep(100);
  }

  // Let scheduled per-lobby cancellations fire before the catch-all below.
  // Otherwise a fast successful run would collapse them back into one burst.
  if (cleanupDelayCapMs > 0) await sleep(cleanupDelayCapMs + 25);
  // Catch unmatched/partial observations and any cleanup timer that has not
  // fired yet. sendCleanup is idempotent, so scheduled timers can safely race.
  const cleanupLeaders = selectCleanupLeaders(connected);
  for (const observation of cleanupLeaders) sendCleanup(observation);
  await sleep(cfg.cleanupWaitSec * 1_000);
  await Promise.all(observations.map(async (observation, index) => {
    const delayMs = observations.length > 1
      ? Math.round(cfg.disconnectRampSec * 1_000 * index / observations.length)
      : 0;
    if (delayMs > 0) await sleep(delayMs);
    observation.client?.disconnect();
  }));

  return summarizeMatchmakingFleet(observations, startedAtMs, Date.now());
}

export function evaluateMatchmakingFleet(
  summary: MatchmakingFleetSummary,
  maxMatchFoundP95Ms = 8_000,
  deferGlobalPairValidation = false
): MatchmakingVerdict {
  const violations: string[] = [];
  if (summary.connectedClients !== summary.clients) {
    violations.push(`socket connections ${summary.connectedClients}/${summary.clients}`);
  }
  if (summary.searchStartedClients !== summary.clients) {
    violations.push(`queue acknowledgements ${summary.searchStartedClients}/${summary.clients}`);
  }
  if (!deferGlobalPairValidation) {
    if (summary.humanMatchedClients !== summary.clients) {
      violations.push(`human matches ${summary.humanMatchedClients}/${summary.clients}`);
    }
    if (summary.humanPairs !== summary.clients / 2) {
      violations.push(`valid human pairs ${summary.humanPairs}/${summary.clients / 2}`);
    }
    if (summary.aiFallbackClients > 0) {
      violations.push(`AI fallbacks during human queue storm: ${summary.aiFallbackClients}`);
    }
  }
  if (summary.unmatchedClients > 0) violations.push(`unmatched clients: ${summary.unmatchedClients}`);
  if (summary.duplicateMatchFoundClients > 0) {
    violations.push(`duplicate match_found clients: ${summary.duplicateMatchFoundClients}`);
  }
  if (summary.selfMatchedClients > 0) {
    violations.push(`self-matched clients: ${summary.selfMatchedClients}`);
  }
  if (!deferGlobalPairValidation && summary.invalidPairClients > 0) {
    violations.push(`asymmetric/invalid pair clients: ${summary.invalidPairClients}`);
  }
  if (summary.cleanupUnconfirmedClients > 0) {
    violations.push(`queue cleanup unconfirmed: ${summary.cleanupUnconfirmedClients}`);
  }
  const unexpectedErrors = Object.values(summary.errorHistogram).reduce((sum, count) => sum + count, 0);
  if (unexpectedErrors > 0) violations.push(`socket/server errors: ${unexpectedErrors}`);
  if (summary.percentiles.p95 > maxMatchFoundP95Ms) {
    violations.push(
      `match_found p95 ${summary.percentiles.p95}ms > ${maxMatchFoundP95Ms}ms`
    );
  }
  return { ok: violations.length === 0, maxMatchFoundP95Ms, violations };
}

export function renderMatchmakingFleet(summary: MatchmakingFleetSummary): string {
  return [
    'MATCHMAKING QUEUE-STORM RESULTS',
    `clients=${summary.clients} connected=${summary.connectedClients} searchStarted=${summary.searchStartedClients}`,
    `humanMatched=${summary.humanMatchedClients} humanPairs=${summary.humanPairs} aiFallbacks=${summary.aiFallbackClients} unmatched=${summary.unmatchedClients}`,
    `duplicates=${summary.duplicateMatchFoundClients} selfMatches=${summary.selfMatchedClients} invalidPairs=${summary.invalidPairClients} cleanupUnconfirmed=${summary.cleanupUnconfirmedClients}`,
    `join->match_found ms: p50=${summary.percentiles.p50} p95=${summary.percentiles.p95} p99=${summary.percentiles.p99} max=${summary.percentiles.max}`,
    `errors=${formatHistogram(summary.errorHistogram)}`,
  ].join('\n');
}

function installObservers(
  observation: ClientObservation,
  onMatchFound: (observation: ClientObservation) => void
): void {
  const socket = observation.client!.socket;
  socket.on('ranked:search_started', () => {
    observation.searchStartedAt ??= Date.now();
  });
  socket.on('ranked:match_found', (payload: unknown) => {
    observation.matchFoundCount += 1;
    if (observation.matchFoundAt !== null) return;
    const parsed = payload as { lobbyId?: unknown; opponent?: { id?: unknown } };
    observation.matchFoundAt = Date.now();
    observation.lobbyId = typeof parsed.lobbyId === 'string' ? parsed.lobbyId : null;
    observation.opponentId = typeof parsed.opponent?.id === 'string' ? parsed.opponent.id : null;
    onMatchFound(observation);
  });
  socket.on('ranked:queue_left', () => {
    observation.cleanupConfirmedAt ??= Date.now();
  });
  socket.on('connect_error', (error: Error) => observation.errors.push(`connect_error:${error.message}`));
  socket.on('error', (payload: unknown) => observation.errors.push(errorTag(payload)));
}

function deterministicDelay(value: string, maxDelayMs: number): number {
  if (maxDelayMs <= 0) return 0;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % (maxDelayMs + 1);
}

function sendCleanup(observation: ClientObservation): void {
  if (observation.cleanupSent || !observation.client?.socket.connected) return;
  observation.cleanupSent = true;
  observation.client.socket.emit('ranked:queue_leave');
}

function isCleanupLeader(observation: ClientObservation): boolean {
  return observation.opponentId === null
    || observation.userId.localeCompare(observation.opponentId) < 0;
}

function selectCleanupLeaders(observations: ClientObservation[]): ClientObservation[] {
  const leaders = new Map<string, ClientObservation>();
  const withoutLobby: ClientObservation[] = [];
  for (const observation of observations) {
    if (!isCleanupLeader(observation)) continue;
    if (!observation.lobbyId) {
      withoutLobby.push(observation);
      continue;
    }
    const current = leaders.get(observation.lobbyId);
    if (!current || observation.userId.localeCompare(current.userId) < 0) {
      leaders.set(observation.lobbyId, observation);
    }
  }
  return [...leaders.values(), ...withoutLobby];
}

function summarizeMatchmakingFleet(
  observations: ClientObservation[],
  startedAtMs: number,
  endedAtMs: number
): MatchmakingFleetSummary {
  const pairAnalysis = analyzeMatchmakingPairs(observations);

  const failures: MatchmakingFleetSummary['failures'] = [];
  for (const observation of observations) {
    const reasons: string[] = [];
    if (!observation.connected) reasons.push('connect_failed');
    else if (!observation.matchFoundAt) reasons.push('match_found_timeout');
    if (observation.matchFoundCount > 1) reasons.push('duplicate_match_found');
    if (observation.opponentId === observation.userId) reasons.push('self_match');
    if (pairAnalysis.invalidUserIds.has(observation.userId)) reasons.push('invalid_pair');
    if (observation.cleanupSent && !observation.cleanupConfirmedAt) reasons.push('cleanup_unconfirmed');
    for (const reason of reasons) {
      failures.push({
        clientIndex: observation.index,
        userId: observation.userId,
        reason,
        lobbyId: observation.lobbyId,
        opponentId: observation.opponentId,
      });
    }
  }

  const latencies = observations.flatMap((observation) => (
    observation.joinedAt !== null && observation.matchFoundAt !== null
      ? [observation.matchFoundAt - observation.joinedAt]
      : []
  ));
  const errorHistogram: Record<string, number> = {};
  for (const error of observations.flatMap((observation) => observation.errors)) {
    errorHistogram[error] = (errorHistogram[error] ?? 0) + 1;
  }
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedSec: (endedAtMs - startedAtMs) / 1_000,
    clients: observations.length,
    connectedClients: observations.filter((observation) => observation.connected).length,
    searchStartedClients: observations.filter((observation) => observation.searchStartedAt !== null).length,
    humanMatchedClients: pairAnalysis.humanMatchedClients,
    humanPairs: pairAnalysis.humanPairs,
    aiFallbackClients: pairAnalysis.aiFallbackClients,
    unmatchedClients: observations.filter((observation) => observation.matchFoundAt === null).length,
    duplicateMatchFoundClients: observations.filter((observation) => observation.matchFoundCount > 1).length,
    selfMatchedClients: pairAnalysis.selfMatchedClients,
    invalidPairClients: pairAnalysis.invalidUserIds.size,
    cleanupUnconfirmedClients: observations.filter(
      (observation) => observation.cleanupSent && observation.cleanupConfirmedAt === null
    ).length,
    matchFoundLatencyMs: latencies,
    pairObservations: observations.map((observation) => ({
      userId: observation.userId,
      lobbyId: observation.lobbyId,
      opponentId: observation.opponentId,
    })),
    percentiles: latencyReport(latencies),
    errorHistogram,
    failures: failures.slice(0, 500),
  };
}

export function analyzeMatchmakingPairs(
  observations: MatchmakingPairObservation[]
): MatchmakingPairAnalysis {
  const userIds = new Set(observations.map((observation) => observation.userId));
  const human = observations.filter(
    (observation) => observation.opponentId !== null && userIds.has(observation.opponentId)
  );
  const humanByLobby = new Map<string, MatchmakingPairObservation[]>();
  const invalidUserIds = new Set<string>();
  for (const observation of human) {
    if (!observation.lobbyId) {
      invalidUserIds.add(observation.userId);
      continue;
    }
    const group = humanByLobby.get(observation.lobbyId) ?? [];
    group.push(observation);
    humanByLobby.set(observation.lobbyId, group);
  }
  let humanPairs = 0;
  for (const group of humanByLobby.values()) {
    if (
      group.length === 2
      && group[0]!.userId !== group[1]!.userId
      && group[0]!.opponentId === group[1]!.userId
      && group[1]!.opponentId === group[0]!.userId
    ) {
      humanPairs += 1;
    } else {
      for (const observation of group) invalidUserIds.add(observation.userId);
    }
  }
  return {
    humanMatchedClients: human.length,
    humanPairs,
    aiFallbackClients: observations.filter(
      (observation) => observation.opponentId !== null && !userIds.has(observation.opponentId)
    ).length,
    selfMatchedClients: observations.filter(
      (observation) => observation.opponentId === observation.userId
    ).length,
    invalidUserIds,
  };
}

function assertMatchmakingTargetSafe(apiBase: string): void {
  const host = new URL(apiBase).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'api-staging.quizball.io'].includes(host)) {
    throw new Error(`PROD GUARD: matchmaking fleet refuses target ${apiBase}.`);
  }
}

async function waitConnected(client: StagingClient, timeoutMs: number): Promise<boolean> {
  if (client.socket.connected) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.socket.off('connect', onConnect);
      resolve(false);
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve(true);
    };
    client.socket.once('connect', onConnect);
  });
}

function latencyReport(samples: number[]): LatencyReport {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (percent: number) => sorted.length === 0
    ? 0
    : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent / 100))]!);
  return {
    count: sorted.length,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

function errorTag(payload: unknown): string {
  if (payload instanceof Error) return `error:${payload.message}`;
  if (payload && typeof payload === 'object') {
    const value = payload as { code?: unknown; message?: unknown };
    if (typeof value.code === 'string') return `server:${value.code}`;
    if (typeof value.message === 'string') return `server:${value.message}`;
  }
  return `server:${String(payload)}`;
}

function formatHistogram(histogram: Record<string, number>): string {
  const entries = Object.entries(histogram);
  return entries.length === 0
    ? 'none'
    : entries.map(([name, count]) => `${name}:${count}`).join(' ');
}
