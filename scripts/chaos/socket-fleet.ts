import { setTimeout as sleep } from 'node:timers/promises';
import {
  autoAnswer,
  autoDraft,
  autoHalftime,
  autoRecover,
  type BotBehaviorOptions,
} from '../../game-regression/staging/bot-behaviors.mjs';
import { clearActiveMatch, connectStaging, type StagingClient } from '../../game-regression/staging/staging-client.mjs';
import { loginChaosUser, type ChaosUser } from './auth.js';

const MATCH_START_TIMEOUT_MS = 170_000;
const MATCH_FINISH_TIMEOUT_MS = 420_000;
const MAX_MATCH_DISCONNECTS = 3;
const SEARCH_STAGE_TIMEOUT_MS = 60_000;
const GATE_STAGE_GRACE_MS = 20_000;
const GATE_STAGE_Q0_TIMEOUT_MS = 60_000;
const DRAFT_AUTO_BAN_MS = 16_000;
const LEGACY_DRAFT_STALL_BUDGET_MS = DRAFT_AUTO_BAN_MS + 6_000;
const ANSWER_EVENTS = new Set([
  'match:answer',
  'match:countdown_guess',
  'match:put_in_order_answer',
  'match:clues_answer',
]);

export type FlapStage = 'search' | 'draft' | 'gate' | 'match';

export interface SocketFleetConfig {
  apiBase: string;
  durationSec: number;
  durationWasExplicit: boolean;
  sockets: number;
  flapRate: number;
  flapStages: FlapStage[];
  legacyProtocol: boolean;
  rampSec: number;
  matchesPerClient?: number;
  users: ChaosUser[];
}

export interface SocketFleetSummary {
  startedAt: string;
  endedAt: string;
  elapsedSec: number;
  clients: number;
  flapRate: number;
  flapStages: FlapStage[];
  legacyProtocol: boolean;
  rampSec: number;
  matchesPerClient?: number;
  matchesStarted: number;
  matchesCompleted: number;
  forfeits: number;
  abandons: number;
  wrongfulForfeits: number;
  deadSearch: number;
  banRollback: number;
  gateAbandon: number;
  legacyDraftStall: number;
  flapsPerformed: number;
  disconnectCountInflation: number;
  draftReplay: {
    resetThenReplay: number;
    merged: number;
  };
  bootStageViolations: BootStageViolation[];
  latenciesMs: {
    queueJoinToMatchStart: number[];
    answerToAck: number[];
    roundResultToNextQuestion: number[];
    roundResultToNextQuestionByPhase: {
      normal: number[];
      penalty: number[];
    };
  };
  percentiles: {
    queueJoinToMatchStart: LatencyReport;
    answerToAck: LatencyReport;
    roundResultToNextQuestion: LatencyReport;
    roundResultToNextQuestionByPhase: {
      normal: LatencyReport;
      penalty: LatencyReport;
    };
  };
  socketErrors: Record<string, number>;
  disconnectReasons: Record<string, number>;
}

