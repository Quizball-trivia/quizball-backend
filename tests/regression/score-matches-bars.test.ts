import { describe, expect, it } from 'vitest';
import { createTrace, type EventTrace } from '../../game-regression/src/adapter.mjs';
import { checkInvariants } from '../../game-regression/src/invariants.mjs';

function traceWithRoundResult(payload: unknown): EventTrace {
  const t = createTrace(() => 0);
  t.record('server->room', 'match:start', {
    variant: 'ranked_sim',
    participants: [
      { userId: 'u1', seat: 1 },
      { userId: 'u2', seat: 2 },
    ],
  }, 'match:m1');
  t.record('server->room', 'match:round_result', payload, 'match:m1');
  return t;
}

const violationsFor = (t: EventTrace, name: string) =>
  checkInvariants(t).violations.filter((v) => v.invariant === name);

describe('scoreMatchesBars invariant', () => {
  it('allows raw score and bar points to match when no boost fired', () => {
    const t = traceWithRoundResult({
      qIndex: 8,
      phaseKind: 'normal',
      deltas: { speedStreakBoostedSeat: null },
      players: {
        u1: { pointsEarned: 100, possessionPointsEarned: 100 },
        u2: { pointsEarned: 10, possessionPointsEarned: 10 },
      },
    });

    expect(violationsFor(t, 'scoreMatchesBars')).toHaveLength(0);
  });

  it('rejects doubled bar points without a matching speed-streak boosted seat', () => {
    const t = traceWithRoundResult({
      qIndex: 8,
      phaseKind: 'normal',
      deltas: { speedStreakBoostedSeat: null },
      players: {
        u1: { pointsEarned: 100, possessionPointsEarned: 100 },
        u2: { pointsEarned: 10, possessionPointsEarned: 20 },
      },
    });

    expect(violationsFor(t, 'scoreMatchesBars')).toHaveLength(1);
  });

  it('allows doubled bar points only for the boosted player seat', () => {
    const boostedSeat2 = traceWithRoundResult({
      qIndex: 8,
      phaseKind: 'normal',
      deltas: { speedStreakBoostedSeat: 2 },
      players: {
        u1: { pointsEarned: 100, possessionPointsEarned: 100 },
        u2: { pointsEarned: 10, possessionPointsEarned: 20 },
      },
    });
    const boostedSeat1 = traceWithRoundResult({
      qIndex: 8,
      phaseKind: 'normal',
      deltas: { speedStreakBoostedSeat: 1 },
      players: {
        u1: { pointsEarned: 100, possessionPointsEarned: 100 },
        u2: { pointsEarned: 10, possessionPointsEarned: 20 },
      },
    });

    expect(violationsFor(boostedSeat2, 'scoreMatchesBars')).toHaveLength(0);
    expect(violationsFor(boostedSeat1, 'scoreMatchesBars')).toHaveLength(1);
  });
});
