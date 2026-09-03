import { setTimeout as sleep } from 'node:timers/promises';

import {
  autoAnswer,
  autoDraft,
  autoHalftime,
  autoRecover,
} from '../../game-regression/staging/bot-behaviors.mjs';
import { connectStaging, type StagingClient } from '../../game-regression/staging/staging-client.mjs';
import type { ChaosUser } from './auth.js';
import { assertSocketTargetSafe } from './socket-fleet.js';

/**
 * Lobby-lifecycle storylines. Every scenario is the UGLY middle the happy-path
 * fleets skip: players who create a lobby and walk away, hosts who vanish
 * while a guest is joining, tabs closed mid-match — and then the same players
 * pressing Play Ranked afterwards. The server's waiting-lobby disconnect
 * cleanup is a 15s in-process timer (lobby-connect.service.ts), so every
 * "vanish" storyline waits past that grace before judging.
 */
export type ScenarioKind =
  | 'create_abandon'
  | 'create_leave'
  | 'guest_disconnect'
  | 'host_disconnect_during_join'
  | 'reload_within_grace'
  | 'start_play'
  | 'start_vanish'
  | 'auction_abandon'
  | 'party_abandon'
  | 'two_tabs_drop_one'
  | 'abandon_then_restart';

export interface ScenarioSpec {
  kind: ScenarioKind;
  users: number;
  weight: number;
  /** After the storyline, reconnect every user and press Play Ranked. */
  rankedProbe: boolean;
  /** A ranked block by an ACTIVE MATCH is legitimate for this storyline. */
  activeMatchBlockOk: boolean;
  /** The storyline leaves its lobby behind on purpose (ageing applies). */
  abandons?: boolean;
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  { kind: 'create_abandon', users: 1, weight: 15, rankedProbe: true, activeMatchBlockOk: false, abandons: true },
  { kind: 'create_leave', users: 1, weight: 10, rankedProbe: true, activeMatchBlockOk: false },
  { kind: 'guest_disconnect', users: 2, weight: 15, rankedProbe: true, activeMatchBlockOk: false },
  { kind: 'host_disconnect_during_join', users: 2, weight: 10, rankedProbe: true, activeMatchBlockOk: false },
  { kind: 'reload_within_grace', users: 2, weight: 10, rankedProbe: true, activeMatchBlockOk: false },
  { kind: 'start_play', users: 2, weight: 12, rankedProbe: true, activeMatchBlockOk: false },
  { kind: 'start_vanish', users: 2, weight: 8, rankedProbe: true, activeMatchBlockOk: true },
  { kind: 'auction_abandon', users: 2, weight: 12, rankedProbe: true, activeMatchBlockOk: false, abandons: true },
  { kind: 'party_abandon', users: 3, weight: 8, rankedProbe: true, activeMatchBlockOk: false, abandons: true },
  { kind: 'two_tabs_drop_one', users: 1, weight: 6, rankedProbe: true, activeMatchBlockOk: false },
  // Deterministic version of the prod leak: the backend restarts INSIDE the
  // 15s disconnect grace, so the cleanup timer is lost for sure. Only planned
  // when the runner can restart the backend (local --manage-backend).
  { kind: 'abandon_then_restart', users: 2, weight: 6, rankedProbe: true, activeMatchBlockOk: false, abandons: true },
];

export interface LobbyFleetConfig {
  apiBase: string;
  users: ChaosUser[];
  concurrency: number;
  rampSec: number;
  /** ms to wait after a hard disconnect before judging server-side cleanup. */
  graceWaitMs: number;
  scenarioKinds?: ScenarioKind[];
  seed?: number;
  /** Restart the backend now (throttled by the caller); enables abandon_then_restart. */
  requestRestart?: () => Promise<boolean>;
  /** Upper bound on abandon_then_restart storylines planned (one restart each). */
  maxRestartScenarios?: number;
  /**
   * Backdate a lobby's updated_at by N minutes right before its ranked probe.
   * The server's stranded-lobby heal only fires past a 30-minute idle
   * threshold; ageing lets a 10-minute run judge that heal.
   */
  ageLobby?: (lobbyId: string, minutes: number) => Promise<void>;
  ageStrandedMinutes?: number;
  /** How many backend restarts happened since `sinceMs` (managed backend only). */
  restartsSince?: (sinceMs: number) => number;
  onScenarioDone?: (result: ScenarioResult) => void;
}

export type RankedProbeOutcome =
  | 'started'
  | 'blocked_waiting_lobby'
  | 'blocked_active_lobby'
  | 'blocked_active_match'
  | 'blocked_queue'
  | 'blocked_unknown'
  | 'insufficient_tickets'
  | 'paired'
  | 'leave_unconfirmed'
  | 'no_response'
  | 'connect_failed';

export interface RankedProbeResult {
  userId: string;
  outcome: RankedProbeOutcome;
  ok: boolean;
  detail: string;
  latencyMs: number | null;
}

