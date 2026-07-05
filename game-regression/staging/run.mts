/**
 * Staging harness — Phase 1 (client gate).
 *
 * Connects REAL socket.io clients to staging, plays matches over the network, and
 * verifies them with the SAME trace invariants the local harness uses. Self-
 * contained: it creates/logs-in two test users itself (Supabase service-role), so
 * no tokens are handed in.
 *
 * Scenarios (run a subset via STAGING_SCENARIOS="ranked_ai,reconnect"):
 *   ranked_ai_smoke         solo ranked queue -> AI fallback -> full match
 *   friendly_possession_smoke   2 users: lobby -> draft -> possession match
 *   friendly_party_smoke    2 users: lobby (party mode) -> party match
 *   reconnect_smoke         ranked-AI match, drop+reconnect mid-match, assert resume
 *
 * Env:
 *   STAGING_URL                       default https://api-staging.quizball.io
 *   STAGING_SUPABASE_URL / _SERVICE_ROLE_KEY   (see auth-bootstrap.mts)
 *   STAGING_SCENARIOS                 comma list (default: all)
 *
 * Exit 0 = all selected scenarios clean; 1 = any hard failure.
 */
import type { Socket } from 'socket.io-client';
import { bootstrapTestUsers, deleteTestUsers, type TestUser } from './auth-bootstrap.mjs';
import { connectStaging, clearActiveMatch, type StagingClient } from './staging-client.mjs';
import { checkInvariants, formatViolation } from '../src/invariants.mjs';
import { checkPartyInvariants } from '../src/party-invariants.mjs';
import { createTrace, type EventTrace, type TraceEvent } from '../src/adapter.mjs';

/** A new trace containing only events that pass `keep`, preserving real timestamps. */
function filteredTrace(trace: EventTrace, keep: (e: TraceEvent) => boolean): EventTrace {
  const kept = trace.events.filter(keep);
  let i = 0;
  const t = createTrace(() => kept[i]?.t ?? Date.now());
  for (; i < kept.length; i++) t.record(kept[i].dir, kept[i].event, kept[i].payload, kept[i].target);
  return t;
}

const URL = process.env.STAGING_URL ?? 'https://api-staging.quizball.io';
const ALL = [
  'ranked_ai_smoke', 'friendly_possession_smoke', 'friendly_party_smoke', 'reconnect_smoke',
  'forfeit_early_live', 'forfeit_late_live', 'opponent_forfeit_winner_live', 'draft_ban_collision_live',
  'answer_timing',
];
const SELECTED = (process.env.STAGING_SCENARIOS ?? ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

interface ScenarioResult {
  name: string;
  ok: boolean;
  detail: string;
  violations: string[];
  variant?: 'possession' | 'party';
  /** the recorded event timeline, for the report bundle and manual trace review. */
  events?: Array<{ seq: number; t: number; dir: string; event: string; target?: string; payload: unknown }>;
  /** match-window bounds (epoch ms) so logs can be correlated. */
  startedAt?: number;
  endedAt?: number;
  findings?: Array<{ name: string; ok: boolean; detail: string }>;
}

// ── Bot helpers ──

/** Answer every question this client receives, for ALL kinds — otherwise specials
 *  (countdown/putInOrder/clues) sit the full ~30s question timeout each, which on
 *  the real network blows past the play budget before the match can finish. */
function autoAnswer(client: StagingClient): void {
  type QuestionPayload = {
    matchId: string; qIndex: number; correctIndex?: number; playableAt?: string;
    question?: { kind?: string; items?: Array<{ id: string }> };
  };

  const completed = new Set<string>();
  let activeQuestion: QuestionPayload | null = null;
  const keyFor = (matchId: string, qIndex: number) => `${matchId}:${qIndex}`;

  const sendAnswer = (q: QuestionPayload, retryDelayMs = 50) => {
    const key = keyFor(q.matchId, q.qIndex);
    if (completed.has(key)) return;
    const waitMs = q.playableAt ? Math.max(0, new Date(q.playableAt).getTime() - Date.now()) : 0;
    setTimeout(() => {
      if (completed.has(key)) return;
      const kind = q.question?.kind ?? 'multipleChoice';
      const base = { matchId: q.matchId, qIndex: q.qIndex };
      if (kind === 'countdown') {
        client.socket.emit('match:countdown_guess', { ...base, guess: 'one' });
      } else if (kind === 'putInOrder') {
        const orderedItemIds = (q.question?.items ?? []).map((i) => i.id);
        client.socket.emit('match:put_in_order_answer', { ...base, orderedItemIds, timeMs: 500 });
      } else if (kind === 'clues') {
        client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: 'answer' });
      } else {
        client.socket.emit('match:answer', {
          ...base, selectedIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0, timeMs: 500,
        });
      }
    }, waitMs + retryDelayMs);
  };

  client.socket.on('match:question', (q: QuestionPayload) => {
    activeQuestion = q;
    sendAnswer(q);
  });

  client.socket.on('match:answer_ack', (ack: { matchId?: string; qIndex?: number }) => {
    if (ack.matchId && typeof ack.qIndex === 'number') completed.add(keyFor(ack.matchId, ack.qIndex));
  });
  client.socket.on('match:round_result', (result: { matchId?: string; qIndex?: number }) => {
    if (result.matchId && typeof result.qIndex === 'number') {
      completed.add(keyFor(result.matchId, result.qIndex));
      // The ready gate opens after round_result. Ack here so possession goal
      // transitions and party post-round transitions advance promptly.
      client.socket.emit('match:ready_for_next_question', {
        matchId: result.matchId,
        qIndex: result.qIndex,
      });
    }
  });
  client.socket.on('match:resume', () => {
    if (activeQuestion) sendAnswer(activeQuestion, 250);
  });
  client.socket.on('connect', () => {
    if (activeQuestion) sendAnswer(activeQuestion, 250);
  });
}

