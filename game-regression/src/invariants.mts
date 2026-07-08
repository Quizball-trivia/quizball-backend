/**
 * Invariants — the "referee". Each invariant is a rule the game must never break,
 * checked against a completed match's EventTrace (+ optional final DB state). A
 * violation returns a precise finding (rule, the offending event seq, and the
 * conflicting values) so a failure is reproducible without replaying by hand.
 *
 * These map directly to real bugs hit in this project:
 *   - orphaned match (stuck 'active')      -> terminalStateReached
 *   - "+8 bars / +0 score"                 -> scoreMatchesBars
 *   - "question 13 of 12"                  -> questionCounterInRange
 *   - halftime fired twice / illegal order -> legalPhaseOrder
 *   - duplicate round resolution           -> oneRoundResultPerQIndex
 */
import type { EventTrace, TraceEvent } from './adapter.mjs';
import type { ChaosPlan } from './chaos.mjs';

export interface Violation {
  invariant: string;
  message: string;
  seq?: number;
  detail?: Record<string, unknown>;
}

export interface InvariantResult {
  ok: boolean;
  violations: Violation[];
}

type Invariant = (trace: EventTrace) => Violation[];

export interface LifecycleInvariantContext {
  matchId: string;
  botUserId: string;
  chaosPlan?: ChaosPlan | null;
  runChaosLifecycleInvariants?: boolean;
}

function seatByUserId(trace: EventTrace): Map<string, 1 | 2> {
  const seats = new Map<string, 1 | 2>();
  for (const evt of trace.byEvent('match:start')) {
    const payload = evt.payload as {
      participants?: Array<{ userId?: string; seat?: number }>;
    };
    for (const participant of payload.participants ?? []) {
      if (!participant.userId) continue;
      if (participant.seat !== 1 && participant.seat !== 2) continue;
      seats.set(participant.userId, participant.seat);
    }
    if (seats.size > 0) break;
  }
  return seats;
}

// ── Individual rules ──

/** The match must reach a terminal state (final_results emitted). */
const terminalStateReached: Invariant = (trace) => {
  if (trace.byEvent('match:final_results').length > 0) return [];
  const phases = trace.byEvent('match:state').map((e) => (e.payload as { phase?: string }).phase);
  const lastPhase = phases[phases.length - 1];
  if (lastPhase === 'COMPLETED') return [];
  return [{
    invariant: 'terminalStateReached',
    message: 'Match never reached a terminal state (no match:final_results and last phase not COMPLETED).',
    detail: { lastPhase: lastPhase ?? null, stateCount: phases.length },
  }];
};

/**
 * Per round, the bar points (possessionPointsEarned) must reconcile with the
 * score (pointsEarned). They are NOT always equal: a 2× speed-streak bonus
 * (NORMAL play) intentionally DOUBLES the holder's possession points
 * (possession-round-resolver.ts:386). So the valid relationship is:
 *   possessionPointsEarned === pointsEarned   (no boost)
 *   OR possessionPointsEarned === pointsEarned * 2   (speed-streak boost)
 * Any OTHER value is the real "+8 bars / +0 score" class of bug.
 */
