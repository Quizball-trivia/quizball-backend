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

/** Per round, each player's possessionPointsEarned ("bars") must equal pointsEarned ("score"). */
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
      if (typeof score === 'number' && typeof bars === 'number' && score !== bars) {
        out.push({
          invariant: 'scoreMatchesBars',
          message: `Round ${payload.qIndex}: player score (${score}) != bar points (${bars}).`,
          seq: evt.seq,
          detail: { qIndex: payload.qIndex, userId, pointsEarned: score, possessionPointsEarned: bars },
        });
      }
    }
  }
  return out;
};

/** The dispatched question index must always be < total. */
const questionCounterInRange: Invariant = (trace) => {
  const out: Violation[] = [];
  for (const evt of trace.byEvent('match:question')) {
    const { qIndex, total } = evt.payload as { qIndex?: number; total?: number };
    if (typeof qIndex === 'number' && typeof total === 'number' && qIndex >= total) {
      out.push({
        invariant: 'questionCounterInRange',
        message: `Dispatched question qIndex ${qIndex} >= total ${total}.`,
        seq: evt.seq,
        detail: { qIndex, total },
      });
    }
  }
  return out;
};

/** Phase transitions must follow the legal graph; no question after COMPLETED. */
const ALLOWED_NEXT: Record<string, string[]> = {
  NORMAL_PLAY: ['NORMAL_PLAY', 'LAST_ATTACK', 'HALFTIME', 'PENALTY_SHOOTOUT', 'COMPLETED'],
  LAST_ATTACK: ['LAST_ATTACK', 'HALFTIME', 'NORMAL_PLAY', 'PENALTY_SHOOTOUT', 'COMPLETED'],
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

/** Each qIndex must be dispatched (match:question) at most once. */
const oneQuestionPerQIndex: Invariant = (trace) => {
  const out: Violation[] = [];
  const seen = new Map<number, number>();
  for (const evt of trace.byEvent('match:question')) {
    const qIndex = (evt.payload as { qIndex?: number }).qIndex;
    if (typeof qIndex !== 'number') continue;
    const count = (seen.get(qIndex) ?? 0) + 1;
    seen.set(qIndex, count);
    if (count > 1) {
      out.push({
        invariant: 'oneQuestionPerQIndex',
        message: `qIndex ${qIndex} dispatched ${count} times (duplicate match:question).`,
        seq: evt.seq,
        detail: { qIndex, count },
      });
    }
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