interface LatencyReport {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface FleetMetrics {
  matchesStarted: number;
  matchesCompleted: number;
  forfeits: number;
  abandons: number;
  wrongfulForfeits: number;
  deadSearch: number;
  banRollback: number;
  gateAbandon: number;
  legacyDraftStall: number;
  flapsPerformed: number;
  disconnectCountInflation: number;
  draftResetThenReplay: number;
  draftMergedReplay: number;
  bootStageViolations: BootStageViolation[];
  queueJoinToMatchStartMs: number[];
  answerToAckMs: number[];
  roundResultToNextQuestionMs: number[];
  roundResultToNextQuestionNormalMs: number[];
  roundResultToNextQuestionPenaltyMs: number[];
  socketErrors: Record<string, number>;
  disconnectReasons: Record<string, number>;
}

interface ClientState {
  index: number;
  user: ChaosUser;
  client: StagingClient | null;
  current: MatchAttempt | null;
  flapInFlight: boolean;
}

export interface BootStageViolation {
  detector: 'deadSearch' | 'banRollback' | 'gateAbandon' | 'legacyDraftStall';
  clientIndex: number;
  seq: number;
  stage: FlapStage | 'legacy';
  matchId?: string | null;
  detail: Record<string, unknown>;
}

interface SearchFlapState {
  startedAt: number;
  reconnectedAt: number | null;
  resolvedAt: number | null;
  reported: boolean;
}

interface DraftFlapState {
  startedAt: number;
  reconnectedAt: number | null;
  committedCategoryId: string;
  replayStartedAt: number | null;
  sawCommittedBan: boolean;
  replayMetricRecorded: boolean;
  reported: boolean;
}

interface GateFlapState {
  startedAt: number;
  reconnectedAt: number | null;
  matchId: string | null;
  sawGateStateOrRejoin: boolean;
  q0At: number | null;
  reconnectedWithinGrace: boolean;
  reported: boolean;
}

interface MatchAttempt {
  clientIndex: number;
  seq: number;
  queueJoinedAt: number;
  matchId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  performedFlaps: number;
  maxDisconnectCountInflation: number;
  stageFlaps: Set<FlapStage>;
  searchFlap: SearchFlapState | null;
  draftFlap: DraftFlapState | null;
  gateFlap: GateFlapState | null;
  legacyDraftStartedAt: number | null;
  legacyDraftCompletedAt: number | null;
  legacyDraftStallReported: boolean;
  answerSentAt: Map<string, number>;
  lastRoundResultAt: { matchId: string; qIndex: number; at: number; phase: 'normal' | 'penalty' } | null;
  timers: Set<NodeJS.Timeout>;
  closed: boolean;
}

type PatchedSocket = StagingClient['socket'] & { __chaosEmitProbe?: true };

export function assertSocketTargetSafe(apiBase: string): void {
  const url = new URL(apiBase);
  const host = url.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isStaging = host === 'api-staging.quizball.io';
  if (!isLocal && !isStaging) {
    throw new Error(`PROD GUARD: socket fleet only allows api-staging.quizball.io or localhost, got "${apiBase}".`);
  }
}

export async function runSocketFleet(cfg: SocketFleetConfig): Promise<SocketFleetSummary> {
  if (cfg.sockets <= 0) throw new Error('runSocketFleet requires sockets > 0.');
  if (cfg.users.length < cfg.sockets) {
    throw new Error(`Socket fleet needs ${cfg.sockets} users, got ${cfg.users.length}.`);
  }
  assertSocketTargetSafe(cfg.apiBase);

  const metrics = newMetrics();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const stopStartingAt = cfg.matchesPerClient !== undefined && !cfg.durationWasExplicit
    ? null
    : startedAtMs + cfg.durationSec * 1000;

  const workers = cfg.users.slice(0, cfg.sockets).map((user, index) =>
    runClient(index, user, cfg, metrics, stopStartingAt).catch((err: unknown) => {
      addHist(metrics.socketErrors, `client_exception:${errorMessage(err)}`);
    })
  );
  await Promise.all(workers);

  const endedAtMs = Date.now();
  return {
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedSec: (endedAtMs - startedAtMs) / 1000,
    clients: cfg.sockets,
    flapRate: cfg.flapRate,
    flapStages: cfg.flapStages,
    legacyProtocol: cfg.legacyProtocol,
    rampSec: cfg.rampSec,
    ...(cfg.matchesPerClient !== undefined ? { matchesPerClient: cfg.matchesPerClient } : {}),
    matchesStarted: metrics.matchesStarted,
    matchesCompleted: metrics.matchesCompleted,
    forfeits: metrics.forfeits,
    abandons: metrics.abandons,
    wrongfulForfeits: metrics.wrongfulForfeits,
    deadSearch: metrics.deadSearch,
    banRollback: metrics.banRollback,
    gateAbandon: metrics.gateAbandon,
    legacyDraftStall: metrics.legacyDraftStall,
    flapsPerformed: metrics.flapsPerformed,
    disconnectCountInflation: metrics.disconnectCountInflation,
    draftReplay: {
      resetThenReplay: metrics.draftResetThenReplay,
      merged: metrics.draftMergedReplay,
    },
    bootStageViolations: metrics.bootStageViolations,
    latenciesMs: {
      queueJoinToMatchStart: metrics.queueJoinToMatchStartMs,
      answerToAck: metrics.answerToAckMs,
      roundResultToNextQuestion: metrics.roundResultToNextQuestionMs,
      roundResultToNextQuestionByPhase: {
        normal: metrics.roundResultToNextQuestionNormalMs,
        penalty: metrics.roundResultToNextQuestionPenaltyMs,
      },
    },
    percentiles: {
      queueJoinToMatchStart: latencyReport(metrics.queueJoinToMatchStartMs),
      answerToAck: latencyReport(metrics.answerToAckMs),
      roundResultToNextQuestion: latencyReport(metrics.roundResultToNextQuestionMs),
      roundResultToNextQuestionByPhase: {
        normal: latencyReport(metrics.roundResultToNextQuestionNormalMs),
        penalty: latencyReport(metrics.roundResultToNextQuestionPenaltyMs),
      },
    },
    socketErrors: metrics.socketErrors,
    disconnectReasons: metrics.disconnectReasons,
  };
}

export function renderSocketFleetSummary(s: SocketFleetSummary): string {
  const latencyRows = [
    ['queueJoin->match:start', s.percentiles.queueJoinToMatchStart],
    ['answer->answer_ack', s.percentiles.answerToAck],
    ['round_result->question', s.percentiles.roundResultToNextQuestion],
    ['round_result->question normal', s.percentiles.roundResultToNextQuestionByPhase.normal],
    ['round_result->question penalty', s.percentiles.roundResultToNextQuestionByPhase.penalty],
  ].map(([name, report]) => {
    const r = report as LatencyReport;
    return [name as string, String(r.count), String(r.p50), String(r.p95), String(r.p99), String(r.max)];
  });
  const latencyHeaders = ['metric', 'count', 'p50', 'p95', 'p99', 'max'];
  const lines = [
    'SOCKET FLEET RESULTS',
    `clients=${s.clients}  flapRate=${s.flapRate}  flapStages=${s.flapStages.join(',')}  legacy=${s.legacyProtocol}  ramp=${s.rampSec}s  elapsed=${s.elapsedSec.toFixed(1)}s`,
    `matchesStarted=${s.matchesStarted}  matchesCompleted=${s.matchesCompleted}  forfeits=${s.forfeits}  abandons=${s.abandons}`,
    `WRONGFUL-FORFEIT COUNT=${s.wrongfulForfeits}  flaps=${s.flapsPerformed}  disconnectCountInflation=${s.disconnectCountInflation}`,
    `BOOT-STAGE DETECTORS deadSearch=${s.deadSearch}  banRollback=${s.banRollback}  gateAbandon=${s.gateAbandon}  legacyDraftStall=${s.legacyDraftStall}`,
    `draftReplay resetThenReplay=${s.draftReplay.resetThenReplay}  merged=${s.draftReplay.merged}`,
  ];
  if (s.gateAbandon > 0) {
    lines.push('gateAbandon note: expected red on pre-fix staging Finding 3; should clear after boot-stage fixes.');
  }
  lines.push(
    '',
    renderTable(latencyHeaders, latencyRows),
    '',
    `socket errors: ${formatHist(s.socketErrors)}`,
    `disconnect reasons: ${formatHist(s.disconnectReasons)}`
  );
  return lines.join('\n');
}

async function runClient(
  index: number,
  user: ChaosUser,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  stopStartingAt: number | null
): Promise<void> {
  const state: ClientState = { index, user: { ...user }, client: null, current: null, flapInFlight: false };
  const rampDelayMs = cfg.sockets > 1 ? Math.round((cfg.rampSec * 1000 * index) / cfg.sockets) : 0;
  if (rampDelayMs > 0) await sleep(rampDelayMs);
  state.client = createClient(state, cfg, metrics, null, false);
  if (!(await waitConnected(state.client, 20_000))) {
    addHist(metrics.socketErrors, 'connect_timeout');
    state.client.disconnect();
    return;
  }
  await clearActiveMatch(state.client);
  attachBotBehaviors(state, state.client, cfg, metrics);

  let seq = 0;
  while (shouldStart(seq, cfg, stopStartingAt)) {
    const attempt = newAttempt(index, seq);
    state.current = attempt;
    state.client.trace.reset();
    attempt.queueJoinedAt = Date.now();
    state.client.socket.emit('ranked:queue_join', {});
    if (hasFlapStage(cfg, 'search')) void performSearchStageFlap(state, cfg, metrics, attempt);

    const started = await waitFor(() => attempt.startedAt !== null, MATCH_START_TIMEOUT_MS);
    if (!started) {
      addHist(metrics.socketErrors, 'match_start_timeout');
      closeAttempt(metrics, attempt, false);
      state.current = null;
      seq++;
      await recycleClient(state, cfg, metrics);
      continue;
    }

    const finished = await waitFor(() => attempt.completedAt !== null, MATCH_FINISH_TIMEOUT_MS);
    if (!finished) {
      closeAttempt(metrics, attempt, true);
      state.current = null;
      seq++;
      await recycleClient(state, cfg, metrics);
      continue;
    }

    closeAttempt(metrics, attempt, false);
    state.current = null;
    seq++;
    if (shouldStart(seq, cfg, stopStartingAt)) await sleep(1_500 + Math.random() * 2_500);
  }

  state.client?.disconnect();
}

function createClient(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  sharedTrace: StagingClient['trace'] | null,
  withBot: boolean
): StagingClient {
  const client = connectStaging(cfg.apiBase, state.user.token, state.user.userId, sharedTrace ?? undefined);
  attachMetrics(state, client, cfg, metrics);
  if (withBot) attachBotBehaviors(state, client, cfg, metrics);
  return client;
}

function attachBotBehaviors(
  state: ClientState,
  client: StagingClient,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics
): void {
  const options: BotBehaviorOptions = {
    legacyProtocol: cfg.legacyProtocol,
    onDraftBanSent: ({ categoryId }) => {
      const attempt = state.current;
      if (!attempt || state.flapInFlight || !hasFlapStage(cfg, 'draft') || attempt.stageFlaps.has('draft')) return;
      attempt.draftFlap = {
        startedAt: Date.now(),
        reconnectedAt: null,
        committedCategoryId: categoryId,
        replayStartedAt: null,
        sawCommittedBan: false,
        replayMetricRecorded: false,
        reported: false,
      };
      void performDraftStageFlap(state, cfg, metrics, attempt);
    },
    onBeforeKickoffUiReady: (payload) => {
      const attempt = state.current;
      if (!attempt || state.flapInFlight || !hasFlapStage(cfg, 'gate') || attempt.stageFlaps.has('gate')) return false;
      attempt.gateFlap = {
        startedAt: Date.now(),
        reconnectedAt: null,
        matchId: payload.matchId ?? attempt.matchId,
        sawGateStateOrRejoin: false,
        q0At: null,
        reconnectedWithinGrace: false,
        reported: false,
      };
      void performGateStageFlap(state, cfg, metrics, attempt);
      return true;
    },
  };
  autoAnswer(client, options);
  autoDraft(client, options);
  autoHalftime(client);
  autoRecover(client, options);
}

function attachMetrics(
  state: ClientState,
  client: StagingClient,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics
): void {
  installEmitProbe(state, client);
  client.socket.on('connect_error', (err: Error) => addHist(metrics.socketErrors, `connect_error:${err.message}`));
  client.socket.on('disconnect', (reason: string) => addHist(metrics.disconnectReasons, reason));
  client.socket.on('error', (payload: unknown) => {
    addHist(metrics.socketErrors, errorTag(payload));
    noteGateError(state, client, metrics, payload);
  });
  client.socket.on('ranked:search_started', () => resolveSearchFlap(state.current, 'ranked:search_started'));
  client.socket.on('ranked:match_found', () => resolveSearchFlap(state.current, 'ranked:match_found'));
  client.socket.on('ranked:queue_left', () => resolveSearchFlap(state.current, 'ranked:queue_left'));
  client.socket.on('session:state', (payload: { state?: string }) => {
    if (payload.state && payload.state !== 'IN_QUEUE') resolveSearchFlap(state.current, `session:${payload.state}`);
  });
  client.socket.on('session:blocked', (payload: { stateSnapshot?: { state?: string } }) => {
    const stateName = payload.stateSnapshot?.state;
    if (stateName && stateName !== 'IN_QUEUE') resolveSearchFlap(state.current, `session_blocked:${stateName}`);
  });
  client.socket.on('draft:start', () => {
    const attempt = state.current;
    if (!attempt) return;
    if (cfg.legacyProtocol && attempt.legacyDraftStartedAt === null) {
      attempt.legacyDraftStartedAt = Date.now();
      const timer = setTimeout(() => {
        attempt.timers.delete(timer);
        reportLegacyDraftStall(metrics, attempt, 'budget_elapsed');
      }, LEGACY_DRAFT_STALL_BUDGET_MS);
      attempt.timers.add(timer);
    }
    const draft = attempt.draftFlap;
    if (draft?.reconnectedAt && draft.replayStartedAt === null) {
      draft.replayStartedAt = Date.now();
      const timer = setTimeout(() => {
        attempt.timers.delete(timer);
        checkDraftRollback(metrics, attempt, 'replay_missing_committed_ban');
      }, 2_500);
      attempt.timers.add(timer);
    }
  });
  client.socket.on('draft:banned', (payload: { categoryId?: string }) => {
    const attempt = state.current;
    const draft = attempt?.draftFlap;
    if (!attempt || !draft || !draft.reconnectedAt || payload.categoryId !== draft.committedCategoryId) return;
    draft.sawCommittedBan = true;
    if (!draft.replayMetricRecorded) {
      if (draft.replayStartedAt !== null) metrics.draftResetThenReplay++;
      else metrics.draftMergedReplay++;
      draft.replayMetricRecorded = true;
    }
  });
  client.socket.on('draft:complete', () => {
    const attempt = state.current;
    if (!attempt) return;
    finishLegacyDraft(metrics, attempt, 'draft:complete');
    checkDraftRollback(metrics, attempt, 'draft:complete');
  });
  client.socket.on('match:waiting_for_ready', (payload: { matchId?: string; phase?: string }) => {
    const attempt = state.current;
    const gate = attempt?.gateFlap;
    if (!attempt || !gate || !gate.reconnectedAt) return;
    if (payload.matchId && gate.matchId && payload.matchId !== gate.matchId) return;
    gate.sawGateStateOrRejoin = true;
  });
  client.socket.on('match:start', (payload: { matchId?: string }) => {
    const attempt = state.current;
    if (!attempt) return;
    resolveSearchFlap(attempt, 'match:start');
    finishLegacyDraft(metrics, attempt, 'match:start');
    checkDraftRollback(metrics, attempt, 'match:start');
    if (attempt.startedAt !== null) return;
    attempt.startedAt = Date.now();
    attempt.matchId = payload.matchId ?? null;
    metrics.matchesStarted++;
    metrics.queueJoinToMatchStartMs.push(attempt.startedAt - attempt.queueJoinedAt);
    scheduleFlaps(state, cfg, metrics, attempt);
  });
  client.socket.on('match:question', (payload: { matchId?: string; qIndex?: number }) => {
    const attempt = state.current;
    if (!attempt || !payload.matchId || typeof payload.qIndex !== 'number') return;
    const gate = attempt.gateFlap;
    if (gate && payload.qIndex === 0 && (!gate.matchId || gate.matchId === payload.matchId)) {
      gate.q0At = Date.now();
      gate.sawGateStateOrRejoin = true;
    }
    const last = attempt.lastRoundResultAt;
    if (last && last.matchId === payload.matchId && payload.qIndex > last.qIndex) {
      const elapsed = Date.now() - last.at;
      metrics.roundResultToNextQuestionMs.push(elapsed);
      if (last.phase === 'penalty') metrics.roundResultToNextQuestionPenaltyMs.push(elapsed);
      else metrics.roundResultToNextQuestionNormalMs.push(elapsed);
      attempt.lastRoundResultAt = null;
    }
  });
  client.socket.on('match:answer_ack', (payload: { matchId?: string; qIndex?: number }) => {
    const attempt = state.current;
    if (!attempt || !payload.matchId || typeof payload.qIndex !== 'number') return;
    const key = answerKey(payload.matchId, payload.qIndex);
    const sentAt = attempt.answerSentAt.get(key);
    if (sentAt !== undefined) {
      metrics.answerToAckMs.push(Date.now() - sentAt);
      attempt.answerSentAt.delete(key);
    }
  });
  client.socket.on('match:round_result', (payload: { matchId?: string; qIndex?: number; phaseKind?: string }) => {
    const attempt = state.current;
    if (!attempt || !payload.matchId || typeof payload.qIndex !== 'number') return;
    attempt.lastRoundResultAt = {
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      at: Date.now(),
      phase: payload.phaseKind === 'penalty' ? 'penalty' : 'normal',
    };
  });
  client.socket.on('match:rejoin_available', (payload: { matchId?: string; remainingReconnects?: number }) => {
    const attempt = state.current;
    if (!attempt || typeof payload.remainingReconnects !== 'number') return;
    if (payload.matchId && attempt.matchId && payload.matchId !== attempt.matchId) return;
    const gate = attempt.gateFlap;
    if (gate && (!payload.matchId || !gate.matchId || payload.matchId === gate.matchId)) {
      gate.sawGateStateOrRejoin = true;
    }
    const observedDisconnects = MAX_MATCH_DISCONNECTS - payload.remainingReconnects;
    const inflation = Math.max(0, observedDisconnects - attempt.performedFlaps);
    attempt.maxDisconnectCountInflation = Math.max(attempt.maxDisconnectCountInflation, inflation);
  });
  client.socket.on('match:final_results', (payload: FinalResultsPayload) => {
    const attempt = state.current;
    if (!attempt) return;
    if (payload.matchId && attempt.matchId && payload.matchId !== attempt.matchId) return;
    if (attempt.completedAt !== null) return;
    attempt.completedAt = Date.now();
    metrics.matchesCompleted++;
    if (payload.winnerDecisionMethod === 'forfeit') metrics.forfeits++;
    if (isWrongfulForfeit(payload, state.user.userId, client.socket.connected)) metrics.wrongfulForfeits++;
    if (payload.winnerDecisionMethod === 'forfeit') {
      reportGateAbandonIfNeeded(metrics, attempt, 'forfeit_before_q0', {
        connected: client.socket.connected,
        winnerId: payload.winnerId ?? null,
      });
    }
  });
}

function installEmitProbe(state: ClientState, client: StagingClient): void {
  const socket = client.socket as PatchedSocket;
  if (socket.__chaosEmitProbe) return;
  const originalEmit = socket.emit.bind(socket);
  socket.emit = ((event: string, ...args: unknown[]) => {
    const attempt = state.current;
    const payload = args[0] as { matchId?: string; qIndex?: number } | undefined;
    if (attempt && ANSWER_EVENTS.has(event) && payload?.matchId && typeof payload.qIndex === 'number') {
      attempt.answerSentAt.set(answerKey(payload.matchId, payload.qIndex), Date.now());
    }
    return originalEmit(event, ...args);
  }) as StagingClient['socket']['emit'];
  socket.__chaosEmitProbe = true;
}

async function flapSocket(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  attempt: MatchAttempt,
  stage: FlapStage = 'match'
): Promise<boolean> {
  if (state.current !== attempt || attempt.completedAt !== null || state.flapInFlight || !state.client) return false;
  state.flapInFlight = true;
  attempt.stageFlaps.add(stage);
  attempt.performedFlaps++;
  metrics.flapsPerformed++;
  const oldClient = state.client;
  oldClient.socket.disconnect();
  await sleep(1_000 + Math.random() * 2_000);
  if (state.current !== attempt || attempt.completedAt !== null) {
    state.flapInFlight = false;
    return false;
  }
  try {
    const fresh = await loginChaosUser({ apiBase: cfg.apiBase, password: state.user.password }, state.user.email);
    state.user.token = fresh.token;
    state.user.userId = fresh.userId || state.user.userId;
    const next = createClient(state, cfg, metrics, oldClient.trace, true);
    state.client = next;
    if (!(await waitConnected(next, 20_000))) {
      addHist(metrics.socketErrors, 'reconnect_timeout');
      return false;
    }
    if (attempt.matchId) next.socket.emit('match:rejoin', { matchId: attempt.matchId });
    return true;
  } catch (err) {
    addHist(metrics.socketErrors, `reconnect_failed:${errorMessage(err)}`);
    return false;
  } finally {
    state.flapInFlight = false;
  }
}

async function recycleClient(state: ClientState, cfg: SocketFleetConfig, metrics: FleetMetrics): Promise<void> {
  const oldTrace = state.client?.trace ?? null;
  state.client?.disconnect();
  try {
    const fresh = await loginChaosUser({ apiBase: cfg.apiBase, password: state.user.password }, state.user.email);
    state.user.token = fresh.token;
    state.user.userId = fresh.userId || state.user.userId;
  } catch (err) {
    addHist(metrics.socketErrors, `recycle_login_failed:${errorMessage(err)}`);
  }
  state.client = createClient(state, cfg, metrics, oldTrace, false);
  if (await waitConnected(state.client, 20_000)) {
    await clearActiveMatch(state.client);
    attachBotBehaviors(state, state.client, cfg, metrics);
  } else {
    addHist(metrics.socketErrors, 'recycle_connect_timeout');
  }
}

function hasFlapStage(cfg: SocketFleetConfig, stage: FlapStage): boolean {
  return cfg.flapStages.includes(stage);
}

async function performSearchStageFlap(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  attempt: MatchAttempt
): Promise<void> {
  if (attempt.stageFlaps.has('search')) return;
  attempt.searchFlap = {
    startedAt: Date.now(),
    reconnectedAt: null,
    resolvedAt: null,
    reported: false,
  };
  const timer = setTimeout(() => {
    attempt.timers.delete(timer);
    checkSearchFlap(metrics, attempt, 'search_stage_timeout');
  }, SEARCH_STAGE_TIMEOUT_MS);
  attempt.timers.add(timer);
  const reconnected = await flapSocket(state, cfg, metrics, attempt, 'search');
  if (reconnected && attempt.searchFlap) attempt.searchFlap.reconnectedAt = Date.now();
}

async function performDraftStageFlap(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  attempt: MatchAttempt
): Promise<void> {
  const reconnected = await flapSocket(state, cfg, metrics, attempt, 'draft');
  if (reconnected && attempt.draftFlap) attempt.draftFlap.reconnectedAt = Date.now();
}

async function performGateStageFlap(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  attempt: MatchAttempt
): Promise<void> {
  const reconnected = await flapSocket(state, cfg, metrics, attempt, 'gate');
  const gate = attempt.gateFlap;
  if (!gate) return;
  if (reconnected) {
    gate.reconnectedAt = Date.now();
    gate.reconnectedWithinGrace = gate.reconnectedAt - gate.startedAt < GATE_STAGE_GRACE_MS;
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      reportGateAbandonIfNeeded(metrics, attempt, 'q0_timeout_after_gate_flap', {
        sawGateStateOrRejoin: gate.sawGateStateOrRejoin,
      });
    }, GATE_STAGE_Q0_TIMEOUT_MS);
    attempt.timers.add(timer);
  }
}