export interface ScenarioResult {
  index: number;
  kind: ScenarioKind;
  userIds: string[];
  lobbyId: string | null;
  matchIds: string[];
  ok: boolean;
  stage: string;
  detail: string;
  durationMs: number;
  rankedProbes: RankedProbeResult[];
  socketErrors: Array<{ code?: string; message?: string }>;
  /**
   * The storyline's server-side cleanup expectation was not met, but a
   * backend restart hit inside the window — the in-process timer was lost,
   * which is the documented leak, and the ranked probe then judges the heal.
   */
  restartDisrupted: boolean;
}

export interface LobbyFleetSummary {
  startedAt: string;
  endedAt: string;
  elapsedSec: number;
  users: number;
  scenariosPlanned: number;
  scenariosOk: number;
  scenariosFailed: number;
  byKind: Record<string, { planned: number; ok: number; failed: number; failuresByStage: Record<string, number> }>;
  rankedProbe: {
    total: number;
    ok: number;
    byOutcome: Record<string, number>;
    /** Probes that failed because a lobby the user had left still blocked them. */
    lobbyBlocks: Array<{ scenario: ScenarioKind; index: number; userId: string; detail: string }>;
  };
  socketErrors: number;
  /** storylines whose cleanup expectation was voided by a mid-storyline restart */
  restartDisrupted: number;
  results: ScenarioResult[];
}

const CONNECT_TIMEOUT_MS = 30_000;
const ACK_TIMEOUT_MS = 15_000;
const LOBBY_STATE_TIMEOUT_MS = 30_000;
const MATCH_START_TIMEOUT_MS = 90_000;
const MATCH_FINISH_TIMEOUT_MS = 420_000;
const RANKED_PROBE_TIMEOUT_MS = 12_000;
const HYDRATION_SETTLE_MS = 1_500;
const RETRYABLE_LOBBY_CODES = new Set([
  'TRANSITION_IN_PROGRESS', 'LOBBY_BUSY', 'LOBBY_SETTINGS_LOCKED', 'LOBBY_READY_LOCKED',
]);

interface LobbyStatePayload {
  lobbyId?: string;
  status?: string;
  inviteCode?: string | null;
  hostUserId?: string;
  isPublic?: boolean;
  members?: Array<{ userId: string; isReady?: boolean }>;
  settings?: { gameMode?: string };
}

interface SessionStateLike {
  state?: string;
  activeMatchId?: string | null;
  waitingLobbyId?: string | null;
  primaryLobbyStatus?: 'waiting' | 'active' | null;
  queueSearchId?: string | null;
}

