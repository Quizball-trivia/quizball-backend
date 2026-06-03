/**
 * Unit tests for the post-match TRACE invariants (finalResultsWellFormed,
 * winnerMatchesResults). These need no DB/boot — they feed crafted traces to the
 * referee and prove it goes RED on a malformed/duplicate results screen and a
 * wrong-winner payload, and GREEN on a correct one. This is the "prove the
 * invariant catches the bug" guard for the results-screen checks.
 */
import { describe, expect, it } from 'vitest';
import { createTrace, type EventTrace } from '../../game-regression/src/adapter.mjs';
import { checkInvariants } from '../../game-regression/src/invariants.mjs';

function traceWith(finalResults: unknown[], extra: (t: EventTrace) => void = () => {}): EventTrace {
  const t = createTrace(() => 0);
  // A minimal "completed" backbone so terminalStateReached is satisfied.
  t.record('server->room', 'match:state', { phase: 'COMPLETED' }, 'match:m1');
  extra(t);
  for (const payload of finalResults) {
    t.record('server->room', 'match:final_results', payload, 'match:m1');
  }
  return t;
}

const GOOD = {
  matchId: 'm1',
  winnerId: 'u1',
  players: {
    u1: { totalPoints: 30, correctAnswers: 5 },
    u2: { totalPoints: 10, correctAnswers: 2 },
  },
  durationMs: 60_000,
  resultVersion: 123,
  winnerDecisionMethod: 'total_points',
};

const violationsFor = (t: EventTrace, name: string) =>
  checkInvariants(t).violations.filter((v) => v.invariant === name);

describe('post-match trace invariants', () => {
  it('GREEN on a well-formed results payload', () => {
    const t = traceWith([GOOD]);
    expect(violationsFor(t, 'finalResultsWellFormed')).toHaveLength(0);
    expect(violationsFor(t, 'winnerMatchesResults')).toHaveLength(0);
  });

  it('finalResultsWellFormed RED: empty players map', () => {
    const t = traceWith([{ ...GOOD, players: {} }]);
    expect(violationsFor(t, 'finalResultsWellFormed').length).toBeGreaterThan(0);
  });

  it('finalResultsWellFormed RED: non-numeric totalPoints', () => {
    const t = traceWith([{ ...GOOD, players: { u1: { totalPoints: null, correctAnswers: 5 } } }]);
    expect(violationsFor(t, 'finalResultsWellFormed').length).toBeGreaterThan(0);
  });

  it('finalResultsWellFormed RED: missing durationMs / resultVersion', () => {
    const t = traceWith([{ ...GOOD, durationMs: undefined, resultVersion: undefined }]);
    expect(violationsFor(t, 'finalResultsWellFormed').length).toBeGreaterThan(0);
  });

  it('finalResultsWellFormed RED: duplicate results screen (fired twice)', () => {
    const t = traceWith([GOOD, GOOD]);
    expect(violationsFor(t, 'finalResultsWellFormed').length).toBeGreaterThan(0);
  });

  it('winnerMatchesResults RED: winnerId not among players', () => {
    const t = traceWith([{ ...GOOD, winnerId: 'ghost' }]);
    expect(violationsFor(t, 'winnerMatchesResults').length).toBeGreaterThan(0);
  });

  it('winnerMatchesResults RED: declared winner was out-scored (by total points)', () => {
    const t = traceWith([{
      ...GOOD,
      winnerId: 'u2', // u2 has fewer points than u1
      winnerDecisionMethod: 'total_points',
    }]);
    expect(violationsFor(t, 'winnerMatchesResults').length).toBeGreaterThan(0);
  });

  it('winnerMatchesResults GREEN: lower-scorer winner is allowed when decided by goals/penalties', () => {
    // Goals/penalties can crown a winner who is not the top scorer — not a violation.
    const t = traceWith([{ ...GOOD, winnerId: 'u2', winnerDecisionMethod: 'goals' }]);
    expect(violationsFor(t, 'winnerMatchesResults')).toHaveLength(0);
  });

  it('winnerMatchesResults GREEN: a draw (winnerId null) is fine', () => {
    const t = traceWith([{ ...GOOD, winnerId: null }]);
    expect(violationsFor(t, 'winnerMatchesResults')).toHaveLength(0);
  });
});