const scoreMatchesBars: Invariant = (trace) => {
  const out: Violation[] = [];
  const seats = seatByUserId(trace);
  for (const evt of trace.byEvent('match:round_result')) {
    const payload = evt.payload as {
      qIndex?: number;
      phaseKind?: string;
      deltas?: { speedStreakBoostedSeat?: 1 | 2 | null };
      players?: Record<string, { pointsEarned?: number; possessionPointsEarned?: number }>;
    };
    for (const [userId, p] of Object.entries(payload.players ?? {})) {
      const score = p.pointsEarned;
      const bars = p.possessionPointsEarned;
      if (typeof score !== 'number' || typeof bars !== 'number') continue;
      const seat = seats.get(userId) ?? null;
      const boostedSeat = payload.deltas?.speedStreakBoostedSeat ?? null;
      const boostIsValidForPlayer =
        payload.phaseKind === 'normal' &&
        score > 0 &&
        bars === score * 2 &&
        boostedSeat !== null &&
        seat === boostedSeat;
      const reconciles = bars === score || boostIsValidForPlayer;
      if (!reconciles) {
        out.push({
          invariant: 'scoreMatchesBars',
          message: `Round ${payload.qIndex}: bar points (${bars}) do not reconcile with score (${score}) and boost seat (${boostedSeat ?? 'none'}).`,
          seq: evt.seq,
          detail: {
            qIndex: payload.qIndex,
            userId,
            seat,
            phaseKind: payload.phaseKind,
            speedStreakBoostedSeat: boostedSeat,
            pointsEarned: score,
            possessionPointsEarned: bars,
          },
        });
      }
    }
  }
  return out;
};

/**
 * The "question 13 of 12" guard. IMPORTANT (per Codex review): `qIndex` is a GLOBAL
 * round index that includes last_attack/penalty bonus phases, so `qIndex < total`
 * is wrong — a global qIndex of 12 is normal when a last_attack round was inserted.
 * The right counter for normal questions is `phaseRound`
 * (= normalQuestionsAnsweredTotal + 1, possession-question-dispatch.ts:487), which
 * the client should display as "phaseRound of total". So for NORMAL-play questions
 * we assert `phaseRound <= total`. Non-normal phases are exempt.
 */
const questionCounterInRange: Invariant = (trace) => {
  const out: Violation[] = [];
  for (const evt of trace.byEvent('match:question')) {
    const { total, phaseKind, phaseRound } = evt.payload as {
      total?: number; phaseKind?: string; phaseRound?: number;
    };
    const isNormal = phaseKind === undefined || phaseKind === 'normal';
    if (isNormal && typeof phaseRound === 'number' && typeof total === 'number' && phaseRound > total) {
      out.push({
        invariant: 'questionCounterInRange',
        message: `Normal-play phaseRound ${phaseRound} > total ${total} ("question ${phaseRound} of ${total}").`,
        seq: evt.seq,
        detail: { phaseRound, total, phaseKind },
      });
    }
  }
  return out;
};

/**
 * Phase transitions must follow the legal graph; no question after COMPLETED.
 * IMPORTANT (per Codex review): a second-half DRAW routes into penalties THROUGH a
 * HALFTIME-style ban interlude (possession-resolution.ts:148) — penalties are never
 * entered directly from NORMAL_PLAY/LAST_ATTACK. So PENALTY_SHOOTOUT is reachable
 * ONLY from HALFTIME; allowing NORMAL_PLAY→PENALTY_SHOOTOUT would let a "ban skipped"
 * bug pass. LAST_ATTACK→HALFTIME is legal (last-attack resolution can enter the
 * half boundary, resolution.ts:204/137).
 */
const ALLOWED_NEXT: Record<string, string[]> = {
  NORMAL_PLAY: ['NORMAL_PLAY', 'LAST_ATTACK', 'HALFTIME', 'COMPLETED'],
  LAST_ATTACK: ['LAST_ATTACK', 'HALFTIME', 'NORMAL_PLAY', 'COMPLETED'],
  HALFTIME: ['HALFTIME', 'NORMAL_PLAY', 'PENALTY_SHOOTOUT', 'COMPLETED'],
  PENALTY_SHOOTOUT: ['PENALTY_SHOOTOUT', 'COMPLETED'],
  COMPLETED: ['COMPLETED'],
};