class ScenarioFailure extends Error {
  constructor(readonly stage: string, detail: string) {
    super(detail);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planScenarios(
  userCount: number,
  kinds: readonly ScenarioSpec[],
  random: () => number,
  maxRestartScenarios = Number.POSITIVE_INFINITY,
): ScenarioSpec[] {
  const totalWeight = kinds.reduce((sum, spec) => sum + spec.weight, 0);
  const plan: ScenarioSpec[] = [];
  let remaining = userCount;
  const restartsPlanned = (): number => plan.filter((spec) => spec.kind === 'abandon_then_restart').length;
  const allowed = (spec: ScenarioSpec): boolean =>
    spec.kind !== 'abandon_then_restart' || restartsPlanned() < maxRestartScenarios;
  // Every storyline runs at least once when the fleet is big enough; the
  // weighted draw only decides the mix beyond that floor.
  for (const spec of kinds) {
    if (spec.users > remaining || !allowed(spec)) continue;
    plan.push(spec);
    remaining -= spec.users;
  }
  while (remaining > 0) {
    const eligible = kinds.filter((spec) => spec.users <= remaining && allowed(spec));
    if (eligible.length === 0) break;
    let roll = random() * totalWeight;
    let pick = eligible[eligible.length - 1]!;
    for (const spec of eligible) {
      roll -= spec.weight;
      if (roll <= 0) { pick = spec; break; }
    }
    plan.push(pick);
    remaining -= pick.users;
  }
  return plan;
}

export async function runLobbyLifecycleFleet(cfg: LobbyFleetConfig): Promise<LobbyFleetSummary> {
  assertSocketTargetSafe(cfg.apiBase);
  const random = mulberry32(cfg.seed ?? 1337);
  const kinds = (cfg.scenarioKinds?.length
    ? SCENARIOS.filter((spec) => cfg.scenarioKinds!.includes(spec.kind))
    : SCENARIOS
  ).filter((spec) => spec.kind !== 'abandon_then_restart' || Boolean(cfg.requestRestart));
  const plan = planScenarios(cfg.users.length, kinds, random, cfg.maxRestartScenarios);
  const pool = [...cfg.users];
  const assignments = plan.map((spec, index) => ({ spec, index, users: pool.splice(0, spec.users) }));

  const startedAtMs = Date.now();
  const results: ScenarioResult[] = new Array(assignments.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const slot = next++;
      if (slot >= assignments.length) return;
      const { spec, index, users } = assignments[slot]!;
      const rampMs = assignments.length > 1
        ? Math.round(cfg.rampSec * 1_000 * index / assignments.length)
        : 0;
      const waitMs = rampMs - (Date.now() - startedAtMs);
      if (waitMs > 0) await sleep(waitMs);
      const result = await runScenario(index, spec, users, cfg);
      results[index] = result;
      cfg.onScenarioDone?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, assignments.length) }, worker));
  const endedAtMs = Date.now();

  const byKind: LobbyFleetSummary['byKind'] = {};
  const byOutcome: Record<string, number> = {};
  const lobbyBlocks: LobbyFleetSummary['rankedProbe']['lobbyBlocks'] = [];
  let scenariosOk = 0;
  let restartDisrupted = 0;
  let probeTotal = 0;
  let probeOk = 0;
  let socketErrors = 0;
  for (const result of results) {
    const bucket = byKind[result.kind] ??= { planned: 0, ok: 0, failed: 0, failuresByStage: {} };
    bucket.planned++;
    if (result.ok) { bucket.ok++; scenariosOk++; } else {
      bucket.failed++;
      bucket.failuresByStage[result.stage] = (bucket.failuresByStage[result.stage] ?? 0) + 1;
    }
    socketErrors += result.socketErrors.length;
    if (result.restartDisrupted) restartDisrupted++;
    for (const probe of result.rankedProbes) {
      probeTotal++;
      if (probe.ok) probeOk++;
      byOutcome[probe.outcome] = (byOutcome[probe.outcome] ?? 0) + 1;
      if (probe.outcome === 'blocked_waiting_lobby' || probe.outcome === 'blocked_active_lobby') {
        lobbyBlocks.push({ scenario: result.kind, index: result.index, userId: probe.userId, detail: probe.detail });
      }
    }
  }
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedSec: (endedAtMs - startedAtMs) / 1_000,
    users: cfg.users.length,
    scenariosPlanned: assignments.length,
    scenariosOk,
    scenariosFailed: assignments.length - scenariosOk,
    byKind,
    rankedProbe: { total: probeTotal, ok: probeOk, byOutcome, lobbyBlocks },
    socketErrors,
    restartDisrupted,
    results,
  };
}

