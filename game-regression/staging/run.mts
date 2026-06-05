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
const ALL = ['ranked_ai_smoke', 'friendly_possession_smoke', 'friendly_party_smoke', 'reconnect_smoke'];
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
  client.socket.on('draft:start', (state: { categories: Array<{ id: string }>; turnUserId: string }) => {
    if (state.turnUserId === client.userId && state.categories[0]) {
      client.socket.emit('draft:ban', { categoryId: state.categories[0].id });
    }
  });
  client.socket.on('draft:banned', () => {
    // On our turn after the opponent banned, ban the next available.
    // (Re-read via the recorded latest draft:start state.)
    const state = client.latest<{ categories: Array<{ id: string }>; turnUserId: string }>('draft:start');
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
    autoAnswer(client); autoDraft(client); autoHalftime(client);
    client.socket.emit('ranked:queue_join', {});
    // queue -> AI fallback -> draft -> match -> completion. Generous network waits.
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 60_000);
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
    autoAnswer(client); autoDraft(client); autoHalftime(client);
    client.socket.emit('ranked:queue_join', {});
    const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 60_000);
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