const legalPhaseOrder: Invariant = (trace) => {
  const out: Violation[] = [];
  let prev: string | null = null;
  let completedSeq: number | null = null;
  for (const evt of trace.events) {
    if (evt.event === 'match:state') {
      const phase = (evt.payload as { phase?: string }).phase;
      if (!phase) continue;
      if (prev && prev !== phase) {
        const allowed: string[] = ALLOWED_NEXT[prev] ?? [];
        if (!allowed.includes(phase)) {
          out.push({
            invariant: 'legalPhaseOrder',
            message: `Illegal phase transition ${prev} -> ${phase}.`,
            seq: evt.seq,
            detail: { from: prev, to: phase },
          });
        }
      }
      if (phase === 'COMPLETED' && completedSeq === null) completedSeq = evt.seq;
      prev = phase;
    }
    if (evt.event === 'match:question' && completedSeq !== null) {
      out.push({
        invariant: 'legalPhaseOrder',
        message: 'A question was dispatched after the match reached COMPLETED.',
        seq: evt.seq,
        detail: { completedAtSeq: completedSeq },
      });
    }
  }
  return out;
};

/** Each qIndex must resolve exactly once (no duplicate round_result). */
const oneRoundResultPerQIndex: Invariant = (trace) => {
  const out: Violation[] = [];
  const seen = new Map<number, number>();
  for (const evt of trace.byEvent('match:round_result')) {
    const qIndex = (evt.payload as { qIndex?: number }).qIndex;
    if (typeof qIndex !== 'number') continue;
    const count = (seen.get(qIndex) ?? 0) + 1;
    seen.set(qIndex, count);
    if (count > 1) {
      out.push({
        invariant: 'oneRoundResultPerQIndex',
        message: `qIndex ${qIndex} resolved ${count} times (duplicate round_result).`,
        seq: evt.seq,
        detail: { qIndex, count },
      });
    }
  }
  return out;
};

/**
 * A qIndex must be FRESHLY dispatched at most once. IMPORTANT (per Codex review):
 * the engine legitimately RE-EMITS the current question on rejoin/resume:
 *   - hydration replays via `socket.emit` (possession-question-dispatch.ts:201) —
 *     these are per-socket (recorded as 'server->socket'), so we ignore them here
 *     by only counting match-ROOM broadcasts.
 *   - resume re-dispatches via `io.to(match:...).emit` (line 727) — same channel as
 *     a fresh dispatch, so we treat a repeat room-broadcast as LEGAL only if a
 *     `match:resume` (or rejoin) occurred since the previous dispatch of that qIndex.
 * A repeat room-broadcast with NO intervening resume is the real duplicate-dispatch bug.
 */
const oneQuestionPerQIndex: Invariant = (trace) => {
  const out: Violation[] = [];
  const lastDispatchSeq = new Map<number, number>();
  for (const evt of trace.events) {
    if (evt.event !== 'match:question') continue;
    // Only match-room broadcasts are "dispatches"; per-socket hydration replays
    // (dir 'server->socket') are legal and ignored.
    if (evt.dir !== 'server->room' || !String(evt.target ?? '').startsWith('match:')) continue;
    const qIndex = (evt.payload as { qIndex?: number }).qIndex;
    if (typeof qIndex !== 'number') continue;
    const prevSeq = lastDispatchSeq.get(qIndex);
    if (prevSeq !== undefined) {
      // Only an actual RESUME legitimizes a room re-dispatch of the in-progress
      // question. match:rejoin_available merely means "you may rejoin" (still
      // paused) and does NOT. The resume re-dispatch can be at/just-before this
      // event in sequence, so accept any match:resume AFTER the previous dispatch
      // and at-or-before this one (not strictly between).
      //
      // A mid-match match:start is also a valid boundary: on a fast reconnect
      // the pause is intentionally skipped (stableLiveSocket reload path), so
      // there is no match:resume — rejoinActiveMatchOnConnect replays
      // match:start + match:state + the CURRENT question to the returning
      // client. Over the network (staging harness) that per-socket replay is
      // indistinguishable from a room emit, so without this boundary every
      // socket blip false-positives this invariant.
      const resumedSincePrev = trace.events.some(
        (e) =>
          (e.event === 'match:resume' || e.event === 'match:start') &&
          e.seq > prevSeq &&
          e.seq <= evt.seq,
      );
      if (!resumedSincePrev) {
        out.push({
          invariant: 'oneQuestionPerQIndex',
          message: `qIndex ${qIndex} re-dispatched with no intervening resume (duplicate match:question).`,
          seq: evt.seq,
          detail: { qIndex, prevSeq },
        });
      }
    }
    lastDispatchSeq.set(qIndex, evt.seq);
  }
  return out;
};