async function runScenario(
  index: number,
  spec: ScenarioSpec,
  users: ChaosUser[],
  cfg: LobbyFleetConfig,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const clients = new Map<string, StagingClient>();
  const extraClients: StagingClient[] = [];
  const errors: ScenarioResult['socketErrors'] = [];
  const ctx: ScenarioContext = {
    cfg,
    users,
    lobbyId: null,
    matchIds: [],
    connect: async (user) => {
      const client = connectStaging(cfg.apiBase, user.token, user.userId);
      clients.set(user.userId, client);
      if (!(await waitConnected(client, CONNECT_TIMEOUT_MS))) {
        markDisconnected(user.userId);
        throw new ScenarioFailure('connect', `user ${user.userId.slice(0, 8)} failed to connect`);
      }
      trackPresence(client, user.userId);
      await sleep(HYDRATION_SETTLE_MS);
      return client;
    },
    track: (user, client) => {
      extraClients.push(client);
      trackPresence(client, user.userId);
    },
    dropSocket: (user) => {
      const client = clients.get(user.userId);
      if (!client) return;
      client.socket.disconnect();
      clients.delete(user.userId);
    },
  };

  let ok = true;
  let stage = 'done';
  let detail = '';
  let restartDisrupted = false;
  try {
    await STORYLINES[spec.kind](ctx);
  } catch (error) {
    ok = false;
    if (error instanceof ScenarioFailure) {
      stage = error.stage;
      detail = error.message;
      if (CLEANUP_STAGES.has(error.stage) && (cfg.restartsSince?.(startedAt) ?? 0) > 0) {
        restartDisrupted = true;
        ok = true;
        detail = `${detail} (backend restarted mid-storyline; cleanup timer lost — judged by the ranked probe)`;
      }
    } else {
      stage = 'exception';
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  for (const client of [...clients.values(), ...extraClients]) {
    for (const event of client.trace.byEvent('error')) {
      const payload = event.payload as { code?: string; message?: string };
      if (payload?.code === 'CONNECT_ERROR') continue;
      errors.push({ code: payload?.code, message: payload?.message?.slice(0, 200) });
    }
  }

  // Every socket is gone before the probe so the server's disconnect grace is
  // the only thing keeping a membership alive. Waiting past it is the point.
  for (const user of users) ctx.dropSocket(user);
  for (const client of extraClients) client.socket.disconnect();
  const rankedProbes: RankedProbeResult[] = [];
  if (spec.rankedProbe) {
    // Contained like the storyline: one rejected DB call or probe must not
    // take the whole fleet (and its report) down with it.
    try {
      await sleep(cfg.graceWaitMs);
      // Whatever the storyline left behind is, by now, an abandoned lobby (every
      // socket is gone) — age it so the probe judges the heal, not the 30-min wait.
      if (ctx.lobbyId && cfg.ageLobby && cfg.ageStrandedMinutes) {
        await cfg.ageLobby(ctx.lobbyId, cfg.ageStrandedMinutes);
      }
      for (const user of users) {
        const probe = await rankedProbe(cfg.apiBase, user, spec);
        rankedProbes.push(probe);
        if (!probe.ok && ok) {
          ok = false;
          stage = 'ranked_probe';
          detail = `${probe.outcome}: ${probe.detail}`;
        }
      }
    } catch (error) {
      ok = false;
      stage = 'probe_phase';
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    index,
    kind: spec.kind,
    userIds: users.map((user) => user.userId),
    lobbyId: ctx.lobbyId,
    matchIds: ctx.matchIds,
    ok,
    stage,
    detail,
    durationMs: Date.now() - startedAt,
    rankedProbes,
    socketErrors: errors,
    restartDisrupted,
  };
}

/** Stages that wait on the server's 15s in-process disconnect cleanup. */
const CLEANUP_STAGES = new Set(['guest_cleanup', 'host_transfer']);

interface ScenarioContext {
  cfg: LobbyFleetConfig;
  users: ChaosUser[];
  lobbyId: string | null;
  matchIds: string[];
  connect: (user: ChaosUser) => Promise<StagingClient>;
  /** Register an extra socket (second tab) so end-of-storyline cleanup reaches it. */
  track: (user: ChaosUser, client: StagingClient) => void;
  dropSocket: (user: ChaosUser) => void;
}

type Storyline = (ctx: ScenarioContext) => Promise<void>;

const STORYLINES: Record<ScenarioKind, Storyline> = {
  async create_abandon(ctx) {
    const host = await ctx.connect(ctx.users[0]!);
    await createLobby(ctx, host);
    ctx.dropSocket(ctx.users[0]!);
  },

  async create_leave(ctx) {
    const host = await ctx.connect(ctx.users[0]!);
    await createLobby(ctx, host);
    const result = await leaveLobby(host);
    if (!result?.ok) throw new ScenarioFailure('leave', `leave ack ${JSON.stringify(result)}`);
    if (!result.closed) throw new ScenarioFailure('leave', 'solo host leave did not close the lobby');
  },

  async guest_disconnect(ctx) {
    const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    const guest = await ctx.connect(guestUser);
    await joinByCode(guest, inviteCode);
    await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2, 'guest_join');
    ctx.dropSocket(guestUser);
    // The host stays. After the grace the guest must be gone from the roster.
    const guestGone = await waitLobbyState(
      host,
      (s) => !(s.members ?? []).some((m) => m.userId === guestUser.userId),
      'guest_cleanup',
      ctx.cfg.graceWaitMs + LOBBY_STATE_TIMEOUT_MS,
    );
    if (guestGone.hostUserId !== hostUser.userId) {
      throw new ScenarioFailure('guest_cleanup', `host changed to ${guestGone.hostUserId}`);
    }
    const result = await leaveLobby(host);
    if (!result?.ok) throw new ScenarioFailure('leave', `host leave ack ${JSON.stringify(result)}`);
  },

  async host_disconnect_during_join(ctx) {
    const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    const guest = await ctx.connect(guestUser);
    // Race: the join and the host's disconnect are in flight together.
    const joinPromise = joinByCode(guest, inviteCode, { allowNotFound: true });
    ctx.dropSocket(hostUser);
    const join = await joinPromise;
    if (join === 'not_found') return; // lobby already closed — a valid outcome
    // Guest is in. After the grace the guest must own the lobby (host transfer)
    // or the lobby must have closed cleanly; either way no orphan host row.
    const settled = await waitLobbyState(
      guest,
      (s) => s.status === 'closed'
        || (!(s.members ?? []).some((m) => m.userId === hostUser.userId) && s.hostUserId === guestUser.userId),
      'host_transfer',
      ctx.cfg.graceWaitMs + LOBBY_STATE_TIMEOUT_MS,
    );
    if (settled.status !== 'closed') {
      const result = await leaveLobby(guest);
      if (!result?.ok) throw new ScenarioFailure('leave', `guest leave ack ${JSON.stringify(result)}`);
    }
  },

  async reload_within_grace(ctx) {
    const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    let guest = await ctx.connect(guestUser);
    await joinByCode(guest, inviteCode);
    await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2, 'guest_join');
    guest.socket.emit('lobby:ready', { ready: true });
    await waitLobbyState(host, (s) => (s.members ?? []).some((m) => m.userId === guestUser.userId && m.isReady), 'guest_ready');
    // Page reload: socket gone for a few seconds, well inside the 15s grace.
    ctx.dropSocket(guestUser);
    await sleep(3_000);
    guest = await ctx.connect(guestUser);
    const rejoined = await waitLobbyState(
      guest,
      (s) => s.lobbyId === ctx.lobbyId && (s.members ?? []).some((m) => m.userId === guestUser.userId),
      'reload_rejoin',
    );
    if (rejoined.status !== 'waiting') throw new ScenarioFailure('reload_rejoin', `lobby status ${rejoined.status}`);
    // Past the original grace, the reconnected guest must still be a member.
    await sleep(ctx.cfg.graceWaitMs);
    const still = await freshLobbyState(host, 'post_grace');
    if (!(still.members ?? []).some((m) => m.userId === guestUser.userId)) {
      throw new ScenarioFailure('post_grace', 'reconnected guest was removed by the stale disconnect timer');
    }
    for (const client of [guest, host]) {
      const result = await leaveLobby(client);
      if (!result?.ok) throw new ScenarioFailure('leave', `leave ack ${JSON.stringify(result)}`);
    }
  },

  async start_play(ctx) {
    const { host, guest, matchId } = await startTwoPlayerMatch(ctx);
    const complete = await host.waitFor(
      () => hasFinal(host, matchId) && hasFinal(guest, matchId),
      MATCH_FINISH_TIMEOUT_MS,
    );
    if (!complete) {
      throw new ScenarioFailure('match_finish', `final results host=${hasFinal(host, matchId)} guest=${hasFinal(guest, matchId)}`);
    }
  },

  async start_vanish(ctx) {
    await startTwoPlayerMatch(ctx);
    // Both tabs closed right after kickoff. The match sweeper owns the rest;
    // the ranked probe only fails if a LOBBY (not the match) blocks the user.
    for (const user of ctx.users) ctx.dropSocket(user);
  },

  async auction_abandon(ctx) {
    const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    host.socket.emit('lobby:update_settings', { gameMode: 'auction' });
    await waitLobbyState(host, (s) => s.settings?.gameMode === 'auction', 'auction_settings');
    const guest = await ctx.connect(guestUser);
    await joinByCode(guest, inviteCode);
    await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2, 'guest_join');
    host.socket.emit('lobby:ready', { ready: true });
    guest.socket.emit('lobby:ready', { ready: true });
    await waitLobbyState(host, (s) => (s.members ?? []).every((m) => m.isReady), 'all_ready');
    // The exact population the Aug-28 prod sweep found: a friendly auction
    // lobby nobody comes back to.
    ctx.dropSocket(guestUser);
    ctx.dropSocket(hostUser);
  },

  async two_tabs_drop_one(ctx) {
    const user = ctx.users[0]!;
    const tabA = await ctx.connect(user);
    await createLobby(ctx, tabA);
    // Second tab: connect hydration attaches every socket of the user.
    const tabB = connectStaging(ctx.cfg.apiBase, user.token, user.userId);
    ctx.track(user, tabB);
    if (!(await waitConnected(tabB, CONNECT_TIMEOUT_MS))) throw new ScenarioFailure('connect', 'second tab failed to connect');
    await waitLobbyState(tabB, (s) => s.lobbyId === ctx.lobbyId, 'second_tab_attach');
    tabA.socket.disconnect();
    await sleep(ctx.cfg.graceWaitMs);
    const still = await freshLobbyState(tabB, 'one_tab_left');
    if (!(still.members ?? []).some((m) => m.userId === user.userId) || still.status !== 'waiting') {
      throw new ScenarioFailure('one_tab_left', `closing one tab removed the player (status=${still.status})`);
    }
    const result = await leaveLobby(tabB);
    if (!result?.ok) throw new ScenarioFailure('leave', `leave ack ${JSON.stringify(result)}`);
  },

  async abandon_then_restart(ctx) {
    const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    const guest = await ctx.connect(guestUser);
    await joinByCode(guest, inviteCode);
    await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2, 'guest_join');
    ctx.dropSocket(hostUser);
    ctx.dropSocket(guestUser);
    // Restart inside the grace window: the in-process cleanup timers die
    // with the old process. If nothing else heals this lobby, it is stranded.
    const restarted = await ctx.cfg.requestRestart!();
    if (!restarted) throw new ScenarioFailure('restart', 'backend restart was not performed (throttled or failed)');
  },

  async party_abandon(ctx) {
    const [hostUser, ...guests] = ctx.users as [ChaosUser, ChaosUser, ChaosUser];
    const host = await ctx.connect(hostUser);
    const { inviteCode } = await createLobby(ctx, host);
    for (const guestUser of guests) {
      const guest = await ctx.connect(guestUser);
      await joinByCode(guest, inviteCode);
    }
    await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 3, 'guests_join');
    await waitLobbyState(host, (s) => s.settings?.gameMode === 'friendly_party_quiz', 'party_promote');
    for (const user of ctx.users) ctx.dropSocket(user);
  },
};