/** Recover from transient socket drops like a real client: complete the
 *  match:rejoin handshake and ack the resume/kickoff ui-ready gates — otherwise
 *  a single blip leaves the match disconnect-paused for the whole play budget. */
function autoRecover(client: StagingClient): void {
  client.socket.on('match:rejoin_available', (p: { matchId?: string }) => {
    client.socket.emit('match:rejoin', p?.matchId ? { matchId: p.matchId } : {});
  });
  client.socket.on('match:waiting_for_ready', (p: { matchId?: string; phase?: string }) => {
    if (!p?.matchId) return;
    if (p.phase === 'resume') client.socket.emit('match:resume_ui_ready', { matchId: p.matchId });
    else if (p.phase === 'kickoff') client.socket.emit('match:kickoff_ui_ready', { matchId: p.matchId });
  });
}

/** At halftime, ack ui_ready and ban a category (like a real client) so the
 *  half-boundary advances promptly instead of waiting the long timeout. */
function autoHalftime(client: StagingClient): void {
  const handled = new Set<string>();
  client.socket.on('match:state', (s: { matchId?: string; phase?: string; halftime?: { categoryOptions?: Array<{ id: string }> } }) => {
    if (s.phase !== 'HALFTIME' || !s.matchId) return;
    const opts = s.halftime?.categoryOptions ?? [];
    const key = `${s.matchId}:${opts.map((o) => o.id).join(',')}`;
    if (handled.has(key)) return;
    handled.add(key);
    client.socket.emit('match:halftime_ui_ready', { matchId: s.matchId });
    if (opts[0]) {
      setTimeout(() => client.socket.emit('match:halftime_ban', { matchId: s.matchId!, categoryId: opts[0].id }), 300);
    }
  });
}