/**
 * The results screen must be sendable: a completed match emits exactly ONE
 * match:final_results whose payload is well-formed — a winnerId field (string or
 * null), a non-empty players map, each player carrying numeric totalPoints and
 * correctAnswers, plus durationMs and resultVersion. A blank/duplicate results
 * screen is exactly the "match ended but results didn't display right" class.
 */
interface FinalResultsPayload {
  winnerId?: string | null;
  players?: Record<string, { totalPoints?: unknown; correctAnswers?: unknown }>;
  durationMs?: unknown;
  resultVersion?: unknown;
}
const finalResultsWellFormed: Invariant = (trace) => {
  const out: Violation[] = [];
  const finals = trace.byEvent('match:final_results');
  if (finals.length === 0) return out; // terminalStateReached owns the "never finished" case.
  if (finals.length > 1) {
    out.push({
      invariant: 'finalResultsWellFormed',
      message: `match:final_results emitted ${finals.length} times to the room (results screen should fire once).`,
      seq: finals[finals.length - 1].seq,
      detail: { count: finals.length },
    });
  }
  const evt = finals[0];
  const p = evt.payload as FinalResultsPayload;
  const problems: string[] = [];
  if (!('winnerId' in (p as object))) problems.push('missing winnerId');
  const players = p.players ?? {};
  const ids = Object.keys(players);
  if (ids.length === 0) problems.push('empty players map');
  for (const id of ids) {
    const pl = players[id];
    if (typeof pl?.totalPoints !== 'number') problems.push(`player ${id} totalPoints not numeric`);
    if (typeof pl?.correctAnswers !== 'number') problems.push(`player ${id} correctAnswers not numeric`);
  }
  if (typeof p.durationMs !== 'number') problems.push('durationMs not numeric');
  if (typeof p.resultVersion !== 'number') problems.push('resultVersion not numeric');
  if (problems.length > 0) {
    out.push({
      invariant: 'finalResultsWellFormed',
      message: `Results payload malformed: ${problems.join('; ')}.`,
      seq: evt.seq,
      detail: { problems },
    });
  }
  return out;
};

/**
 * The winner declared on the results screen must reconcile with the scores it
 * reports: if a winnerId is given it must be one of the listed players, and that
 * player's totalPoints must be >= every other player's (ties/penalty decide the
 * winnerDecisionMethod, but the winner is never strictly out-scored). Catches a
 * results screen that shows the wrong winner.
 */
const winnerMatchesResults: Invariant = (trace) => {
  const out: Violation[] = [];
  const finals = trace.byEvent('match:final_results');
  if (finals.length === 0) return out;
  const p = finals[0].payload as FinalResultsPayload & { winnerDecisionMethod?: string | null };
  const players = p.players ?? {};
  if (p.winnerId == null) return out; // draw — nothing to reconcile.
  if (!(p.winnerId in players)) {
    out.push({
      invariant: 'winnerMatchesResults',
      message: `winnerId ${p.winnerId} is not among the results players.`,
      seq: finals[0].seq,
      detail: { winnerId: p.winnerId, playerIds: Object.keys(players) },
    });
    return out;
  }
  // Goals/penalties can decide a winner who is not the top scorer, so only assert
  // the score relationship when the decision was by total points.
  const method = p.winnerDecisionMethod;
  if (method === 'total_points' || method === 'total_points_fallback' || method == null) {
    const winnerPts = (players[p.winnerId]?.totalPoints as number) ?? 0;
    for (const [id, pl] of Object.entries(players)) {
      if (id === p.winnerId) continue;
      const pts = (pl?.totalPoints as number) ?? 0;
      if (pts > winnerPts) {
        out.push({
          invariant: 'winnerMatchesResults',
          message: `Declared winner ${p.winnerId} (${winnerPts}) was out-scored by ${id} (${pts}) under ${method ?? 'default'} decision.`,
          seq: finals[0].seq,
          detail: { winnerId: p.winnerId, winnerPts, otherId: id, otherPts: pts, method },
        });
      }
    }
  }
  return out;
};

