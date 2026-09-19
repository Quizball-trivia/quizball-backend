import { describe, expect, it } from 'vitest';
import { createTrace } from '../../game-regression/src/adapter.mjs';
import { penaltyShootoutArithmetic } from '../../game-regression/src/invariants.mjs';

function facts() {
  return {
    match: { id: 'fixture', status: 'completed', mode: 'ranked', winner_user_id: 'one', state_payload: {
      phase: 'COMPLETED', winnerDecisionMethod: 'goals', goals: { seat1: 5, seat2: 1 },
      penaltyGoals: { seat1: 0, seat2: 0 },
      penalty: { round: 0, suddenDeath: false, attempts: { seat1: [], seat2: [] }, kicksTaken: { seat1: 0, seat2: 0 } },
    } },
    players: [
      { user_id: 'one', seat: 1, goals: 5, penalty_goals: 0, is_ai: false },
      { user_id: 'two', seat: 2, goals: 1, penalty_goals: 0, is_ai: true },
    ],
    answers: [],
  };
}
const check = (data: ReturnType<typeof facts>) => penaltyShootoutArithmetic(createTrace(Date.now), { matchId: 'fixture', botUserId: 'one' }, data);

describe('rehearsal shootout checks after hydration', () => {
  it('accepts the untouched empty penalty structure on a match won by regular goals', () => {
    expect(check(facts())).toEqual([]);
  });
  it('still rejects an empty round-zero state after actually entering a shootout', () => {
    const data = facts(); data.match.state_payload.phase = 'PENALTY_SHOOTOUT';
    expect(check(data).length).toBeGreaterThan(0);
  });
  it('still reports inconsistent counters rather than treating them as an unused shootout', () => {
    const data = facts(); data.match.state_payload.penalty.kicksTaken.seat1 = 1;
    expect(check(data).some(row => row.message.includes('incoherent'))).toBe(true);
  });
  it('still reports a penalty winner without recorded kicks', () => {
    const data = facts(); data.match.state_payload.winnerDecisionMethod = 'penalty_goals';
    expect(check(data).some(row => row.message.includes('no arithmetic winner'))).toBe(true);
  });
});


describe('rehearsal draw arithmetic', () => {
  const draw = (kicks = 5) => ({
    ...facts(),
    match: { ...facts().match, winner_user_id: null, state_payload: {
      phase: 'COMPLETED', winnerDecisionMethod: 'draw', goals: { seat1: 0, seat2: 0 },
      penaltyGoals: { seat1: 0, seat2: 0 },
      penalty: { round: kicks * 2 + 1, suddenDeath: kicks >= 5,
        attempts: { seat1: Array(kicks).fill('miss'), seat2: Array(kicks).fill('miss') },
        kicksTaken: { seat1: kicks, seat2: kicks } },
    } },
    players: facts().players.map(p => ({ ...p, goals: 0 })),
  });
  const verify = (data: ReturnType<typeof draw>) => penaltyShootoutArithmetic(createTrace(Date.now), { matchId: 'fixture', botUserId: 'one' }, data);
  it('accepts a complete tied five-kick shootout with no winner', () => {
    expect(verify(draw())).toEqual([]);
  });
  it('rejects declaring a draw before both players finish their kicks', () => {
    expect(verify(draw(4)).length).toBeGreaterThan(0);
  });
  it('rejects assigning a player as winner of a tied shootout', () => {
    const data = draw();
    expect(verify({ ...data, match: { ...data.match, winner_user_id: 'one' } }).length).toBeGreaterThan(0);
  });
});