async function startTwoPlayerMatch(ctx: ScenarioContext): Promise<{ host: StagingClient; guest: StagingClient; matchId: string }> {
  const [hostUser, guestUser] = ctx.users as [ChaosUser, ChaosUser];
  const host = await ctx.connect(hostUser);
  attachBots(host);
  const { inviteCode } = await createLobby(ctx, host);
  const guest = await ctx.connect(guestUser);
  attachBots(guest);
  await joinByCode(guest, inviteCode);
  await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2, 'guest_join');
  host.socket.emit('lobby:ready', { ready: true });
  guest.socket.emit('lobby:ready', { ready: true });
  await waitLobbyState(host, (s) => (s.members?.length ?? 0) >= 2 && (s.members ?? []).every((m) => m.isReady), 'all_ready');
  host.socket.emit('lobby:start', {});
  const started = await host.waitFor(
    () => host.count('match:start') > 0 && host.count('match:question') > 0
      && guest.count('match:start') > 0,
    MATCH_START_TIMEOUT_MS,
  );
  const matchId = host.latest<{ matchId?: string }>('match:start')?.matchId;
  const guestMatchId = guest.latest<{ matchId?: string }>('match:start')?.matchId;
  if (!started || !matchId || guestMatchId !== matchId) {
    const lastError = host.latest<{ code?: string }>('error')?.code ?? 'none';
    throw new ScenarioFailure('match_start', `kickoff host=${matchId ?? 'none'} guest=${guestMatchId ?? 'none'} (last error ${lastError})`);
  }
  ctx.matchIds.push(matchId);
  return { host, guest, matchId };
}