interface MatchLifecycleDbMatch {
  id: string;
  status: string;
  mode: string;
  winner_user_id: string | null;
  state_payload: unknown;
}

interface MatchLifecycleDbFacts {
  match: MatchLifecycleDbMatch | null;
  players: Array<{ user_id: string; is_ai: boolean | null }>;
  answers: Array<{ q_index: number; user_id: string; time_ms: number; phase_kind: string | null }>;
}

function payloadRecord(event: TraceEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function payloadUserId(event: TraceEvent): string | null {
  const userId = payloadRecord(event).userId;
  return typeof userId === 'string' ? userId : null;
}

function payloadQIndex(event: TraceEvent): number | null {
  const qIndex = payloadRecord(event).qIndex;
  return typeof qIndex === 'number' ? qIndex : null;
}

function winnerDecisionMethodFromFacts(facts: MatchLifecycleDbFacts, trace: EventTrace): string | null {
  const state = facts.match?.state_payload;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const method = (state as { winnerDecisionMethod?: unknown }).winnerDecisionMethod;
    if (typeof method === 'string') return method;
  }
  const final = trace.byEvent('match:final_results')[0]?.payload;
  if (final && typeof final === 'object' && !Array.isArray(final)) {
    const method = (final as { winnerDecisionMethod?: unknown }).winnerDecisionMethod;
    if (typeof method === 'string') return method;
  }
  return null;
}

function lastDisconnectSeqForUser(trace: EventTrace, userId: string): number | null {
  let seq: number | null = null;
  for (const event of trace.events) {
    if (payloadUserId(event) !== userId) continue;
    if (
      event.event === 'match:disconnect' ||
      event.event === 'match:leave' ||
      event.event === 'match:stale_disconnect'
    ) {
      seq = event.seq;
    }
  }
  return seq;
}

function presentEvidenceAfterLastDisconnect(trace: EventTrace, userId: string): TraceEvent | null {
  const lastDisconnectSeq = lastDisconnectSeqForUser(trace, userId);
  if (lastDisconnectSeq === null) return null;
  const userPresenceEvents = new Set([
    'match:rejoin',
    'match:resume_ui_ready',
    'match:presence_heartbeat',
    'match:question_revealed',
    'match:answer',
    'match:gate_reconnected',
    'match:stale_disconnect',
  ]);
  for (const event of trace.events) {
    if (event.seq < lastDisconnectSeq) continue;
    if (userPresenceEvents.has(event.event) && payloadUserId(event) === userId) return event;
    if (event.event === 'match:resume' && event.seq > lastDisconnectSeq) return event;
  }
  return null;
}

async function loadLifecycleDbFacts(matchId: string): Promise<MatchLifecycleDbFacts> {
  const { sql } = await import('../../src/db/index.js');
  const [match] = await sql<MatchLifecycleDbMatch[]>
    `SELECT id, status, mode, winner_user_id, state_payload FROM matches WHERE id = ${matchId}`;
  const players = await sql<Array<{ user_id: string; is_ai: boolean | null }>>`
    SELECT mp.user_id, u.is_ai
    FROM match_players mp
    LEFT JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ${matchId}
  `;
  const answers = await sql<MatchLifecycleDbFacts['answers']>`
    SELECT q_index, user_id, time_ms, phase_kind
    FROM match_answers
    WHERE match_id = ${matchId}
  `;
  return { match: match ?? null, players, answers };
}

