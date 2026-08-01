/**
 * Weekend League socket fleet — the PR7 acceptance harness.
 *
 * Drives a REAL tournament end-to-end against staging (or local): provisions
 * N player identities + M spectators, creates a compressed is_test tournament
 * through the ops API, enters/checks-in over REST, then plays the whole
 * gauntlet over wl:* sockets with configurable accuracy/latency profiles and
 * connection chaos (flaps). Every SLO the launch depends on is measured
 * client-side:
 *
 *  - answer ack latency p50/p95/p99 and zero-lost-answers (an answer sent
 *    with margin before the deadline must never come back `closed`)
 *  - dispatch delivery lateness vs the server emission clock
 *  - elimination exactness (advanced counts match the ladder; eliminated
 *    players stop receiving live dispatches)
 *  - per-player score integrity: sum of accepted acks minus void refunds
 *    equals the final board points for every tracked player on the board
 *  - spectator invariants: no answer key in dispatches, windows only open
 *    after the live deadline, contiguous seq order, one champion
 *
 * PROD GUARD: refuses any api base except localhost / api-staging.
 *
 * Usage:
 *   npx tsx scripts/chaos/wl-fleet.ts --players=100 --spectators=10 \
 *     --flap-rate=0.05 --entry-sec=90 --checkin-sec=45 --final-sec=300 \
 *     [--api=https://api-staging.quizball.io] [--question-ms=10000]
 *
 * Env: WL_OPS_TOKEN (required), plus the chaos auth env used by provisionUsers
 * (STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY or local equivalents).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { provisionUsers, type ChaosUser } from './auth.js';
import { assertSocketTargetSafe } from './socket-fleet.js';

// ── Config ──────────────────────────────────────────────────────────────────

interface WlFleetConfig {
  apiBase: string;
  players: number;
  spectators: number;
  flapRate: number; // probability per player per question of a disconnect/reconnect
  entrySeconds: number;
  checkinSeconds: number;
  toFinalSeconds: number;
  questionTimeMs: number;
  spectatorDelayMs: number;
  opsToken: string;
  /** Fraction of players answering correctly (the rest answer wrong). */
  accuracy: number;
  /** Answer latency window [minMs, maxMs] after playable. */
  answerDelayMinMs: number;
  answerDelayMaxMs: number;
  runTimeoutSec: number;
}

interface AckSample { latencyMs: number; accepted: boolean; reason?: string }

interface PlayerState {
  user: ChaosUser;
  socket: Socket | null;
  subscribed: boolean;
  answersSent: number;
  ackTimeouts: number;
  scoreViolations: Array<{ gameIndex: number; ledger: number; board: number }>;
  entered: boolean;
  checkedIn: boolean;
  finalCheckedIn: boolean;
  eliminated: boolean;
  lastSeq: number;
  clockOffset: number;
  /** attempt_id -> accepted points (refunded on void). */
  scored: Map<string, number>;
  answered: Set<string>;
  score: number;
  acks: AckSample[];
  lostAnswers: number;
  dispatchLatenessMs: number[];
  liveDispatchesAfterElimination: number;
  flaps: number;
  errors: string[];
}

interface SpectatorState {
  user: ChaosUser;
  socket: Socket | null;
  seqs: number[];
  evaluationLeaks: number;
  openWindowLeaks: number;
  dispatches: number;
}

interface WlFleetSummary {
  startedAt: string;
  endedAt: string;
  tournamentId: string;
  players: number;
  spectators: number;
  flapRate: number;
  completed: boolean;
  finalStatus: string;
  championUserId: string | null;
  entered: number;
  checkedIn: number;
  answers: {
    sent: number; acked: number; accepted: number; rejected: number;
    ackTimeouts: number; lost: number;
  };
  ackLatencyMs: { p50: number; p95: number; p99: number; max: number };
  dispatchLatenessMs: { p50: number; p95: number; p99: number; max: number };
  scoreIntegrityViolations: Array<{ userId: string; gameIndex: number; ledger: number; board: number }>;
  ladderBreaks: string[];
  eliminationViolations: number;
  gameResults: Array<{ gameIndex: number; field: number; advanced: number }>;
  spectator: {
    dispatches: number;
    evaluationLeaks: number;
    openWindowLeaks: number;
    seqGaps: number;
  };
  flapsPerformed: number;
  errors: string[];
  slo: Record<string, { pass: boolean; detail: string }>;
}