function resolveSearchFlap(attempt: MatchAttempt | null, reason: string): void {
  const search = attempt?.searchFlap;
  if (!search || search.resolvedAt !== null) return;
  search.resolvedAt = Date.now();
  void reason;
}

function checkSearchFlap(metrics: FleetMetrics, attempt: MatchAttempt, reason: string): void {
  const search = attempt.searchFlap;
  if (!search || search.reported || search.resolvedAt !== null) return;
  search.reported = true;
  metrics.deadSearch++;
  metrics.bootStageViolations.push({
    detector: 'deadSearch',
    clientIndex: attempt.clientIndex,
    seq: attempt.seq,
    stage: 'search',
    matchId: attempt.matchId,
    detail: {
      reason,
      elapsedMs: Date.now() - search.startedAt,
      reconnected: search.reconnectedAt !== null,
    },
  });
}

function checkDraftRollback(metrics: FleetMetrics, attempt: MatchAttempt, reason: string): void {
  const draft = attempt.draftFlap;
  if (!draft || draft.reported || draft.sawCommittedBan) return;
  if (draft.replayStartedAt === null && reason !== 'attempt_closed') return;
  draft.reported = true;
  metrics.banRollback++;
  metrics.bootStageViolations.push({
    detector: 'banRollback',
    clientIndex: attempt.clientIndex,
    seq: attempt.seq,
    stage: 'draft',
    matchId: attempt.matchId,
    detail: {
      reason,
      committedCategoryId: draft.committedCategoryId,
      replayStarted: draft.replayStartedAt !== null,
      reconnected: draft.reconnectedAt !== null,
      elapsedMs: Date.now() - draft.startedAt,
    },
  });
}

