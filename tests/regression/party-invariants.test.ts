/**
 * Unit tests for the party-quiz invariants — no DB/boot. Feeds crafted traces and
 * proves the referee goes RED on score regressions, an unsorted leaderboard, a
 * wrong leader, and malformed final standings; GREEN on a coherent party match.
 */
import { describe, expect, it } from 'vitest';
import { createTrace, type EventTrace } from '../../game-regression/src/adapter.mjs';
import { checkPartyInvariants } from '../../game-regression/src/party-invariants.mjs';

function partyState(players: Array<{ userId: string; totalPoints: number; rank: number }>) {
  const order = [...players].sort((a, b) => b.totalPoints - a.totalPoints).map((p) => p.userId);
  return { matchId: 'm1', currentQuestionIndex: 0, leaderUserId: order[0] ?? null, rankingOrder: order, players, stateVersion: 1 };
}

function build(states: unknown[], final?: unknown): EventTrace {
  const t = createTrace(() => 0);
  for (const s of states) t.record('server->room', 'match:party_state', s, 'match:m1');
  if (final) t.record('server->room', 'match:final_results', final, 'match:m1');
  return t;
}

const violationsFor = (t: EventTrace, name: string) =>
  checkPartyInvariants(t).violations.filter((v) => v.invariant === name);

const GOOD_FINAL = {
  matchId: 'm1', winnerId: 'u1',
  standings: [
    { userId: 'u1', rank: 1, totalPoints: 30 },
    { userId: 'u2', rank: 2, totalPoints: 10 },
  ],
};

describe('party-quiz invariants', () => {
  it('GREEN on a coherent party match', () => {
    const t = build([
      partyState([{ userId: 'u1', totalPoints: 10, rank: 1 }, { userId: 'u2', totalPoints: 0, rank: 2 }]),
      partyState([{ userId: 'u1', totalPoints: 30, rank: 1 }, { userId: 'u2', totalPoints: 10, rank: 2 }]),
    ], GOOD_FINAL);
    expect(checkPartyInvariants(t).ok).toBe(true);
  });

  it('scoresMonotonic RED: a player score decreases', () => {
    const t = build([
      partyState([{ userId: 'u1', totalPoints: 30, rank: 1 }]),
      partyState([{ userId: 'u1', totalPoints: 20, rank: 1 }]), // dropped!
    ]);
    expect(violationsFor(t, 'scoresMonotonic').length).toBeGreaterThan(0);
  });

  it('rankingCoherent RED: rankingOrder not sorted by points', () => {
    // Hand-craft a bad order (u2 first despite fewer points).
    const t = build([{
      matchId: 'm1', currentQuestionIndex: 0, leaderUserId: 'u2',
      rankingOrder: ['u2', 'u1'],
      players: [{ userId: 'u1', totalPoints: 30, rank: 2 }, { userId: 'u2', totalPoints: 10, rank: 1 }],
      stateVersion: 1,
    }]);
    expect(violationsFor(t, 'rankingCoherent').length).toBeGreaterThan(0);
  });

  it('rankingCoherent RED: leaderUserId != rankingOrder[0]', () => {
    const t = build([{
      matchId: 'm1', currentQuestionIndex: 0, leaderUserId: 'u2',
      rankingOrder: ['u1', 'u2'],
      players: [{ userId: 'u1', totalPoints: 30, rank: 1 }, { userId: 'u2', totalPoints: 10, rank: 2 }],
      stateVersion: 1,
    }]);
    expect(violationsFor(t, 'rankingCoherent').length).toBeGreaterThan(0);
  });

  it('terminalReachedParty RED: no final_results', () => {
    const t = build([partyState([{ userId: 'u1', totalPoints: 10, rank: 1 }])]); // no final
    expect(violationsFor(t, 'terminalReachedParty').length).toBeGreaterThan(0);
  });

  it('finalStandingsWellFormed RED: ranks not contiguous', () => {
    const t = build([], {
      matchId: 'm1', winnerId: 'u1',
      standings: [{ userId: 'u1', rank: 1, totalPoints: 30 }, { userId: 'u2', rank: 3, totalPoints: 10 }],
    });
    expect(violationsFor(t, 'finalStandingsWellFormed').length).toBeGreaterThan(0);
  });

  it('finalStandingsWellFormed RED: rank-1 is not the top scorer', () => {
    const t = build([], {
      matchId: 'm1', winnerId: 'u2',
      standings: [{ userId: 'u2', rank: 1, totalPoints: 10 }, { userId: 'u1', rank: 2, totalPoints: 30 }],
    });
    expect(violationsFor(t, 'finalStandingsWellFormed').length).toBeGreaterThan(0);
  });

  it('oneQuestionPerQIndexParty RED: a qIndex re-dispatched with no resume', () => {
    const t = createTrace(() => 0);
    t.record('server->room', 'match:question', { qIndex: 2 }, 'match:m1');
    t.record('server->room', 'match:question', { qIndex: 2 }, 'match:m1'); // dup
    expect(violationsFor(t, 'oneQuestionPerQIndexParty').length).toBeGreaterThan(0);
  });
});