async function createLobby(ctx: ScenarioContext, host: StagingClient): Promise<{ lobbyId: string; inviteCode: string }> {
  const ack = await emitAck<{ ok: boolean; lobbyId?: string | null; inviteCode?: string | null; code?: string; message?: string }>(
    host, 'lobby:create', { mode: 'friendly' },
  );
  if (!ack?.ok) throw new ScenarioFailure('create', `create ack ${JSON.stringify(ack)}`);
  const state = await waitLobbyState(host, (s) => Boolean(s.inviteCode) && Boolean(s.lobbyId), 'create');
  ctx.lobbyId = state.lobbyId!;
  return { lobbyId: state.lobbyId!, inviteCode: state.inviteCode! };
}

async function joinByCode(
  guest: StagingClient,
  inviteCode: string,
  options: { allowNotFound?: boolean } = {},
): Promise<'joined' | 'not_found'> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ack = await emitAck<{ ok: boolean; code?: string; retryable?: boolean; message?: string }>(
      guest, 'lobby:join_by_code', { inviteCode },
    );
    if (ack?.ok) return 'joined';
    // Only "that lobby is gone" is a legitimate race outcome; INVALID_INVITE
    // would mean the code we were just handed is malformed.
    if (options.allowNotFound && ack?.code === 'LOBBY_NOT_FOUND') return 'not_found';
    if (ack && (ack.retryable || RETRYABLE_LOBBY_CODES.has(ack.code ?? ''))) {
      await sleep(300 + attempt * 300);
      continue;
    }
    throw new ScenarioFailure('join', `join ack ${JSON.stringify(ack)}`);
  }
  throw new ScenarioFailure('join', 'join kept returning retryable errors');
}

async function leaveLobby(client: StagingClient): Promise<{ ok: boolean; closed?: boolean; code?: string } | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ack = await emitAck<{ ok: boolean; closed?: boolean; code?: string; retryable?: boolean }>(
      client, 'lobby:leave', {},
    );
    if (ack?.ok) return ack;
    if (ack && (ack.retryable || RETRYABLE_LOBBY_CODES.has(ack.code ?? ''))) {
      await sleep(300 + attempt * 300);
      continue;
    }
    return ack;
  }
  return null;
}

/**
 * lobby:state is only pushed on change, so "still a member after N seconds"
 * needs a fresh broadcast, not the last cached payload. A no-op settings
 * write makes the server re-emit the authoritative state to every member.
 */
async function freshLobbyState(client: StagingClient, stage: string): Promise<LobbyStatePayload> {
  const before = client.count('lobby:state');
  const current = client.latest<LobbyStatePayload>('lobby:state');
  // An unchanged settings write is a server-side no-op (no broadcast), so
  // flip visibility — harmless for a harness lobby and always a real change.
  client.socket.emit('lobby:update_settings', {
    gameMode: current?.settings?.gameMode ?? 'friendly_possession',
    isPublic: !(current?.isPublic ?? false),
  });
  return waitLobbyState(client, () => client.count('lobby:state') > before, stage);
}