async function readReconnectCount(matchId: string, userId: string): Promise<number> {
  const [{ getRedisClient }, { matchReconnectCountKey }] = await Promise.all([
    import('../../src/realtime/redis.js'),
    import('../../src/realtime/match-keys.js'),
  ]);
  const redis = getRedisClient();
  if (!redis?.isOpen) return 0;
  const raw = await redis.get(matchReconnectCountKey(matchId, userId));
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function realDisconnectEpisodesForChaosPlan(plan: ChaosPlan | null | undefined): number {
  let count = 0;
  for (const action of plan?.actions ?? []) {
    if (action.kind === 'flap') {
      count += Math.max(1, Math.floor(Number(action.params?.n ?? 1) || 1));
    } else if (
      action.kind === 'multiTab' ||
      action.kind === 'quitRejoin' ||
      action.kind === 'zombieReconnect' ||
      action.kind === 'expireGraceAfterDisconnect' ||
      action.kind === 'flapAtKickoffGate'
    ) {
      count += 1;
    }
  }
  return count;
}

async function presentPlayerNeverForfeited(
  trace: EventTrace,
  context: LifecycleInvariantContext,
  facts: MatchLifecycleDbFacts,
): Promise<Violation[]> {
  const method = winnerDecisionMethodFromFacts(facts, trace);
  const winnerId = facts.match?.winner_user_id ?? null;
  if (method !== 'forfeit' || !winnerId || winnerId === context.botUserId) return [];
  const evidence = presentEvidenceAfterLastDisconnect(trace, context.botUserId);
  if (!evidence) return [];
  return [{
    invariant: 'presentPlayerNeverForfeited',
    message: 'Bot was forfeited after trace evidence showed it was present in the match.',
    seq: evidence.seq,
    detail: {
      matchId: context.matchId,
      botUserId: context.botUserId,
      winnerId,
      winnerDecisionMethod: method,
      evidenceEvent: evidence.event,
      evidenceSeq: evidence.seq,
      lastDisconnectSeq: lastDisconnectSeqForUser(trace, context.botUserId),
    },
  }];
}

async function disconnectCountBounded(
  _trace: EventTrace,
  context: LifecycleInvariantContext,
): Promise<Violation[]> {
  const actual = await readReconnectCount(context.matchId, context.botUserId);
  const expectedMax = realDisconnectEpisodesForChaosPlan(context.chaosPlan);
  if (actual <= expectedMax) return [];
  return [{
    invariant: 'disconnectCountBounded',
    message: `Reconnect count ${actual} exceeded ${expectedMax} real disconnect episode(s) from the chaos plan.`,
    detail: {
      matchId: context.matchId,
      botUserId: context.botUserId,
      reconnectCount: actual,
      realDisconnectEpisodes: expectedMax,
      chaosPlan: context.chaosPlan ?? null,
    },
  }];
}

async function noForfeitWinToAiOverLeadingPresentHuman(
  trace: EventTrace,
  context: LifecycleInvariantContext,
  facts: MatchLifecycleDbFacts,
): Promise<Violation[]> {
  const method = winnerDecisionMethodFromFacts(facts, trace);
  const winnerId = facts.match?.winner_user_id ?? null;
  if (method !== 'forfeit' || !winnerId || winnerId === context.botUserId) return [];
  const winner = facts.players.find((player) => player.user_id === winnerId);
  if (winner?.is_ai !== true) return [];
  const evidence = presentEvidenceAfterLastDisconnect(trace, context.botUserId);
  if (!evidence) return [];
  return [{
    invariant: 'noForfeitWinToAiOverLeadingPresentHuman',
    message: 'AI was awarded a forfeit win while the human bot had present-match trace evidence after disconnect.',
    seq: evidence.seq,
    detail: {
      matchId: context.matchId,
      botUserId: context.botUserId,
      winnerId,
      evidenceEvent: evidence.event,
      evidenceSeq: evidence.seq,
    },
  }];
}

function gateStateReemittedOnReconnect(
  trace: EventTrace,
  context: LifecycleInvariantContext,
): Violation[] {
  return trace.events
    .filter((event) =>
      event.event === 'match:gate_reconnected' &&
      payloadUserId(event) === context.botUserId &&
      payloadRecord(event).withinGrace === true
    )
    .filter((reconnected) => {
      const freshSocketId = payloadRecord(reconnected).freshSocketId;
      const roomTarget = `match:${context.matchId}`;
      return !trace.events.some((event) =>
        event.seq > reconnected.seq &&
        event.event === 'match:waiting_for_ready' &&
        (event.payload as { phase?: unknown } | undefined)?.phase === 'kickoff' &&
        (event.target === freshSocketId || event.target === roomTarget)
      );
    })
    .map((reconnected) => ({
      invariant: 'gateStateReemittedOnReconnect',
      message: 'Reconnected socket at the kickoff ready gate never received a match:waiting_for_ready re-emit — the client has no server-initiated path back into the gate.',
      seq: reconnected.seq,
      detail: {
        matchId: context.matchId,
        botUserId: context.botUserId,
        freshSocketId: payloadRecord(reconnected).freshSocketId ?? null,
        mode: payloadRecord(reconnected).mode ?? null,
        reconnectDelayMs: payloadRecord(reconnected).reconnectDelayMs ?? null,
      },
    }));
}

async function matchNeverAbandonedWithPresentPlayer(
  trace: EventTrace,
  context: LifecycleInvariantContext,
  facts: MatchLifecycleDbFacts,
): Promise<Violation[]> {
  if (facts.match?.status !== 'abandoned') return [];
  const gateAction = trace.events.find((event) =>
    event.event === 'chaos:action' &&
    payloadUserId(event) === context.botUserId &&
    payloadRecord(event).kind === 'flapAtKickoffGate'
  );
  if (!gateAction) return [];
  const reconnected = trace.events.find((event) =>
    event.seq > gateAction.seq &&
    event.event === 'match:gate_reconnected' &&
    payloadUserId(event) === context.botUserId &&
    payloadRecord(event).withinGrace === true &&
    // A 'blind' bot deliberately never completes the rejoin handshake — the
    // server abandoning it after the bounded window is CORRECT (S15b6). Only
    // a bot that actually recovered may claim wrongful abandonment.
    payloadRecord(event).mode !== 'blind'
  );
  if (!reconnected) return [];
  return [{
    invariant: 'matchNeverAbandonedWithPresentPlayer',
    message: 'Match was abandoned after the bot reconnected inside the kickoff gate grace window.',
    seq: reconnected.seq,
    detail: {
      matchId: context.matchId,
      botUserId: context.botUserId,
      evidenceEvent: reconnected.event,
      evidenceSeq: reconnected.seq,
      reconnectDelayMs: payloadRecord(reconnected).reconnectDelayMs ?? null,
    },
  }];
}

function storedAnswerTimingSane(
  trace: EventTrace,
  context: LifecycleInvariantContext,
  facts: MatchLifecycleDbFacts,
): Violation[] {
  const out: Violation[] = [];
  const chaosQIndices = new Set((context.chaosPlan?.actions ?? [])
    .filter((action) => action.kind !== 'withholdReadyAcks')
    .map((action) => action.atQIndex));
  const answersByQIndex = new Map<number, { time_ms: number; phase_kind: string | null }>();
  for (const row of facts.answers) {
    if (row.user_id !== context.botUserId) continue;
    answersByQIndex.set(row.q_index, { time_ms: row.time_ms, phase_kind: row.phase_kind });
  }

  for (const answerEvent of trace.events) {
    if (answerEvent.event !== 'match:answer' || payloadUserId(answerEvent) !== context.botUserId) continue;
    if (payloadRecord(answerEvent).questionKind !== 'multipleChoice') continue;
    const qIndex = payloadQIndex(answerEvent);
    if (qIndex === null || chaosQIndices.has(qIndex)) continue;
    const row = answersByQIndex.get(qIndex);
    if (!row || (row.phase_kind !== null && row.phase_kind !== 'normal')) continue;
    const revealAck = [...trace.events].reverse().find((event) =>
      event.seq < answerEvent.seq &&
      event.event === 'match:question_revealed' &&
      payloadUserId(event) === context.botUserId &&
      payloadQIndex(event) === qIndex
    );
    if (!revealAck) continue;
    const expected = answerEvent.t - revealAck.t;
    const diff = Math.abs(row.time_ms - expected);
    if (row.time_ms === 0 && expected > 1500) {
      out.push({
        invariant: 'storedAnswerTimingSane',
        message: `qIndex ${qIndex}: persisted time_ms=0 but answer arrived ${expected}ms after reveal ack.`,
        seq: answerEvent.seq,
        detail: {
          matchId: context.matchId,
          qIndex,
          storedTimeMs: row.time_ms,
          answerMinusRevealAckMs: expected,
          revealAckSeq: revealAck.seq,
        },
      });
    } else if (diff > 1500) {
      out.push({
        invariant: 'storedAnswerTimingSane',
        message: `qIndex ${qIndex}: persisted time_ms ${row.time_ms} diverged from answer-reveal delta ${expected}ms.`,
        seq: answerEvent.seq,
        detail: {
          matchId: context.matchId,
          qIndex,
          storedTimeMs: row.time_ms,
          answerMinusRevealAckMs: expected,
          diffMs: diff,
          revealAckSeq: revealAck.seq,
        },
      });
    }
  }
  return out;
}

export const ALL_INVARIANTS: Array<{ name: string; check: Invariant }> = [
  { name: 'terminalStateReached', check: terminalStateReached },
  { name: 'scoreMatchesBars', check: scoreMatchesBars },
  { name: 'questionCounterInRange', check: questionCounterInRange },
  { name: 'legalPhaseOrder', check: legalPhaseOrder },
  { name: 'oneRoundResultPerQIndex', check: oneRoundResultPerQIndex },
  { name: 'oneQuestionPerQIndex', check: oneQuestionPerQIndex },
  { name: 'finalResultsWellFormed', check: finalResultsWellFormed },
  { name: 'winnerMatchesResults', check: winnerMatchesResults },
];

/** Run all invariants against a trace and collect violations. */
export function checkInvariants(trace: EventTrace): InvariantResult {
  const violations: Violation[] = [];
  for (const { check } of ALL_INVARIANTS) violations.push(...check(trace));
  return { ok: violations.length === 0, violations };
}

export async function checkLifecycleInvariants(
  trace: EventTrace,
  context: LifecycleInvariantContext,
): Promise<InvariantResult> {
  const facts = await loadLifecycleDbFacts(context.matchId);
  const violations: Violation[] = [
    ...storedAnswerTimingSane(trace, context, facts),
  ];
  const runChaosChecks =
    context.runChaosLifecycleInvariants ?? Boolean(context.chaosPlan && context.chaosPlan.actions.length > 0);
  if (runChaosChecks) {
    violations.push(
      ...await presentPlayerNeverForfeited(trace, context, facts),
      ...await disconnectCountBounded(trace, context),
      ...await noForfeitWinToAiOverLeadingPresentHuman(trace, context, facts),
      ...await matchNeverAbandonedWithPresentPlayer(trace, context, facts),
      ...gateStateReemittedOnReconnect(trace, context),
    );
  }
  return { ok: violations.length === 0, violations };
}

/** Human-readable one-liner per violation, for reports. */
export function formatViolation(v: Violation): string {
  const at = v.seq !== undefined ? ` @seq ${v.seq}` : '';
  const detail = v.detail ? ` ${JSON.stringify(v.detail)}` : '';
  return `[${v.invariant}]${at} ${v.message}${detail}`;
}

export type { TraceEvent };