function finishLegacyDraft(metrics: FleetMetrics, attempt: MatchAttempt, reason: string): void {
  if (attempt.legacyDraftStartedAt === null || attempt.legacyDraftCompletedAt !== null) return;
  const completedAt = Date.now();
  const elapsedMs = completedAt - attempt.legacyDraftStartedAt;
  if (elapsedMs > LEGACY_DRAFT_STALL_BUDGET_MS) {
    reportLegacyDraftStall(metrics, attempt, reason, elapsedMs);
  }
  attempt.legacyDraftCompletedAt = completedAt;
}

function reportLegacyDraftStall(
  metrics: FleetMetrics,
  attempt: MatchAttempt,
  reason: string,
  elapsedMs = attempt.legacyDraftStartedAt === null ? 0 : Date.now() - attempt.legacyDraftStartedAt
): void {
  if (attempt.legacyDraftStartedAt === null || attempt.legacyDraftCompletedAt !== null || attempt.legacyDraftStallReported) {
    return;
  }
  attempt.legacyDraftStallReported = true;
  metrics.legacyDraftStall++;
  metrics.bootStageViolations.push({
    detector: 'legacyDraftStall',
    clientIndex: attempt.clientIndex,
    seq: attempt.seq,
    stage: 'legacy',
    matchId: attempt.matchId,
    detail: {
      reason,
      elapsedMs,
      budgetMs: LEGACY_DRAFT_STALL_BUDGET_MS,
      draftAutoBanMs: DRAFT_AUTO_BAN_MS,
    },
  });
}

