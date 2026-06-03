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
  for (const evt of trace.byEvent('match:round_result')) {
    const payload = evt.payload as {
      qIndex?: number;
      players?: Record<string, { pointsEarned?: number; possessionPointsEarned?: number }>;
    };
    for (const [userId, p] of Object.entries(payload.players ?? {})) {
      const score = p.pointsEarned;
      const bars = p.possessionPointsEarned;
      if (typeof score !== 'number' || typeof bars !== 'number') continue;
      const reconciles = bars === score || bars === score * 2;
      if (!reconciles) {
        out.push({
          invariant: 'scoreMatchesBars',
          message: `Round ${payload.qIndex}: bar points (${bars}) do not reconcile with score (${score}) — expected ${score} or ${score * 2} (2× streak).`,
          seq: evt.seq,
          detail: { qIndex: payload.qIndex, userId, pointsEarned: score, possessionPointsEarned: bars },
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
        const allowed = ALLOWED_NEXT[prev] ?? [];
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
      const resumedBetween = trace.events.some(
        (e) => (e.event === 'match:resume' || e.event === 'match:rejoin_available') &&
          e.seq > prevSeq && e.seq < evt.seq,
      );
      if (!resumedBetween) {
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

export const ALL_INVARIANTS: Array<{ name: string; check: Invariant }> = [
  { name: 'terminalStateReached', check: terminalStateReached },
  { name: 'scoreMatchesBars', check: scoreMatchesBars },
  { name: 'questionCounterInRange', check: questionCounterInRange },
  { name: 'legalPhaseOrder', check: legalPhaseOrder },
  { name: 'oneRoundResultPerQIndex', check: oneRoundResultPerQIndex },
  { name: 'oneQuestionPerQIndex', check: oneQuestionPerQIndex },
];

/** Run all invariants against a trace and collect violations. */
export function checkInvariants(trace: EventTrace): InvariantResult {
  const violations: Violation[] = [];
  for (const { check } of ALL_INVARIANTS) violations.push(...check(trace));
  return { ok: violations.length === 0, violations };
}

/** Human-readable one-liner per violation, for reports. */
export function formatViolation(v: Violation): string {
  const at = v.seq !== undefined ? ` @seq ${v.seq}` : '';
  const detail = v.detail ? ` ${JSON.stringify(v.detail)}` : '';
  return `[${v.invariant}]${at} ${v.message}${detail}`;
}

export type { TraceEvent };