async function waitLobbyState(
  client: StagingClient,
  predicate: (state: LobbyStatePayload) => boolean,
  stage: string,
  timeoutMs = LOBBY_STATE_TIMEOUT_MS,
): Promise<LobbyStatePayload> {
  const check = (): boolean => {
    const latest = client.latest<LobbyStatePayload>('lobby:state');
    return Boolean(latest) && predicate(latest!);
  };
  if (!(await client.waitFor(check, timeoutMs))) {
    const latest = client.latest<LobbyStatePayload>('lobby:state');
    const lastError = client.latest<{ code?: string; message?: string }>('error');
    throw new ScenarioFailure(
      stage,
      `timeout waiting for lobby state; last status=${latest?.status ?? 'none'} members=${latest?.members?.length ?? 0}`
      + `${lastError?.code ? ` lastError=${lastError.code}` : ''}`,
    );
  }
  return client.latest<LobbyStatePayload>('lobby:state')!;
}

const RANKED_TERMINAL_ERROR_CODES = new Set([
  'INSUFFICIENT_TICKETS', 'RANKED_QUEUE_JOIN_ERROR', 'MATCH_PREPARATION_FAILED',
  'DB_WRITE_OUTAGE', 'TRANSITION_IN_PROGRESS', 'QUEUE_UNAVAILABLE',
]);

interface SnapshotCarrier {
  code?: string;
  message?: string;
  reason?: string;
  stateSnapshot?: SessionStateLike;
  meta?: { stateSnapshot?: SessionStateLike };
}

async function rankedProbe(apiBase: string, user: ChaosUser, spec: ScenarioSpec): Promise<RankedProbeResult> {
  const client = connectStaging(apiBase, user.token, user.userId);
  try {
    if (!(await waitConnected(client, CONNECT_TIMEOUT_MS))) {
      return { userId: user.userId, outcome: 'connect_failed', ok: false, detail: 'socket did not connect', latencyMs: null };
    }
    trackPresence(client, user.userId);
    // Post-connect hydration emits its own session:state (and possibly a
    // blocked/error for a stale match). Drain it before judging anything, or a
    // late hydration event would be attributed to the ranked join.
    await client.waitFor(() => client.count('session:state') > 0, 3_000);
    await sleep(HYDRATION_SETTLE_MS);
    // A search left over from an earlier probe would be resumed, not started.
    if (client.latest<SessionStateLike>('session:state')?.queueSearchId) {
      client.socket.emit('ranked:queue_leave');
      await client.waitFor(() => !client.latest<SessionStateLike>('session:state')?.queueSearchId, 5_000);
    }
    client.trace.reset();
    // Two probes inside the same matchmaking tick would be paired with each
    // other and dragged into a draft. Serialize only the join→leave window.
    const release = await acquireProbeSlot();
    const sentAt = Date.now();
    try {
      client.socket.emit('ranked:queue_join', { source: 'mode_select' });
      return await judgeProbe(client, user, spec, sentAt);
    } finally {
      release();
    }
  } finally {
    client.disconnect();
    markDisconnected(user.userId);
  }
}

let probeQueue: Promise<void> = Promise.resolve();
function acquireProbeSlot(): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const previous = probeQueue;
  probeQueue = previous.then(() => gate);
  return previous.then(() => release);
}

function blockingSnapshot(client: StagingClient): SessionStateLike | null {
  // The blocker can arrive as a bare session:state, inside session:blocked,
  // or inside error.meta — all three carry the same snapshot shape.
  const candidates: Array<SessionStateLike | undefined> = [
    client.latest<SessionStateLike>('session:state'),
    client.latest<SnapshotCarrier>('session:blocked')?.stateSnapshot,
    client.latest<SnapshotCarrier>('error')?.meta?.stateSnapshot,
  ];
  for (const snapshot of candidates) {
    if (snapshot && (snapshot.waitingLobbyId || snapshot.activeMatchId || snapshot.state === 'CORRUPT_MULTI_STATE')) {
      return snapshot;
    }
  }
  return null;
}