function parseArgs(argv: string[]): WlFleetConfig {
  const get = (name: string, fallback?: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    const value = raw == null ? fallback : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
    return value;
  };
  const opsToken = process.env.WL_OPS_TOKEN;
  if (!opsToken) throw new Error('WL_OPS_TOKEN env is required (staging Railway variable)');
  return {
    apiBase: get('api', 'https://api-staging.quizball.io')!,
    players: num('players', 100),
    spectators: num('spectators', 10),
    flapRate: num('flap-rate', 0),
    entrySeconds: num('entry-sec', 90),
    checkinSeconds: num('checkin-sec', 45),
    toFinalSeconds: num('final-sec', 240),
    questionTimeMs: num('question-ms', 10_000),
    spectatorDelayMs: num('spec-delay-ms', 30_000),
    accuracy: num('accuracy', 0.7),
    answerDelayMinMs: num('answer-min-ms', 400),
    answerDelayMaxMs: num('answer-max-ms', 6_000),
    opsToken,
    runTimeoutSec: num('timeout-sec', 2_400),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function api<T>(
  cfg: WlFleetConfig,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  opsToken?: string
): Promise<{ status: number; body: T }> {
  // A multi-hour run WILL see transient resets — a poll must never kill the
  // harness. Mutating calls stay at one attempt from the caller's
  // perspective (the WL endpoints are idempotent anyway), reads retry.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${cfg.apiBase}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(opsToken ? { 'x-wl-ops-token': opsToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed as T };
    } catch (error) {
      lastError = error;
      await sleep(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

function correctAnswerFor(kind: string, evaluation: Record<string, unknown>): unknown {
  switch (kind) {
    case 'mcq':
    case 'true_false':
      return evaluation['correct_id'] ?? 'true';
    case 'higher_lower': {
      const left = Number(evaluation['left_value']);
      const right = Number(evaluation['right_value']);
      return left > right ? 'left' : 'right';
    }
    case 'career_path': {
      const accepted = evaluation['accepted_answers'];
      return Array.isArray(accepted) && typeof accepted[0] === 'string' ? accepted[0] : 'unknown';
    }
    case 'who_am_i': {
      const accepted = evaluation['accepted_answers'];
      const guess = Array.isArray(accepted) && typeof accepted[0] === 'string' ? accepted[0] : 'unknown';
      return { guess };
    }
    default:
      return null;
  }
}

function wrongAnswerFor(kind: string): unknown {
  switch (kind) {
    case 'mcq': return 'definitely-not-an-option';
    case 'true_false': return 'false';
    case 'higher_lower': return 'left';
    case 'career_path': return 'nobody';
    case 'who_am_i': return { guess: 'nobody' };
    default: return null;
  }
}

// ── Player driver ───────────────────────────────────────────────────────────

function connectPlayer(
  cfg: WlFleetConfig,
  state: PlayerState,
  tournamentId: string,
  gameResults: Map<number, { field: number; advanced: number }>,
  onFinal: (championUserId: string | null) => void
): void {
  const socket = io(cfg.apiBase, {
    transports: ['websocket'],
    auth: { token: state.user.token },
    forceNew: true,
    reconnection: true,
  });
  state.socket = socket;

  const accept = (payload: { tournamentId?: string; seq?: number; serverNowAtEmit?: number }): boolean => {
    if (payload.tournamentId !== tournamentId) return false;
    const seq = Number(payload.seq);
    if (!Number.isFinite(seq) || seq <= state.lastSeq) return false;
    state.lastSeq = seq;
    const emit = Number(payload.serverNowAtEmit);
    if (Number.isFinite(emit)) {
      state.clockOffset = Math.max(state.clockOffset, emit - Date.now());
    }
    return true;
  };
  const serverNow = () => Date.now() + state.clockOffset;

  socket.on('connect', () => {
    socket.emit('wl:subscribe', { tournament_id: tournamentId, role: 'player' }, (ack: {
      ok: boolean; seq?: number; snapshot?: { score?: number } | null;
    }) => {
      state.subscribed = ack?.ok === true;
      if (ack?.ok && typeof ack.seq === 'number') {
        state.lastSeq = Math.max(state.lastSeq, ack.seq);
      }
      // The snapshot score is authoritative — a reconnect that lost an ack
      // resyncs here exactly like the real client does.
      const snapScore = ack?.snapshot?.score;
      if (typeof snapScore === 'number') {
        state.score = Math.max(state.score, snapScore);
      }
    });
  });

  socket.on('wl:dispatch', (payload: Record<string, unknown>) => {
    if (!accept(payload as never)) return;
    if (state.eliminated) {
      state.liveDispatchesAfterElimination += 1;
      return;
    }
    const attemptId = String(payload['attempt_id'] ?? '');
    const kind = String(payload['kind'] ?? '');
    const playableAt = Number(payload['playableAt']);
    const deadlineAt = Number(payload['deadlineAt']);
    const evaluation = (payload['evaluation'] ?? {}) as Record<string, unknown>;
    if (!attemptId || !Number.isFinite(playableAt) || !Number.isFinite(deadlineAt)) return;
    state.dispatchLatenessMs.push(Math.max(0, Date.now() + state.clockOffset - Number(payload['serverNowAtEmit'])));

    // Occasional connection chaos right at the question.
    if (cfg.flapRate > 0 && Math.random() < cfg.flapRate) {
      state.flaps += 1;
      socket.disconnect();
      setTimeout(() => socket.connect(), 500 + Math.random() * 1500);
    }

    const answersCorrectly = Math.random() < cfg.accuracy;
    const answer = answersCorrectly ? correctAnswerFor(kind, evaluation) : wrongAnswerFor(kind);
    const windowMs = deadlineAt - playableAt;
    const delay = Math.min(
      cfg.answerDelayMinMs + Math.random() * (cfg.answerDelayMaxMs - cfg.answerDelayMinMs),
      Math.max(200, windowMs - 1_500)
    );
    const sendAt = playableAt + delay;
    const marginMs = deadlineAt - sendAt;
    setTimeout(() => {
      if (state.answered.has(attemptId) || state.eliminated) return;
      state.answered.add(attemptId);
      state.answersSent += 1;
      const sentAt = Date.now();
      socket.timeout(8_000).emit(
        'wl:answer',
        { tournament_id: tournamentId, attempt_id: attemptId, answer },
        (err: Error | null, ack?: { accepted: boolean; points?: number; reason?: string }) => {
          if (err || !ack) {
            state.ackTimeouts += 1;
            state.errors.push(`ack-timeout ${attemptId}`);
            return;
          }
          state.acks.push({
            latencyMs: Date.now() - sentAt,
            accepted: ack.accepted,
            reason: ack.accepted ? undefined : ack.reason,
          });
          if (ack.accepted) {
            if (!state.scored.has(attemptId)) {
              state.scored.set(attemptId, ack.points ?? 0);
              state.score += ack.points ?? 0;
            }
          } else if (ack.reason === 'closed' && marginMs > 2_000) {
            // Rejected despite ≥2s margin before the deadline — a LOST answer.
            state.lostAnswers += 1;
          }
        }
      );
    }, Math.max(0, sendAt - serverNow()));
  });

  socket.on('wl:void', (payload: Record<string, unknown>) => {
    if (!accept(payload as never)) return;
    const attemptId = String(payload['attempt_id'] ?? '');
    const pts = state.scored.get(attemptId);
    if (pts != null) {
      state.scored.delete(attemptId);
      state.score = Math.max(0, state.score - pts);
    }
  });

  socket.on('wl:game_result', (payload: Record<string, unknown>) => {
    if (!accept(payload as never)) return;
    const gameIndex = Number(payload['game_index']);
    gameResults.set(gameIndex, {
      field: Number(payload['field'] ?? 0),
      advanced: Number(payload['advanced'] ?? 0),
    });
    // SCORE INTEGRITY: the server's absolute board must equal our local
    // ledger (acks minus void refunds) whenever this player is on it.
    const board = Array.isArray(payload['board'])
      ? (payload['board'] as Array<{ user_id: string; points: number }>)
      : [];
    const mine = board.find((b) => b.user_id === state.user.userId);
    if (mine && mine.points !== state.score) {
      state.scoreViolations.push({ gameIndex, ledger: state.score, board: mine.points });
    }
    const eliminatedIds = Array.isArray(payload['eliminated_user_ids'])
      ? (payload['eliminated_user_ids'] as string[])
      : [];
    if (eliminatedIds.includes(state.user.userId)) state.eliminated = true;
    else state.score = 0; // survivors start the next game fresh (next dispatch resets too)
  });

  socket.on('wl:final_result', (payload: Record<string, unknown>) => {
    if (!accept(payload as never)) return;
    const gameIndex = Number(payload['game_index']);
    if (Number.isFinite(gameIndex)) {
      gameResults.set(gameIndex, {
        field: Number(payload['field'] ?? 0),
        advanced: Number(payload['advanced'] ?? 0),
      });
    }
    onFinal(typeof payload['champion_user_id'] === 'string' ? payload['champion_user_id'] : null);
  });

  socket.on('wl:phase', (payload: Record<string, unknown>) => { accept(payload as never); });
  socket.on('wl:reveal', (payload: Record<string, unknown>) => { accept(payload as never); });
  socket.on('wl:cancellation', (payload: Record<string, unknown>) => { accept(payload as never); });
}

function connectSpectator(cfg: WlFleetConfig, state: SpectatorState, tournamentId: string): void {
  const socket = io(cfg.apiBase, {
    transports: ['websocket'],
    auth: { token: state.user.token },
    forceNew: true,
    reconnection: true,
  });
  state.socket = socket;
  socket.on('connect', () => {
    socket.emit('wl:subscribe', { tournament_id: tournamentId, role: 'spectator' }, () => {});
  });
  socket.on('wl:dispatch', (payload: Record<string, unknown>) => {
    if (payload['tournamentId'] !== tournamentId) return;
    state.dispatches += 1;
    state.seqs.push(Number(payload['seq']));
    const evaluation = payload['evaluation'] as Record<string, unknown> | undefined;
    if (evaluation && Object.keys(evaluation).length > 0) state.evaluationLeaks += 1;
    const deadlineAt = Number(payload['deadlineAt']);
    const emitAt = Number(payload['serverNowAtEmit']);
    // The live window must be CLOSED before a spectator ever sees the question.
    if (Number.isFinite(deadlineAt) && Number.isFinite(emitAt) && emitAt < deadlineAt) {
      state.openWindowLeaks += 1;
    }
  });
  for (const ev of ['wl:phase', 'wl:reveal', 'wl:void', 'wl:game_result', 'wl:final_result']) {
    socket.on(ev, (payload: Record<string, unknown>) => {
      if (payload['tournamentId'] === tournamentId) state.seqs.push(Number(payload['seq']));
    });
  }
}

// ── Main run ────────────────────────────────────────────────────────────────

export async function runWlFleet(cfg: WlFleetConfig): Promise<WlFleetSummary> {
  assertSocketTargetSafe(cfg.apiBase);
  const startedAt = new Date().toISOString();
  console.log(`[wl-fleet] provisioning ${cfg.players} players + ${cfg.spectators} spectators…`);

  const supabaseUrl = process.env.STAGING_SUPABASE_URL;
  const serviceRoleKey = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('STAGING_SUPABASE_URL and STAGING_SUPABASE_SERVICE_ROLE_KEY are required');
  }
  // PROD GUARD for the ADMIN WRITES too: user creation / password resets go
  // straight to Supabase — the env var's NAME proves nothing. Only the known
  // staging project or localhost is mutable from here.
  {
    const host = new URL(supabaseUrl).hostname;
    const allowed = host === 'nsdfiprfmhdqhbfxfwpv.supabase.co'
      || host === 'localhost' || host === '127.0.0.1';
    if (!allowed) {
      throw new Error(`PROD GUARD: refusing Supabase admin writes to "${host}" — staging project or localhost only.`);
    }
  }
  // Supabase Auth throttles /token by source IP — 2.2s pacing is the proven
  // staging cadence (see the other fleets). A big run pays that cost ONCE:
  // tokens are cached and reused while their JWTs stay fresh.
  const needed = cfg.players + cfg.spectators;
  const cachePath = resolve(
    `scripts/chaos/reports/wl-fleet-token-cache-${new URL(cfg.apiBase).hostname.replace(/[^a-z0-9.-]/gi, '_')}.json`
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const jwtFresh = (token: string): boolean => {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
      return Number(payload.exp) > nowSec + 15 * 60;
    } catch { return false; }
  };
  let cached: ChaosUser[] = [];
  if (existsSync(cachePath)) {
    try {
      cached = (JSON.parse(readFileSync(cachePath, 'utf8')) as ChaosUser[]).filter((u) => jwtFresh(u.token));
    } catch { cached = []; }
  }
  let users: ChaosUser[];
  if (cached.length >= needed) {
    console.log(`[wl-fleet] reusing ${needed} cached tokens`);
    users = cached.slice(0, needed);
  } else {
    users = await provisionUsers({
      apiBase: cfg.apiBase,
      supabaseUrl,
      serviceRoleKey,
      count: needed,
      password: process.env.CHAOS_USER_PASSWORD ?? 'wl-fleet-Passw0rd!',
      emailPrefix: 'wlfleet',
      emailDomain: 'quizball.io',
      concurrency: 4,
      loginIntervalMs: 2_200,
      bypassToken: process.env.CHAOS_BYPASS_TOKEN,
    });
    mkdirSync(resolve('scripts/chaos/reports'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(users));
  }
  if (users.length < needed) {
    throw new Error(`provisioned only ${users.length}/${needed} users`);
  }
  const playerUsers = users.slice(0, cfg.players);
  const spectatorUsers = users.slice(cfg.players, cfg.players + cfg.spectators);

  console.log('[wl-fleet] creating compressed is_test tournament via ops API…');
  const createRes = await api<{ tournament_id?: string; tournament?: { id: string }; id?: string }>(
    cfg, null, 'POST', '/api/v1/internal/ops/wl/create-test',
    {
      actor: 'wl-fleet',
      compressed: {
        entry_seconds: cfg.entrySeconds,
        checkin_seconds: cfg.checkinSeconds,
        to_final_seconds: cfg.toFinalSeconds,
      },
      config: {
        free_entry: true,
        question_time_ms: cfg.questionTimeMs,
        spectator_delay_ms: cfg.spectatorDelayMs,
        break_ms: 20_000,
      },
    },
    cfg.opsToken
  );
  const tournamentId =
    createRes.body?.tournament_id ?? createRes.body?.tournament?.id ?? createRes.body?.id;
  if (createRes.status !== 200 || !tournamentId) {
    throw new Error(`create-test failed: HTTP ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  console.log(`[wl-fleet] tournament ${tournamentId} — driving ticks…`);

  // With WL_ORCHESTRATION_ENABLED off (the staging default), is_test
  // tournaments advance ONLY via ops force-tick — the harness owns the
  // clock. Tick until the run ends.
  let ticking = true;
  const ticker = (async () => {
    while (ticking) {
      await api(cfg, null, 'POST', '/api/v1/internal/ops/wl/force-tick',
        { actor: 'wl-fleet', tournament_id: tournamentId }, cfg.opsToken
      ).catch(() => null);
      await sleep(3_000);
    }
  })();

  // Entry only opens once the reconciler transitions the tournament.
  const states: PlayerState[] = playerUsers.map((user) => ({
    user, socket: null, subscribed: false, answersSent: 0, ackTimeouts: 0,
    scoreViolations: [], entered: false, checkedIn: false,
    finalCheckedIn: false, eliminated: false, lastSeq: -1, clockOffset: Number.NEGATIVE_INFINITY,
    scored: new Map(), answered: new Set(), score: 0, acks: [], lostAnswers: 0,
    dispatchLatenessMs: [], liveDispatchesAfterElimination: 0, flaps: 0, errors: [],
  }));
  for (const s of states) s.clockOffset = 0;

  // Status source: the DB directly when WL_FLEET_DB_URL is set (required
  // once a real weekly tournament owns /current — the API has no by-id
  // status read for clients), else /current filtered by id.
  const dbUrl = process.env.WL_FLEET_DB_URL;
  const dbSql = dbUrl ? (await import('postgres')).default(dbUrl, { max: 1 }) : null;
  const readStatus = async (): Promise<string | null> => {
    if (dbSql) {
      const rows = await dbSql`
        SELECT status FROM wl_tournaments WHERE id = ${tournamentId}
      `.catch(() => []) as Array<{ status: string }>;
      return rows[0]?.status ?? null;
    }
    const res = await api<{ tournament?: { id: string; status: string } | null }>(
      cfg, states[0]!.user.token, 'GET', '/api/v1/weekend-league/current'
    ).catch(() => null);
    const tour = res?.body?.tournament;
    return tour?.id === tournamentId ? tour.status : null;
  };

  const pollUntil = async (predicate: (status: string) => boolean, maxMs: number): Promise<string> => {
    const deadline = Date.now() + maxMs;
    let last = 'unknown';
    while (Date.now() < deadline) {
      const res = await api<{ tournament?: { id: string; status: string } | null }>(
        cfg, states[0]!.user.token, 'GET', '/api/v1/weekend-league/current'
      ).catch(() => null);
      const tour = res?.body?.tournament;
      if (tour?.id === tournamentId) {
        last = tour.status;
        if (predicate(tour.status)) return tour.status;
      }
      await sleep(2_000);
    }
    return last;
  };

  const entryStatus = await pollUntil((s) => s === 'entry_open', 120_000);
  if (entryStatus !== 'entry_open') {
    ticking = false;
    throw new Error(`tournament never opened entry (last status ${entryStatus})`);
  }
  console.log('[wl-fleet] entry open — entering players…');

  // Enter everyone (bounded concurrency).
  let enterCursor = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (enterCursor < states.length) {
      const state = states[enterCursor]!;
      enterCursor += 1;
      const res = await api<{ entered?: boolean; already_entered?: boolean }>(
        cfg, state.user.token, 'POST', '/api/v1/weekend-league/enter',
        { tournament_id: tournamentId }
      );
      state.entered = res.body?.entered === true || res.body?.already_entered === true;
      if (!state.entered) state.errors.push(`enter HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
  }));
  const enteredCount = states.filter((s) => s.entered).length;
  console.log(`[wl-fleet] entered ${enteredCount}/${cfg.players}; waiting for check-in window…`);

  const checkinStatus = await pollUntil((s) => s === 'checkin' || s === 'game_live', (cfg.entrySeconds + 180) * 1000);
  if (checkinStatus !== 'checkin' && checkinStatus !== 'game_live') {
    ticking = false;
    throw new Error(`tournament never reached checkin (last status ${checkinStatus})`);
  }
  let checkinCursor = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (checkinCursor < states.length) {
      const state = states[checkinCursor]!;
      checkinCursor += 1;
      if (!state.entered) continue;
      const res = await api<{ checked_in?: boolean; already_checked_in?: boolean }>(
        cfg, state.user.token, 'POST', '/api/v1/weekend-league/checkin',
        { tournament_id: tournamentId }
      );
      state.checkedIn = res.body?.checked_in === true || res.body?.already_checked_in === true;
    }
  }));
  const checkedInCount = states.filter((s) => s.checkedIn).length;
  console.log(`[wl-fleet] checked in ${checkedInCount}; connecting sockets…`);

  const gameResults = new Map<number, { field: number; advanced: number }>();
  let championUserId: string | null = null;
  let finalSeen = false;
  const onFinal = (champion: string | null) => { finalSeen = true; championUserId = champion; };

  for (const state of states) {
    if (state.checkedIn) connectPlayer(cfg, state, tournamentId, gameResults, onFinal);
  }
  const spectators: SpectatorState[] = spectatorUsers.map((user) => ({
    user, socket: null, seqs: [], evaluationLeaks: 0, openWindowLeaks: 0, dispatches: 0,
  }));
  for (const spec of spectators) connectSpectator(cfg, spec, tournamentId);

  // Sunday-final check-in as the tournament reaches it.
  void (async () => {
    const status = await pollUntil((s) => s === 'final_checkin' || s === 'completed' || s === 'cancelled', cfg.runTimeoutSec * 1000);
    if (status !== 'final_checkin') return;
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < states.length) {
        const state = states[cursor]!;
        cursor += 1;
        if (state.eliminated || !state.checkedIn) continue;
        const res = await api<{ checked_in?: boolean; already_checked_in?: boolean }>(
          cfg, state.user.token, 'POST', '/api/v1/weekend-league/checkin',
          { tournament_id: tournamentId }
        );
        state.finalCheckedIn = res.body?.checked_in === true || res.body?.already_checked_in === true;
      }
    }));
    console.log(`[wl-fleet] final check-in done (${states.filter((s) => s.finalCheckedIn).length})`);
  })();

  console.log('[wl-fleet] playing… (this runs the whole compressed tournament)');
  // Completion is EVENT-driven: /current hides terminal tournaments, so the
  // wl:final_result broadcast (which the fleet receives) is the finish line;
  // the poll only backstops cancellation.
  const playDeadline = Date.now() + cfg.runTimeoutSec * 1000;
  let polledStatus = 'unknown';
  while (Date.now() < playDeadline && !finalSeen) {
    polledStatus = await pollUntil((s) => s === 'cancelled', 10_000);
    if (polledStatus === 'cancelled') break;
  }
  const finalStatus = finalSeen ? 'completed' : polledStatus;
  ticking = false;
  await ticker.catch(() => {});
  await dbSql?.end({ timeout: 5 }).catch(() => {});
  // Give trailing spectator (delayed) events time to drain before judging.
  await sleep(Math.min(cfg.spectatorDelayMs + 10_000, 60_000));

  // Final board for score integrity: last game_result/final_result boards are
  // absolute; fetch via a player socket is gone — use REST /current you-state
  // only for status; integrity check uses the last board we saw per player.
  for (const state of states) state.socket?.disconnect();
  for (const spec of spectators) spec.socket?.disconnect();

  // ── Aggregate ──
  const allAcks = states.flatMap((s) => s.acks);
  const ackLatencies = allAcks.map((a) => a.latencyMs);
  const allLateness = states.flatMap((s) => s.dispatchLatenessMs);
  const answers = {
    sent: states.reduce((n, s) => n + s.answersSent, 0),
    acked: allAcks.length,
    accepted: allAcks.filter((a) => a.accepted).length,
    rejected: allAcks.filter((a) => !a.accepted).length,
    ackTimeouts: states.reduce((n, s) => n + s.ackTimeouts, 0),
    lost: states.reduce((n, s) => n + s.lostAnswers, 0),
  };
  const scoreViolations = states.flatMap((s) =>
    s.scoreViolations.map((v) => ({ userId: s.user.userId, ...v })));
  // Structural elimination-exactness: each game's field must be exactly the
  // previous game's advanced count, and (with ≥24 players) the last
  // qualifier game must advance exactly 24 finalists.
  const orderedGames = [...gameResults.entries()].sort(([a], [b]) => a - b);
  const ladderBreaks: string[] = [];
  for (let i = 1; i < orderedGames.length; i += 1) {
    const [, prev] = orderedGames[i - 1]!;
    const [gi, cur] = orderedGames[i]!;
    if (cur.field !== prev.advanced) {
      ladderBreaks.push(`game ${gi}: field=${cur.field} != prior advanced=${prev.advanced}`);
    }
  }
  const lastQualifier = orderedGames.filter(([gi]) => gi <= 2).at(-1)?.[1];
  if (cfg.players >= 24 && lastQualifier && lastQualifier.advanced !== 24) {
    ladderBreaks.push(`finalists=${lastQualifier.advanced} != 24`);
  }
  const eliminationViolations = states.reduce((n, s) => n + s.liveDispatchesAfterElimination, 0);
  const spectatorSeqGaps = spectators.reduce((n, s) => {
    const sorted = s.seqs.filter(Number.isFinite).sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]! !== sorted[i - 1]! && sorted[i]! !== sorted[i - 1]! + 1) gaps += 1;
    }
    return n + gaps;
  }, 0);

  const summary: WlFleetSummary = {
    startedAt,
    endedAt: new Date().toISOString(),
    tournamentId,
    players: cfg.players,
    spectators: cfg.spectators,
    flapRate: cfg.flapRate,
    completed: finalStatus === 'completed' && finalSeen,
    finalStatus,
    championUserId,
    entered: enteredCount,
    checkedIn: checkedInCount,
    answers,
    ackLatencyMs: {
      p50: percentile(ackLatencies, 50),
      p95: percentile(ackLatencies, 95),
      p99: percentile(ackLatencies, 99),
      max: ackLatencies.length ? Math.max(...ackLatencies) : 0,
    },
    dispatchLatenessMs: {
      p50: percentile(allLateness, 50),
      p95: percentile(allLateness, 95),
      p99: percentile(allLateness, 99),
      max: allLateness.length ? Math.max(...allLateness) : 0,
    },
    scoreIntegrityViolations: scoreViolations,
    eliminationViolations,
    ladderBreaks,
    gameResults: [...gameResults.entries()]
      .sort(([a], [b]) => a - b)
      .map(([gameIndex, r]) => ({ gameIndex, ...r })),
    spectator: {
      dispatches: spectators.reduce((n, s) => n + s.dispatches, 0),
      evaluationLeaks: spectators.reduce((n, s) => n + s.evaluationLeaks, 0),
      openWindowLeaks: spectators.reduce((n, s) => n + s.openWindowLeaks, 0),
      seqGaps: spectatorSeqGaps,
    },
    flapsPerformed: states.reduce((n, s) => n + s.flaps, 0),
    errors: states.flatMap((s) => s.errors).slice(0, 100),
    slo: {},
  };

  summary.slo = {
    completed: { pass: summary.completed, detail: `finalStatus=${finalStatus}` },
    everyoneEntered: {
      pass: enteredCount === cfg.players && checkedInCount === cfg.players,
      detail: `entered=${enteredCount}/${cfg.players} checkedIn=${checkedInCount}/${cfg.players}`,
    },
    ackP95: {
      pass: ackLatencies.length > 0 && summary.ackLatencyMs.p95 <= 800,
      detail: `p95=${summary.ackLatencyMs.p95}ms over ${ackLatencies.length} acks (target ≤800ms, no-data fails)`,
    },
    deliveryP95: {
      pass: allLateness.length > 0 && summary.dispatchLatenessMs.p95 <= 1_500,
      detail: `p95=${summary.dispatchLatenessMs.p95}ms over ${allLateness.length} dispatches (target ≤1500ms, no-data fails)`,
    },
    zeroLostAnswers: {
      pass: answers.lost === 0 && answers.ackTimeouts === 0,
      detail: `lost=${answers.lost} ackTimeouts=${answers.ackTimeouts} (sent=${answers.sent} acked=${answers.acked})`,
    },
    scoreIntegrity: {
      pass: scoreViolations.length === 0,
      detail: `ledger-vs-board mismatches=${scoreViolations.length}`,
    },
    eliminationExactness: {
      pass: eliminationViolations === 0 && ladderBreaks.length === 0,
      detail: `post-elimination dispatches=${eliminationViolations}; ladder: ${ladderBreaks.length === 0 ? 'exact' : ladderBreaks.join('; ')}`,
    },
    spectatorNoAnswerKey: {
      pass: summary.spectator.evaluationLeaks === 0,
      detail: `evaluation leaks=${summary.spectator.evaluationLeaks}`,
    },
    spectatorWindowClosed: {
      pass: summary.spectator.openWindowLeaks === 0,
      detail: `open-window dispatches=${summary.spectator.openWindowLeaks}`,
    },
    spectatorGapless: {
      pass: spectatorSeqGaps === 0,
      detail: `seq gaps=${spectatorSeqGaps}`,
    },
  };
  return summary;
}