function reportGateAbandonIfNeeded(
  metrics: FleetMetrics,
  attempt: MatchAttempt,
  reason: string,
  detail: Record<string, unknown>
): void {
  const gate = attempt.gateFlap;
  if (!gate || gate.reported || !gate.reconnectedWithinGrace || gate.q0At !== null) return;
  gate.reported = true;
  metrics.gateAbandon++;
  metrics.bootStageViolations.push({
    detector: 'gateAbandon',
    clientIndex: attempt.clientIndex,
    seq: attempt.seq,
    stage: 'gate',
    matchId: gate.matchId ?? attempt.matchId,
    detail: {
      reason,
      elapsedMs: Date.now() - gate.startedAt,
      reconnectedWithinGrace: gate.reconnectedWithinGrace,
      sawGateStateOrRejoin: gate.sawGateStateOrRejoin,
      ...detail,
    },
  });
}

function noteGateError(state: ClientState, client: StagingClient, metrics: FleetMetrics, payload: unknown): void {
  const attempt = state.current;
  if (!attempt) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const code = (payload as { code?: unknown }).code;
  if (code !== 'MATCH_ABANDONED') return;
  reportGateAbandonIfNeeded(metrics, attempt, 'match_abandoned_error', {
    connected: client.socket.connected,
  });
}