/** Auto-ban in the draft when it's this client's turn. */
function autoDraft(client: StagingClient): void {
  // The opponent's (AI) auto-ban is gated on this client's draft:ui_ready
  // (be#89) — a bot that never acks stalls the draft until the force ceiling.
  let banCount = 0;
  client.socket.on('draft:start', (state: { lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }) => {
    banCount = 0;
    client.socket.emit('draft:ui_ready', { ...(state.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    if (state.turnUserId === client.userId && state.categories[0]) {
      client.socket.emit('draft:ban', { categoryId: state.categories[0].id });
    }
  });
  client.socket.on('draft:banned', () => {
    // On our turn after the opponent banned, ban the next available.
    // (Re-read via the recorded latest draft:start state.)
    const state = client.latest<{ lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }>('draft:start');
    banCount = Math.min(banCount + 1, 2);
    client.socket.emit('draft:ui_ready', { ...(state?.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    if (state && state.turnUserId === client.userId) {
      const next = state.categories.find((c) => c.id);
      if (next) client.socket.emit('draft:ban', { categoryId: next.id });
    }
  });
}

async function waitConnected(client: StagingClient, ms = 15_000): Promise<boolean> {
  if (client.socket.connected) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    client.socket.once('connect', () => { clearTimeout(t); resolve(true); });
  });
}

function verdict(name: string, trace: EventTrace, isParty: boolean): ScenarioResult {
  // Scope to THIS scenario's match: a late forfeit result from a leftover match
  // (self-heal) can land in the trace. Take the matchId from match:start and keep
  // only events for that match (+ untargeted lifecycle events), so the invariants
  // and invariants see exactly one clean match.
  const startMatchId = (trace.byEvent('match:start')[0]?.payload as { matchId?: string } | undefined)?.matchId;
  const scoped = startMatchId
    ? filteredTrace(trace, (e) => !e.target?.startsWith('match:') || e.target === `match:${startMatchId}`)
    : trace;
  const finals = scoped.byEvent('match:final_results').length;
  const inv = isParty ? checkPartyInvariants(scoped) : checkInvariants(scoped);
  const violations = inv.violations.map(formatViolation);
  const ok = finals > 0 && inv.ok;
  const events = scoped.events.map((e) => ({ seq: e.seq, t: e.t, dir: e.dir, event: e.event, target: e.target, payload: e.payload }));
  return {
    name, ok,
    detail: ok ? 'completed + invariants hold' : `finals=${finals} invariantsOk=${inv.ok}`,
    violations,
    variant: isParty ? 'party' : 'possession',
    events,
    startedAt: events[0]?.t,
    endedAt: events[events.length - 1]?.t,
  };
}

function hasFinalResultsForMatch(trace: EventTrace, matchId: string | undefined): boolean {
  if (!matchId) return trace.byEvent('match:final_results').length > 0;
  return trace.byEvent('match:final_results', `match:${matchId}`).length > 0;
}

// ── Scenarios ──

async function rankedAiSmoke(users: { a: TestUser }): Promise<ScenarioResult> {
  const client = connectStaging(URL, users.a.accessToken, users.a.userId);
  try {
    if (!await waitConnected(client)) return { name: 'ranked_ai_smoke', ok: false, detail: 'socket never connected', violations: [] };
    await clearActiveMatch(client); // self-heal any leftover active match from a prior run
    autoAnswer(client); autoDraft(client); autoHalftime(client); autoRecover(client);
    client.socket.emit('ranked:queue_join', {});
    // queue -> AI fallback -> draft -> match -> completion. Generous network waits.
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 150_000);
    if (!started) return { name: 'ranked_ai_smoke', ok: false, detail: 'match never started (no match:start/question within 60s)', violations: [] };
    const matchId = client.latest<{ matchId?: string }>('match:start')?.matchId;
    await client.waitFor(() => hasFinalResultsForMatch(client.trace, matchId), 420_000);
    return verdict('ranked_ai_smoke', client.trace, false);
  } finally {
    client.disconnect();
  }
}

async function friendlySmoke(name: string, party: boolean, users: { a: TestUser; b: TestUser }): Promise<ScenarioResult> {
  // SEPARATE traces: host + guest each receive every match-room broadcast, so a
  // SHARED trace would record each room event twice and the invariants would see
  // phantom "duplicate dispatch". We verify on the HOST's trace only; the guest
  // still drives answers, just into its own (discarded) trace.
  const host = connectStaging(URL, users.a.accessToken, users.a.userId);
  const guest = connectStaging(URL, users.b.accessToken, users.b.userId);
  try {
    if (!(await waitConnected(host)) || !(await waitConnected(guest))) {
      return { name, ok: false, detail: 'sockets never connected', violations: [] };
    }
    await Promise.all([clearActiveMatch(host), clearActiveMatch(guest)]); // self-heal
    autoAnswer(host); autoAnswer(guest); autoDraft(host); autoDraft(guest); autoHalftime(host); autoHalftime(guest);

    let inviteCode: string | null = null;
    const targetGameMode = party ? 'friendly_party_quiz' : 'friendly_possession';
    let memberCount = 0;
    let settingsSent = false;
    let settingsApplied = false;
    host.socket.on('lobby:state', (state: {
      inviteCode?: string | null;
      members?: unknown[];
      settings?: { gameMode?: string };
    }) => {
      memberCount = state.members?.length ?? 0;
      // Host sees its own lobby -> guest joins by code.
      if (!inviteCode && state.inviteCode) {
        inviteCode = state.inviteCode;
        setTimeout(() => guest.socket.emit('lobby:join_by_code', { inviteCode }), 300);
      }
      // Once BOTH members are present, set the variant (host-only) — once.
      if (!settingsSent && memberCount >= 2) {
        settingsSent = true;
        host.socket.emit('lobby:update_settings', {
          gameMode: targetGameMode, friendlyRandom: true,
        });
      }
      if (state.settings?.gameMode === targetGameMode) {
        settingsApplied = true;
      }
    });

    host.socket.emit('lobby:create', { mode: 'friendly' });

    // Once both joined + the server has echoed the requested mode, ready both
    // seats then host-start. Polling this avoids racing lobby:update_settings.
    const readyToStart = await host.waitFor(() => memberCount >= 2 && settingsApplied, 30_000);
    if (readyToStart) {
      await new Promise((r) => setTimeout(r, 500));
      host.socket.emit('lobby:ready', { ready: true });
      guest.socket.emit('lobby:ready', { ready: true });
      await new Promise((r) => setTimeout(r, 1_500));
      host.socket.emit('lobby:start', {});
    }

    const started = await host.waitFor(() => host.count('match:start') > 0 && host.count('match:question') > 0, 90_000);
    if (!started) return { name, ok: false, detail: 'friendly match never started within 90s', violations: [], variant: party ? 'party' : 'possession' };
    const matchId = host.latest<{ matchId?: string }>('match:start')?.matchId;
    await host.waitFor(() => hasFinalResultsForMatch(host.trace, matchId), 420_000);
    return verdict(name, host.trace, party);
  } finally {
    host.disconnect(); guest.disconnect();
  }
}

async function reconnectSmoke(users: { a: TestUser }): Promise<ScenarioResult> {
  const client = connectStaging(URL, users.a.accessToken, users.a.userId);
  let rejoined: StagingClient | null = null;
  try {
    if (!await waitConnected(client)) return { name: 'reconnect_smoke', ok: false, detail: 'socket never connected', violations: [] };
    await clearActiveMatch(client); // self-heal
    autoAnswer(client); autoDraft(client); autoHalftime(client); autoRecover(client);
    client.socket.emit('ranked:queue_join', {});
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 150_000);
    if (!started) return { name: 'reconnect_smoke', ok: false, detail: 'match never started', violations: [] };

    // Play a couple of rounds, then drop the real socket.
    await client.waitFor(() => client.count('match:round_result') >= 2, 60_000);
    const matchId = client.latest<{ matchId: string }>('match:start')?.matchId;
    const resumesBefore = client.count('match:resume');
    client.socket.disconnect();
    await new Promise((r) => setTimeout(r, 2_000)); // stay gone briefly

    // Reconnect as a fresh app/socket instance, sharing the same trace. Reusing
    // a manually-disconnected Socket.IO client can tear itself down again during
    // the resume window, causing the harness to miss match-room broadcasts.
    rejoined = connectStaging(URL, users.a.accessToken, users.a.userId, client.trace);
    autoAnswer(rejoined); autoDraft(rejoined); autoHalftime(rejoined);
    await waitConnected(rejoined, 20_000);
    if (matchId) rejoined.socket.emit('match:rejoin', { matchId });

    // Phase-aware: rejoin availability/state -> resume countdown -> resume -> finish.
    const resumed = await rejoined.waitFor(() => client.count('match:resume') > resumesBefore, 30_000);
    await rejoined.waitFor(() => hasFinalResultsForMatch(client.trace, matchId), 420_000);
    const v = verdict('reconnect_smoke', client.trace, false);
    if (!resumed) { v.ok = false; v.detail += ' | match:resume never fired after reconnect'; }
    return v;
  } finally {
    rejoined?.disconnect();
    client.disconnect();
  }
}

// Pull this user's ranked RP delta out of a final_results payload (forfeit RP).
// The delta can live under rankedOutcome.byUserId[id].deltaRp OR be echoed on
// the per-player object — check both. Returns null if neither carries it (the
// forfeiter has left the room, so their own RP echo may be absent).
function myDeltaRp(payload: unknown, userId: string): number | null {
  const p = payload as {
    rankedOutcome?: { byUserId?: Record<string, { deltaRp?: number }> };
    players?: Record<string, { deltaRp?: number; rpDelta?: number; rankedDeltaRp?: number }>;
  } | undefined;
  const fromOutcome = p?.rankedOutcome?.byUserId?.[userId]?.deltaRp;
  if (typeof fromOutcome === 'number') return fromOutcome;
  const pl = p?.players?.[userId];
  for (const v of [pl?.deltaRp, pl?.rpDelta, pl?.rankedDeltaRp]) {
    if (typeof v === 'number') return v;
  }
  return null;
}

function finalForMatch(client: StagingClient, matchId: string | undefined): unknown {
  const evts = matchId
    ? client.trace.byEvent('match:final_results', `match:${matchId}`)
    : client.trace.byEvent('match:final_results');
  return evts.slice(-1)[0]?.payload;
}

/** Serialize the recorded timeline for the report bundle (so failures are
 *  inspectable). The smoke scenarios get this via verdict(); custom scenarios
 *  must attach it themselves. */
function tracedEvents(client: StagingClient): ScenarioResult['events'] {
  return client.trace.events.map((e) => ({
    seq: e.seq, t: e.t, dir: e.dir, event: e.event, target: e.target, payload: e.payload,
  }));
}

/**
 * EARLY forfeit (before the no-contest grace, <2 rounds): leaving immediately
 * must NOT cost the leaver RP. Live signal: either no settlement at all, or a
 * final_results that carries no negative RP delta for the leaver (cancelled
 * no-contest). Guards the no-contest economy + the ghost-id refund fix.
 */
async function forfeitEarlyLive(users: { a: TestUser }): Promise<ScenarioResult> {
  const name = 'forfeit_early_live';
  const client = connectStaging(URL, users.a.accessToken, users.a.userId);
  try {
    if (!await waitConnected(client)) return { name, ok: false, detail: 'socket never connected', violations: [] };
    await clearActiveMatch(client);
    autoDraft(client); // resolve the draft, but DO NOT autoAnswer — we forfeit at q0/q1.
    client.socket.emit('ranked:queue_join', {});
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 150_000);
    if (!started) return { name, ok: false, detail: 'match never started', violations: [] };
    const matchId = client.latest<{ matchId?: string }>('match:start')?.matchId;

    // Forfeit immediately — before 2 rounds resolve (the early no-contest window).
    client.socket.emit('match:forfeit', { matchId });
    // Either nothing settles, or a final lands quickly; give it a bounded wait.
    await client.waitFor(() => hasFinalResultsForMatch(client.trace, matchId), 30_000);

    const final = finalForMatch(client, matchId);
    const delta = myDeltaRp(final, users.a.userId);
    const ok = delta == null || delta >= 0; // no RP penalty on an early forfeit
    return {
      name, ok,
      detail: ok
        ? `early forfeit: no RP penalty (delta=${delta ?? 'none'})`
        : `early forfeit WRONGLY penalized RP (delta=${delta})`,
      violations: ok ? [] : [`leaver lost ${delta} RP on an early (<2 round) forfeit`],
      events: tracedEvents(client),
      startedAt: client.trace.events[0]?.t,
      endedAt: client.trace.events[client.trace.events.length - 1]?.t,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * LATE forfeit (after the grace, >=2 rounds): leaving must settle as a real
 * forfeit — winnerDecisionMethod 'forfeit' and a NEGATIVE RP delta for the
 * leaver.
 */
async function forfeitLateLive(users: { a: TestUser }): Promise<ScenarioResult> {
  const name = 'forfeit_late_live';
  const client = connectStaging(URL, users.a.accessToken, users.a.userId);
  try {
    if (!await waitConnected(client)) return { name, ok: false, detail: 'socket never connected', violations: [] };
    await clearActiveMatch(client);
    autoAnswer(client); autoDraft(client); autoHalftime(client); autoRecover(client);
    client.socket.emit('ranked:queue_join', {});
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 150_000);
    if (!started) return { name, ok: false, detail: 'match never started', violations: [] };
    const matchId = client.latest<{ matchId?: string }>('match:start')?.matchId;

    // Play past the early-forfeit grace, THEN forfeit.
    await client.waitFor(() => client.count('match:round_result') >= 2, 90_000);
    client.socket.emit('match:forfeit', { matchId });
    const finished = await client.waitFor(() => hasFinalResultsForMatch(client.trace, matchId), 60_000);
    if (!finished) return { name, ok: false, detail: 'late forfeit produced no final_results', violations: [] };

    const final = finalForMatch(client, matchId);
    const method = (final as { winnerDecisionMethod?: string } | undefined)?.winnerDecisionMethod;
    const delta = myDeltaRp(final, users.a.userId);
    // Primary contract: the match settles as a FORFEIT (not a no-contest). If the
    // leaver's own RP delta is echoed it must be negative; but the forfeiter has
    // left the room, so an absent delta is acceptable — `method` is the signal.
    const ok = method === 'forfeit' && (delta == null || delta < 0);
    return {
      name, ok,
      detail: ok
        ? `late forfeit: settled as forfeit (leaver delta=${delta ?? 'not echoed'})`
        : `late forfeit unexpected (method=${method}, delta=${delta})`,
      violations: ok ? [] : [`expected forfeit settlement; got method=${method}, delta=${delta}`],
      events: tracedEvents(client),
      startedAt: client.trace.events[0]?.t,
      endedAt: client.trace.events[client.trace.events.length - 1]?.t,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * OPPONENT forfeits while we lead (2 humans): the surviving WINNER gets the
 * forfeit-win base + goal-margin bonus. Unlike the leaver, the winner stays in
 * the room and DOES receive their rankedOutcome — so we can assert deltaRp >=
 * base and (when ahead) that the margin bonus is included. NB: ranked needs the
 * matchmaker to pair two humans; if it falls back to AI this scenario can't run,
 * so we report it skipped rather than failed.
 */
async function opponentForfeitWinnerLive(users: { a: TestUser; b: TestUser }): Promise<ScenarioResult> {
  const name = 'opponent_forfeit_winner_live';
  const FORFEIT_WIN_BASE = 50;
  const marginBonus = (m: number) => (m >= 4 ? 40 : m === 3 ? 30 : m === 2 ? 15 : 0);
  const winner = connectStaging(URL, users.a.accessToken, users.a.userId);
  const loser = connectStaging(URL, users.b.accessToken, users.b.userId);
  try {
    if (!(await waitConnected(winner)) || !(await waitConnected(loser))) {
      return { name, ok: false, detail: 'sockets never connected', violations: [] };
    }
    await Promise.all([clearActiveMatch(winner), clearActiveMatch(loser)]);
    // Only the WINNER answers (builds a lead); the loser sits, then forfeits.
    autoAnswer(winner); autoDraft(winner); autoDraft(loser); autoHalftime(winner); autoHalftime(loser);

    winner.socket.emit('ranked:queue_join', {});
    loser.socket.emit('ranked:queue_join', {});
    const paired = await winner.waitFor(
      () => winner.count('match:start') > 0 && loser.count('match:start') > 0
        && winner.latest<{ matchId?: string }>('match:start')?.matchId === loser.latest<{ matchId?: string }>('match:start')?.matchId,
      45_000,
    );
    if (!paired) {
      return { name, ok: true, detail: 'SKIPPED: matchmaker did not pair two humans (AI fallback)', violations: [] };
    }
    const matchId = winner.latest<{ matchId?: string }>('match:start')?.matchId;

    // Let the winner build a lead, then the loser forfeits.
    await winner.waitFor(() => winner.count('match:round_result') >= 3, 90_000);
    loser.socket.emit('match:forfeit', { matchId });

    const finished = await winner.waitFor(() => hasFinalResultsForMatch(winner.trace, matchId), 60_000);
    if (!finished) return { name, ok: false, detail: 'no final_results after opponent forfeit', violations: [], events: tracedEvents(winner) };

    const final = finalForMatch(winner, matchId) as {
      winnerDecisionMethod?: string;
      players?: Record<string, { goals?: number }>;
    } | undefined;
    const delta = myDeltaRp(final, users.a.userId);
    const myGoals = final?.players?.[users.a.userId]?.goals ?? 0;
    const oppGoals = final?.players?.[users.b.userId]?.goals ?? 0;
    const margin = myGoals - oppGoals;

    let ok = delta != null && delta >= FORFEIT_WIN_BASE;
    let detail = `winner delta=${delta} (margin ${margin})`;
    if (ok && margin > 0) {
      const expected = FORFEIT_WIN_BASE + marginBonus(margin);
      ok = delta === expected;
      detail = ok ? `winner +${delta} = base+margin (${expected})` : `winner delta=${delta}, expected ${expected} for margin ${margin}`;
    }
    return {
      name, ok,
      detail: ok ? detail : `winner-side bonus wrong: ${detail}`,
      violations: ok ? [] : [detail],
      events: tracedEvents(winner),
      startedAt: winner.trace.events[0]?.t,
      endedAt: winner.trace.events[winner.trace.events.length - 1]?.t,
    };
  } finally {
    winner.disconnect(); loser.disconnect();
  }
}

/**
 * Draft ban COLLISION: two real clients race a ban on the SAME category. One
 * lands; the other must be rejected ('BAN_FAILED') WITHOUT wedging — the draft
 * still resolves to a match:start. Guards the idempotent-ban fix.
 */
async function draftBanCollisionLive(users: { a: TestUser; b: TestUser }): Promise<ScenarioResult> {
  const name = 'draft_ban_collision_live';
  const host = connectStaging(URL, users.a.accessToken, users.a.userId);
  const guest = connectStaging(URL, users.b.accessToken, users.b.userId);
  try {
    if (!(await waitConnected(host)) || !(await waitConnected(guest))) {
      return { name, ok: false, detail: 'sockets never connected', violations: [] };
    }
    await Promise.all([clearActiveMatch(host), clearActiveMatch(guest)]);
    autoAnswer(host); autoAnswer(guest); autoHalftime(host); autoHalftime(guest);

    // Collision driver: when the draft opens, BOTH seats try to ban the SAME
    // (first) category on their own turn. One wins; the loser gets BAN_FAILED and
    // must retry a DISTINCT category — the existing autoDraft fallback handles the
    // retry so the draft still completes.
    const banSame = (c: StagingClient) => {
      c.socket.on('draft:start', (state: { categories: Array<{ id: string }>; turnUserId: string }) => {
        if (state.turnUserId === c.userId && state.categories[0]) {
          c.socket.emit('draft:ban', { categoryId: state.categories[0].id });
        }
      });
    };
    banSame(host); banSame(guest);
    autoDraft(host); autoDraft(guest); // fallback: retry a distinct category on BAN_FAILED / next turn

    // Set up a friendly possession lobby (the path with a 2-human draft).
    let inviteCode: string | null = null;
    let memberCount = 0; let settingsSent = false; let settingsApplied = false;
    host.socket.on('lobby:state', (state: { inviteCode?: string | null; members?: unknown[]; settings?: { gameMode?: string } }) => {
      memberCount = state.members?.length ?? 0;
      if (!inviteCode && state.inviteCode) {
        inviteCode = state.inviteCode;
        setTimeout(() => guest.socket.emit('lobby:join_by_code', { inviteCode }), 300);
      }
      if (!settingsSent && memberCount >= 2) {
        settingsSent = true;
        host.socket.emit('lobby:update_settings', { gameMode: 'friendly_possession', friendlyRandom: true });
      }
      if (state.settings?.gameMode === 'friendly_possession') settingsApplied = true;
    });
    host.socket.emit('lobby:create', { mode: 'friendly' });

    const ready = await host.waitFor(() => memberCount >= 2 && settingsApplied, 30_000);
    if (ready) {
      await new Promise((r) => setTimeout(r, 500));
      host.socket.emit('lobby:ready', { ready: true });
      guest.socket.emit('lobby:ready', { ready: true });
      await new Promise((r) => setTimeout(r, 1_500));
      host.socket.emit('lobby:start', {});
    }

    // The collision is proven if the draft does NOT wedge: a match:start fires.
    const started = await host.waitFor(() => host.count('match:start') > 0, 60_000);
    const sawBanFailed =
      host.trace.byEvent('error').some((e) => (e.payload as { code?: string })?.code === 'BAN_FAILED')
      || guest.trace.byEvent('error').some((e) => (e.payload as { code?: string })?.code === 'BAN_FAILED');
    const ok = started; // not wedging is the contract; BAN_FAILED is the expected (informational) signal
    return {
      name, ok,
      detail: ok
        ? `draft survived the collision -> match started${sawBanFailed ? ' (BAN_FAILED observed)' : ''}`
        : 'draft WEDGED after a same-category collision (no match:start)',
      violations: ok ? [] : ['same-category ban collision wedged the draft'],
      events: tracedEvents(host),
      startedAt: host.trace.events[0]?.t,
      endedAt: host.trace.events[host.trace.events.length - 1]?.t,
    };
  } finally {
    host.disconnect(); guest.disconnect();
  }
}

type AnswerTimingQuestionPayload = {
  matchId: string;
  qIndex: number;
  correctIndex?: number;
  playableAt?: string;
  phaseKind?: string;
  question?: { kind?: string; items?: Array<{ id: string }> };
};

type AnswerTimingRoundResult = {
  matchId?: string;
  qIndex?: number;
  players?: Record<string, {
    timeMs?: number;
    pointsEarned?: number;
    answer?: { answerTimeMs?: number; timeMs?: number; pointsEarned?: number };
  }>;
};

function answerTimingOffsetMs(q: AnswerTimingQuestionPayload, offsetMs: number): number {
  if (!q.playableAt) return 0;
  const playableAtMs = new Date(q.playableAt).getTime();
  if (!Number.isFinite(playableAtMs)) return 0;
  return Math.max(0, playableAtMs + offsetMs - Date.now());
}

function answerTimingPlayerResult(result: AnswerTimingRoundResult, userId: string): { timeMs: number | null; pointsEarned: number | null } {
  const player = result.players?.[userId];
  return {
    timeMs: player?.timeMs ?? player?.answer?.answerTimeMs ?? player?.answer?.timeMs ?? null,
    pointsEarned: player?.pointsEarned ?? player?.answer?.pointsEarned ?? null,
  };
}

function answerTimingMyUserId(client: StagingClient): string {
  // match payloads key players by the PUBLIC users id, which can differ from the
  // auth id the harness carries — resolve "me" from match:start participants.
  const start = client.latest<{ mySeat?: number; participants?: Array<{ userId?: string; seat?: number }> }>('match:start');
  const mine = start?.participants?.find((p) => p.seat === start?.mySeat)?.userId;
  return mine ?? client.userId;
}

async function answerTimingLive(users: { a: TestUser }): Promise<ScenarioResult> {
  const name = 'answer_timing';
  const client = connectStaging(URL, users.a.accessToken, users.a.userId);
  const findingNames = ['reveal_ack', 'client_early', 'client_capped'] as const;
  type FindingName = (typeof findingNames)[number];
  const findings = new Map<FindingName, { name: string; ok: boolean; detail: string }>();
  const customByQIndex = new Map<number, FindingName>();
  const completed = new Set<string>();
  let normalMcqCount = 0;

  const keyFor = (matchId: string, qIndex: number) => `${matchId}:${qIndex}`;
  const record = (finding: FindingName, ok: boolean, detail: string) => {
    if (!findings.has(finding)) findings.set(finding, { name: finding, ok, detail });
  };
  const emitMcqAnswer = (q: AnswerTimingQuestionPayload, timeMs: number) => {
    if (completed.has(keyFor(q.matchId, q.qIndex))) return;
    client.socket.emit('match:answer', {
      matchId: q.matchId,
      qIndex: q.qIndex,
      selectedIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0,
      timeMs,
    });
  };
  const scheduleAt = (q: AnswerTimingQuestionPayload, offsetMs: number, work: () => void) => {
    setTimeout(work, answerTimingOffsetMs(q, offsetMs));
  };
  const sendDefaultAnswer = (q: AnswerTimingQuestionPayload, retryDelayMs = 50) => {
    const key = keyFor(q.matchId, q.qIndex);
    const waitMs = q.playableAt ? Math.max(0, new Date(q.playableAt).getTime() - Date.now()) : 0;
    setTimeout(() => {
      if (completed.has(key)) return;
      const kind = q.question?.kind ?? 'multipleChoice';
      const base = { matchId: q.matchId, qIndex: q.qIndex };
      if (kind === 'countdown') {
        client.socket.emit('match:countdown_guess', { ...base, guess: 'one' });
      } else if (kind === 'putInOrder') {
        const orderedItemIds = (q.question?.items ?? []).map((i) => i.id);
        client.socket.emit('match:put_in_order_answer', { ...base, orderedItemIds, timeMs: 500 });
      } else if (kind === 'clues') {
        client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: 'answer', timeMs: 500 });
      } else {
        emitMcqAnswer(q, 500);
      }
    }, waitMs + retryDelayMs);
  };

  client.socket.on('match:question', (q: AnswerTimingQuestionPayload) => {
    const kind = q.question?.kind ?? 'multipleChoice';
    const isNormalMcq = kind === 'multipleChoice' && (q.phaseKind === undefined || q.phaseKind === 'normal');
    if (isNormalMcq && normalMcqCount < 3) {
      const scenario = findingNames[normalMcqCount];
      normalMcqCount += 1;
      customByQIndex.set(q.qIndex, scenario);
      if (scenario === 'reveal_ack') {
        scheduleAt(q, 1000, () => {
          client.socket.emit('match:question_revealed', { matchId: q.matchId, qIndex: q.qIndex });
          scheduleAt(q, 1800, () => emitMcqAnswer(q, 800));
        });
      } else if (scenario === 'client_early') {
        scheduleAt(q, -1500, () => emitMcqAnswer(q, 1400));
      } else {
        scheduleAt(q, 4100, () => emitMcqAnswer(q, 900));
      }
      return;
    }
    sendDefaultAnswer(q);
  });

  client.socket.on('match:answer_ack', (ack: { matchId?: string; qIndex?: number; pointsEarned?: number }) => {
    if (ack.matchId && typeof ack.qIndex === 'number') completed.add(keyFor(ack.matchId, ack.qIndex));
    const scenario = typeof ack.qIndex === 'number' ? customByQIndex.get(ack.qIndex) : undefined;
    if (scenario === 'reveal_ack') {
      record(
        'reveal_ack',
        ack.pointsEarned === 100,
        `answer_ack pointsEarned=${ack.pointsEarned ?? 'missing'}`
      );
    }
  });

  client.socket.on('match:round_result', (result: AnswerTimingRoundResult) => {
    if (result.matchId && typeof result.qIndex === 'number') {
      completed.add(keyFor(result.matchId, result.qIndex));
      client.socket.emit('match:ready_for_next_question', {
        matchId: result.matchId,
        qIndex: result.qIndex,
      });
    }
    const scenario = typeof result.qIndex === 'number' ? customByQIndex.get(result.qIndex) : undefined;
    if (scenario === 'client_early') {
      const player = answerTimingPlayerResult(result, answerTimingMyUserId(client));
      record(
        'client_early',
        player.timeMs !== null && player.timeMs >= 1000 && player.pointsEarned === 100,
        `round_result timeMs=${player.timeMs ?? 'missing'} pointsEarned=${player.pointsEarned ?? 'missing'}`
      );
    } else if (scenario === 'client_capped') {
      const player = answerTimingPlayerResult(result, answerTimingMyUserId(client));
      record(
        'client_capped',
        player.timeMs !== null && player.timeMs >= 2200 && player.timeMs <= 2700 && player.pointsEarned === 90,
        `round_result timeMs=${player.timeMs ?? 'missing'} pointsEarned=${player.pointsEarned ?? 'missing'}`
      );
    }
  });

  try {
    if (!await waitConnected(client)) return { name, ok: false, detail: 'socket never connected', violations: [] };
    await clearActiveMatch(client);
    autoDraft(client); autoHalftime(client); autoRecover(client);
    client.socket.emit('ranked:queue_join', {});
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 150_000);
    if (!started) return { name, ok: false, detail: 'match never started', violations: [], findings: [...findings.values()] };
    const matchId = client.latest<{ matchId?: string }>('match:start')?.matchId;
    await client.waitFor(() => hasFinalResultsForMatch(client.trace, matchId), 420_000);

    for (const finding of findingNames) {
      if (!findings.has(finding)) record(finding, false, 'check did not complete');
    }
    const orderedFindings = findingNames.map((finding) => findings.get(finding)!);
    const failures = orderedFindings.filter((finding) => !finding.ok);
    const v = verdict(name, client.trace, false);
    v.findings = orderedFindings;
    if (failures.length > 0) {
      v.ok = false;
      v.violations.push(...failures.map((finding) => `${finding.name}: ${finding.detail}`));
    }
    v.detail += ` | answer timing ${orderedFindings.length - failures.length}/${orderedFindings.length}`;
    return v;
  } finally {
    client.disconnect();
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log(`[staging] ${URL} | scenarios: ${SELECTED.join(', ')}`);
  console.log('[staging] bootstrapping test users…');
  const users = await bootstrapTestUsers();
  console.log(`[staging] users ready: ${users.a.email} / ${users.b.email}`);

  const results: ScenarioResult[] = [];
  for (const name of SELECTED) {
    console.log(`\n[staging] ▶ ${name}`);
    let r: ScenarioResult;
    try {
      if (name === 'ranked_ai_smoke') r = await rankedAiSmoke(users);
      else if (name === 'friendly_possession_smoke') r = await friendlySmoke(name, false, users);
      else if (name === 'friendly_party_smoke') r = await friendlySmoke(name, true, users);
      else if (name === 'reconnect_smoke') r = await reconnectSmoke(users);
      else if (name === 'forfeit_early_live') r = await forfeitEarlyLive(users);
      else if (name === 'forfeit_late_live') r = await forfeitLateLive(users);
      else if (name === 'opponent_forfeit_winner_live') r = await opponentForfeitWinnerLive(users);
      else if (name === 'draft_ban_collision_live') r = await draftBanCollisionLive(users);
      else if (name === 'answer_timing') r = await answerTimingLive(users);
      else { console.log(`  (unknown scenario, skipped)`); continue; }
    } catch (err) {
      r = { name, ok: false, detail: `threw: ${(err as Error).message}`, violations: [] };
    }
    // Cross-source collection: Railway logs + PostHog events for this match window.
    if (r.startedAt && r.endedAt) {
      const { collectRailwayErrors, collectPostHogEvents } = await import('./collectors.mjs');
      const [logs, analytics] = await Promise.all([
        collectRailwayErrors({ sinceMs: r.startedAt, untilMs: r.endedAt }),
        collectPostHogEvents({ distinctIds: [users.a.userId, users.b.userId], sinceMs: r.startedAt, untilMs: r.endedAt }),
      ]);
      (r as ScenarioResult & { logs?: unknown; analytics?: unknown }).logs = logs;
      (r as ScenarioResult & { logs?: unknown; analytics?: unknown }).analytics = analytics;
      const logNote = logs.unavailable ? `logs: ${logs.unavailable}` : `logs: ${logs.errorLines.length} error/warn line(s)`;
      const phNote = analytics.unavailable ? `posthog: ${analytics.unavailable}` : `posthog: ${Object.keys(analytics.byEvent).length} event type(s), ${analytics.errorEvents} error_occurred`;
      console.log(`     ${logNote} | ${phNote}`);
    }

    results.push(r);
    console.log(`  ${r.ok ? '✅' : '❌'} ${name}: ${r.detail}`);
    for (const v of r.violations) console.log(`     ${v}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[staging] DONE (invariants): ${results.length - failed.length}/${results.length} clean`);

  // Write the report bundle (traces + verdicts + match windows) for trace review
  // + log correlation. One file per run, under staging/reports/.
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const dir = resolve('game-regression/staging/reports');
  await mkdir(dir, { recursive: true });
  const tag = process.env.STAGING_RUN_TAG ?? String(Math.floor(Date.now() / 1000));
  const bundlePath = resolve(dir, `staging-${tag}.json`);
  await writeFile(bundlePath, JSON.stringify({
    url: URL,
    runTag: tag,
    scenarios: results,
  }, null, 2));
  console.log(`[staging] report bundle: ${bundlePath}`);
  console.log('[staging] next: inspect the report bundle trace for any invariant failure.');

  // Best-effort: delete this run's fresh test users so they don't accumulate.
  if ((process.env.STAGING_KEEP_USERS ?? '0') !== '1') {
    await deleteTestUsers(users).catch(() => {});
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

void main();

// Keep TS happy about the unused Socket import shape in some configs.
export type { Socket };