function renderSummary(s: WlFleetSummary): string {
  const lines = [
    `WL FLEET ${s.players}p/${s.spectators}s flap=${s.flapRate} — ${s.finalStatus.toUpperCase()}`,
    `tournament ${s.tournamentId}`,
    `entered ${s.entered}  checked-in ${s.checkedIn}  champion ${s.championUserId ?? '—'}`,
    `answers sent=${s.answers.sent} acked=${s.answers.acked} accepted=${s.answers.accepted} rejected=${s.answers.rejected} timeouts=${s.answers.ackTimeouts} LOST=${s.answers.lost}`,
    `score integrity: ${s.scoreIntegrityViolations.length} mismatches`,
    `ack ms p50=${s.ackLatencyMs.p50} p95=${s.ackLatencyMs.p95} p99=${s.ackLatencyMs.p99} max=${s.ackLatencyMs.max}`,
    `dispatch lateness ms p50=${s.dispatchLatenessMs.p50} p95=${s.dispatchLatenessMs.p95} p99=${s.dispatchLatenessMs.p99}`,
    `games: ${s.gameResults.map((g) => `#${g.gameIndex} field=${g.field}→${g.advanced}`).join('  ')}`,
    `spectator: dispatches=${s.spectator.dispatches} evalLeaks=${s.spectator.evaluationLeaks} openWindow=${s.spectator.openWindowLeaks} gaps=${s.spectator.seqGaps}`,
    `flaps=${s.flapsPerformed}  errors=${s.errors.length}`,
    'SLO:',
    ...Object.entries(s.slo).map(([name, r]) => `  ${r.pass ? '✅' : '❌'} ${name}: ${r.detail}`),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const summary = await runWlFleet(cfg);
  const dir = resolve('scripts/chaos/reports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(dir, `wl-fleet-${stamp}.json`);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`\n${renderSummary(summary)}\n\nreport: ${path}`);
  const failed = Object.values(summary.slo).filter((r) => !r.pass);
  process.exit(failed.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1]?.endsWith('wl-fleet.ts');
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[wl-fleet] FATAL', error);
    process.exit(2);
  });
}