function scheduleFlaps(
  state: ClientState,
  cfg: SocketFleetConfig,
  metrics: FleetMetrics,
  attempt: MatchAttempt
): void {
  if (!hasFlapStage(cfg, 'match')) return;
  const count = poisson(cfg.flapRate);
  for (let i = 0; i < count; i++) {
    const delayMs = 8_000 + Math.random() * 150_000;
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      void flapSocket(state, cfg, metrics, attempt, 'match');
    }, delayMs);
    attempt.timers.add(timer);
  }
}

function newAttempt(clientIndex: number, seq: number): MatchAttempt {
  return {
    clientIndex,
    seq,
    queueJoinedAt: Date.now(),
    matchId: null,
    startedAt: null,
    completedAt: null,
    performedFlaps: 0,
    maxDisconnectCountInflation: 0,
    stageFlaps: new Set(),
    searchFlap: null,
    draftFlap: null,
    gateFlap: null,
    legacyDraftStartedAt: null,
    legacyDraftCompletedAt: null,
    legacyDraftStallReported: false,
    answerSentAt: new Map(),
    lastRoundResultAt: null,
    timers: new Set(),
    closed: false,
  };
}

function closeAttempt(metrics: FleetMetrics, attempt: MatchAttempt, abandoned: boolean): void {
  if (attempt.closed) return;
  for (const timer of attempt.timers) clearTimeout(timer);
  attempt.timers.clear();
  checkSearchFlap(metrics, attempt, 'attempt_closed');
  checkDraftRollback(metrics, attempt, 'attempt_closed');
  reportLegacyDraftStall(metrics, attempt, 'attempt_closed');
  if (abandoned) reportGateAbandonIfNeeded(metrics, attempt, 'attempt_closed_without_q0', {});
  if (abandoned && attempt.startedAt !== null && attempt.completedAt === null) metrics.abandons++;
  metrics.disconnectCountInflation += attempt.maxDisconnectCountInflation;
  attempt.closed = true;
}

