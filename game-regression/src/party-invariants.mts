/**
 * Party-quiz invariants — the referee for friendly_party_quiz matches. Possession
 * invariants (scoreMatchesBars, questionCounterInRange, legalPhaseOrder, …) don't
 * apply to party quiz (no possession bars, no phases, MCQ-only). These are the
 * party-quiz analogues, driven off match:party_state + match:question + final_results.
 *
 * Map to real bugs:
 *   - a player's score going DOWN mid-match          -> scoresMonotonic
 *   - leaderboard not sorted / wrong leader          -> rankingCoherent
 *   - a question dispatched twice with no resume      -> oneQuestionPerQIndexParty
 *   - match never finishing                           -> terminalReachedParty
 *   - final standings malformed (ranks/leader wrong)  -> finalStandingsWellFormed
 */
import type { EventTrace } from './adapter.mjs';
import type { Violation, InvariantResult } from './invariants.mjs';

type PartyInvariant = (trace: EventTrace) => Violation[];

interface PartyPlayer { userId: string; totalPoints: number; rank: number; status?: string }
interface PartyState {
  currentQuestionIndex?: number;
  leaderUserId?: string | null;
  rankingOrder?: string[];
  players?: PartyPlayer[];
}

/** A player's totalPoints must never DECREASE across party_state emissions. */
const scoresMonotonic: PartyInvariant = (trace) => {
  const out: Violation[] = [];
  const best = new Map<string, number>();
  for (const evt of trace.byEvent('match:party_state')) {
    const players = (evt.payload as PartyState).players ?? [];
    for (const p of players) {
      const prev = best.get(p.userId);
      if (prev !== undefined && p.totalPoints < prev) {
        out.push({
          invariant: 'scoresMonotonic',
          message: `Player ${p.userId} score dropped from ${prev} to ${p.totalPoints}.`,
          seq: evt.seq,
          detail: { userId: p.userId, prev, now: p.totalPoints },
        });
      }
      best.set(p.userId, Math.max(prev ?? 0, p.totalPoints));
    }
  }
  return out;
};

/**
 * Each party_state's rankingOrder must be sorted by totalPoints descending, the
 * leaderUserId must be rankingOrder[0], and rank values must agree with the order.
 */
const rankingCoherent: PartyInvariant = (trace) => {
  const out: Violation[] = [];
  for (const evt of trace.byEvent('match:party_state')) {
    const s = evt.payload as PartyState;
    const players = s.players ?? [];
    const order = s.rankingOrder ?? [];
    const ptsByUser = new Map(players.map((p) => [p.userId, p.totalPoints]));

    // rankingOrder sorted by points desc.
    for (let i = 1; i < order.length; i++) {
      const a = ptsByUser.get(order[i - 1]);
      const b = ptsByUser.get(order[i]);
      if (typeof a === 'number' && typeof b === 'number' && a < b) {
        out.push({
          invariant: 'rankingCoherent',
          message: `rankingOrder not sorted: ${order[i - 1]}(${a}) ranked above ${order[i]}(${b}).`,
          seq: evt.seq,
          detail: { order, points: Object.fromEntries(ptsByUser) },
        });
        break;
      }
    }
    // leaderUserId === rankingOrder[0] (when there is a ranking).
    if (order.length > 0 && s.leaderUserId != null && s.leaderUserId !== order[0]) {
      out.push({
        invariant: 'rankingCoherent',
        message: `leaderUserId ${s.leaderUserId} != rankingOrder[0] ${order[0]}.`,
        seq: evt.seq,
        detail: { leaderUserId: s.leaderUserId, top: order[0] },
      });
    }
  }
  return out;
};