async function judgeProbe(
  client: StagingClient,
  user: ChaosUser,
  spec: ScenarioSpec,
  sentAt: number,
): Promise<RankedProbeResult> {
  // A session:state alone is not a verdict — the server also emits one on
  // the way INTO the queue. Only a snapshot naming a blocker counts.
  const isStarted = (): boolean => client.count('ranked:search_started') > 0
    || client.latest<SessionStateLike>('session:state')?.state === 'IN_QUEUE';
  const terminalError = (): SnapshotCarrier | undefined => {
    const error = client.latest<SnapshotCarrier>('error');
    return error && RANKED_TERMINAL_ERROR_CODES.has(error.code ?? '') ? error : undefined;
  };
  const started = await client.waitFor(
    () => isStarted()
      || blockingSnapshot(client) !== null
      || client.count('session:blocked') > 0
      || terminalError() !== undefined,
    RANKED_PROBE_TIMEOUT_MS,
  );
  if (isStarted()) {
    const latencyMs = Date.now() - sentAt;
    client.socket.emit('ranked:queue_leave');
    // "Started" is only a pass once the search is provably gone again —
    // otherwise a probe could consume a ticket and strand a draft.
    const left = await client.waitFor(
      () => client.count('ranked:queue_left') > 0
        || client.count('ranked:match_found') > 0
        || client.latest<SessionStateLike>('session:state')?.queueSearchId === null,
      8_000,
    );
    if (client.count('ranked:match_found') > 0) {
      return { userId: user.userId, outcome: 'paired', ok: false, detail: 'search was claimed before the leave landed (draft created — clean up the run)', latencyMs };
    }
    if (!left) {
      return { userId: user.userId, outcome: 'leave_unconfirmed', ok: false, detail: 'no queue_left / cleared session after ranked:queue_leave', latencyMs };
    }
    return { userId: user.userId, outcome: 'started', ok: true, detail: '', latencyMs };
  }
  const error = terminalError();
  if (error?.code === 'INSUFFICIENT_TICKETS') {
    return { userId: user.userId, outcome: 'insufficient_tickets', ok: false, detail: 'ticket preflight failed (fixture problem)', latencyMs: null };
  }
  const session = blockingSnapshot(client) ?? client.latest<SessionStateLike>('session:state');
  if (!started) {
    return { userId: user.userId, outcome: 'no_response', ok: false, detail: 'no search_started / blocker within timeout', latencyMs: null };
  }
  const detail = `state=${session?.state ?? '?'} lobby=${session?.waitingLobbyId?.slice(0, 8) ?? 'none'}`
    + ` lobbyStatus=${session?.primaryLobbyStatus ?? 'none'} match=${session?.activeMatchId?.slice(0, 8) ?? 'none'}`
    + ` queue=${session?.queueSearchId?.slice(0, 8) ?? 'none'}${error?.code ? ` error=${error.code}` : ''}`;
  if (session?.activeMatchId) {
    return { userId: user.userId, outcome: 'blocked_active_match', ok: spec.activeMatchBlockOk, detail, latencyMs: null };
  }
  if (session?.waitingLobbyId) {
    const outcome: RankedProbeOutcome = session.primaryLobbyStatus === 'active' ? 'blocked_active_lobby' : 'blocked_waiting_lobby';
    return { userId: user.userId, outcome, ok: false, detail, latencyMs: null };
  }
  if (session?.queueSearchId) {
    return { userId: user.userId, outcome: 'blocked_queue', ok: false, detail, latencyMs: null };
  }
  return { userId: user.userId, outcome: 'blocked_unknown', ok: false, detail, latencyMs: null };
}

function emitAck<T>(client: StagingClient, event: string, payload: unknown, timeoutMs = ACK_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    client.socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function attachBots(client: StagingClient): void {
  autoAnswer(client, {
    answerPlan: () => {
      const delayMs = 500 + Math.round(Math.random() * 3_000);
      return { mode: Math.random() < 0.68 ? 'correct' : 'wrong', timeMs: delayMs, delayMs };
    },
  });
  autoDraft(client);
  autoHalftime(client);
  autoRecover(client);
}

function hasFinal(client: StagingClient, matchId: string): boolean {
  return client.trace.byEvent('match:final_results')
    .some((event) => (event.payload as { matchId?: string }).matchId === matchId);
}

const AUTH_FAILURE_RE = /authentication|invalid or expired token|unauthorized/i;

/**
 * A real client keeps retrying through a deploy; so does socket.io-client.
 * Only an auth rejection is final — a refused connection during a restart
 * window is exactly the situation the harness must survive, not report.
 */
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
    const onConnectError = (error: Error) => {
      if (AUTH_FAILURE_RE.test(error.message)) finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.socket.once('connect', onConnect);
    client.socket.on('connect_error', onConnectError);
  });
}

/** userId → ms that user's LAST socket went away (null while any is up). */
const presence = new Map<string, number | null>();
const liveSockets = new Map<string, number>();

export function markConnected(userId: string): void {
  presence.set(userId, null);
}

/**
 * Presence follows real socket.io connect/disconnect events (a backend
 * restart drops every socket without the harness asking), reference-counted
 * per user because a storyline may hold two tabs for one player.
 */
function trackPresence(client: StagingClient, userId: string): void {
  const bump = (delta: number) => {
    const next = (liveSockets.get(userId) ?? 0) + delta;
    liveSockets.set(userId, Math.max(0, next));
    if (next > 0) markConnected(userId);
    else markDisconnected(userId);
  };
  if (client.socket.connected) bump(1);
  client.socket.on('connect', () => bump(1));
  client.socket.on('disconnect', () => bump(-1));
}

export function markDisconnected(userId: string): void {
  presence.set(userId, Date.now());
}

/** Users the harness has had NO socket for during at least `sinceMs`. */
export function socketlessUsers(sinceMs: number): string[] {
  const cutoff = Date.now() - sinceMs;
  return [...presence.entries()]
    .filter(([, droppedAt]) => droppedAt !== null && droppedAt <= cutoff)
    .map(([userId]) => userId);
}