function shouldStart(seq: number, cfg: SocketFleetConfig, stopStartingAt: number | null): boolean {
  if (cfg.matchesPerClient !== undefined && seq >= cfg.matchesPerClient) return false;
  if (stopStartingAt !== null && Date.now() >= stopStartingAt) return false;
  return true;
}

async function waitConnected(client: StagingClient, ms: number): Promise<boolean> {
  if (client.socket.connected) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.socket.once('connect', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

function poisson(mean: number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

function latencyReport(samples: number[]): LatencyReport {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

function formatHist(hist: Record<string, number>): string {
  const entries = Object.entries(hist).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join(' ') : 'none';
}

function addHist(hist: Record<string, number>, key: string): void {
  hist[key] = (hist[key] ?? 0) + 1;
}

function answerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

function newMetrics(): FleetMetrics {
  return {
    matchesStarted: 0,
    matchesCompleted: 0,
    forfeits: 0,
    abandons: 0,
    wrongfulForfeits: 0,
    deadSearch: 0,
    banRollback: 0,
    gateAbandon: 0,
    legacyDraftStall: 0,
    flapsPerformed: 0,
    disconnectCountInflation: 0,
    draftResetThenReplay: 0,
    draftMergedReplay: 0,
    bootStageViolations: [],
    queueJoinToMatchStartMs: [],
    answerToAckMs: [],
    roundResultToNextQuestionMs: [],
    roundResultToNextQuestionNormalMs: [],
    roundResultToNextQuestionPenaltyMs: [],
    socketErrors: {},
    disconnectReasons: {},
  };
}

function errorTag(payload: unknown): string {
  if (payload instanceof Error) return `error:${payload.message}`;
  if (payload && typeof payload === 'object') {
    const p = payload as { code?: unknown; message?: unknown };
    if (typeof p.code === 'string') return `server:${p.code}`;
    if (typeof p.message === 'string') return `server:${p.message}`;
  }
  return `server:${String(payload)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface FinalResultsPayload {
  matchId?: string;
  winnerId?: string | null;
  winnerDecisionMethod?: string | null;
  players?: Record<string, unknown>;
}

function isWrongfulForfeit(payload: FinalResultsPayload, userId: string, connected: boolean): boolean {
  return connected
    && payload.winnerDecisionMethod === 'forfeit'
    && typeof payload.winnerId === 'string'
    && payload.winnerId !== userId
    && Boolean(payload.players?.[userId]);
}