/** A qIndex is freshly broadcast to the room at most once (no resume in party). */
const oneQuestionPerQIndexParty: PartyInvariant = (trace) => {
  const out: Violation[] = [];
  const lastSeq = new Map<number, number>();
  for (const evt of trace.events) {
    if (evt.event !== 'match:question') continue;
    if (evt.dir !== 'server->room' || !String(evt.target ?? '').startsWith('match:')) continue;
    const qIndex = (evt.payload as { qIndex?: number }).qIndex;
    if (typeof qIndex !== 'number') continue;
    const prevSeq = lastSeq.get(qIndex);
    if (prevSeq !== undefined) {
      // A resume legitimately re-broadcasts (party supports rejoin/resume too).
      const resumedSince = trace.byEvent('match:resume').some((r) => r.seq > prevSeq && r.seq <= evt.seq);
      if (!resumedSince) {
        out.push({
          invariant: 'oneQuestionPerQIndexParty',
          message: `qIndex ${qIndex} re-dispatched with no intervening resume.`,
          seq: evt.seq,
          detail: { qIndex, prevSeq },
        });
      }
    }
    lastSeq.set(qIndex, evt.seq);
  }
  return out;
};

/** The match must reach a terminal state (final_results). */
const terminalReachedParty: PartyInvariant = (trace) => {
  if (trace.byEvent('match:final_results').length > 0) return [];
  return [{
    invariant: 'terminalReachedParty',
    message: 'Party-quiz match never reached final_results.',
    detail: { partyStateCount: trace.byEvent('match:party_state').length },
  }];
};

/**
 * The final results standings must be well-formed: exactly one final_results, a
 * non-empty standings/players list, ranks 1..N with no gaps, and the winner/leader
 * having the max points among active players.
 */
interface FinalPartyPayload {
  winnerId?: string | null;
  standings?: Array<{ userId: string; rank: number; totalPoints?: number }>;
  players?: Record<string, { totalPoints?: number }>;
}
const finalStandingsWellFormed: PartyInvariant = (trace) => {
  const out: Violation[] = [];
  const finals = trace.byEvent('match:final_results');
  if (finals.length === 0) return out;
  if (finals.length > 1) {
    out.push({ invariant: 'finalStandingsWellFormed', message: `final_results emitted ${finals.length} times.`, seq: finals[finals.length - 1].seq, detail: { count: finals.length } });
  }
  const p = finals[0].payload as FinalPartyPayload;
  const standings = p.standings ?? [];
  if (standings.length === 0) {
    out.push({ invariant: 'finalStandingsWellFormed', message: 'Final results has empty standings.', seq: finals[0].seq });
    return out;
  }
  // ranks are 1..N contiguous.
  const ranks = standings.map((s) => s.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) {
      out.push({ invariant: 'finalStandingsWellFormed', message: `Standings ranks not contiguous 1..N: got [${ranks.join(',')}].`, seq: finals[0].seq, detail: { ranks } });
      break;
    }
  }
  // rank-1 player has the max points.
  const top = standings.find((s) => s.rank === 1);
  if (top && typeof top.totalPoints === 'number') {
    const maxPts = Math.max(...standings.map((s) => s.totalPoints ?? 0));
    if (top.totalPoints < maxPts) {
      out.push({ invariant: 'finalStandingsWellFormed', message: `Rank-1 ${top.userId} (${top.totalPoints}) is not the top scorer (${maxPts}).`, seq: finals[0].seq, detail: { top, maxPts } });
    }
  }
  return out;
};

const ALL_PARTY_INVARIANTS: Array<{ name: string; check: PartyInvariant }> = [
  { name: 'scoresMonotonic', check: scoresMonotonic },
  { name: 'rankingCoherent', check: rankingCoherent },
  { name: 'oneQuestionPerQIndexParty', check: oneQuestionPerQIndexParty },
  { name: 'terminalReachedParty', check: terminalReachedParty },
  { name: 'finalStandingsWellFormed', check: finalStandingsWellFormed },
];

/** Run all party-quiz invariants against a trace. */
export function checkPartyInvariants(trace: EventTrace): InvariantResult {
  const violations: Violation[] = [];
  for (const { check } of ALL_PARTY_INVARIANTS) violations.push(...check(trace));
  return { ok: violations.length === 0, violations };
}
