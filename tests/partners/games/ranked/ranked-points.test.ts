import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANKED_POINTS,
  marginPoints,
  rankedMaxScore,
  rankedPartnerResult,
  rankedPointsProblems,
  type RankedPointsTable,
  type RankedSideTally,
} from '../../../../src/modules/partners/games/ranked/ranked-points.js';

const side = (userId: string, goals = 0, penaltyGoals = 0, correctAnswers = 0): RankedSideTally =>
  ({ userId, goals, penaltyGoals, correctAnswers });
const score = (result: ReturnType<typeof rankedPartnerResult>, userId: string) => result.get(userId);
const contract = (sides: readonly [RankedSideTally, RankedSideTally], cause: Parameters<typeof rankedPartnerResult>[1]) =>
  rankedPartnerResult(sides, cause, DEFAULT_RANKED_POINTS);

describe('Freecroco ranked points (contract §7.1)', () => {
  it('margin table', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((m) => marginPoints(m, DEFAULT_RANKED_POINTS))).toEqual([
      { winner: 100, loser: 50 },
      { winner: 150, loser: 40 },
      { winner: 200, loser: 30 },
      { winner: 250, loser: 20 },
      { winner: 300, loser: 10 },
      { winner: 500, loser: 0 },
      { winner: 500, loser: 0 },
    ]);
    expect(() => marginPoints(0, DEFAULT_RANKED_POINTS)).toThrow();
  });

  it('natural: by margin, won on penalties 100/50, level after penalties 60/60', () => {
    const byTwo = contract([side('a', 1), side('b', 3)], { kind: 'natural' });
    expect(score(byTwo, 'b')).toEqual({ kind: 'score', score: 150, outcome: 'win' });
    expect(score(byTwo, 'a')).toEqual({ kind: 'score', score: 40, outcome: 'loss' });
    const pens = contract([side('a', 2, 4), side('b', 2, 3)], { kind: 'natural' });
    expect([score(pens, 'a'), score(pens, 'b')]).toEqual([
      { kind: 'score', score: 100, outcome: 'win' },
      { kind: 'score', score: 50, outcome: 'loss' },
    ]);
    const level = contract([side('a', 2, 5, 9), side('b', 2, 5, 1)], { kind: 'natural' });
    expect([score(level, 'a'), score(level, 'b')]).toEqual([
      { kind: 'score', score: 60, outcome: 'draw' },
      { kind: 'score', score: 60, outcome: 'draw' },
    ]);
    expect(score(contract([side('a', 7), side('b')], { kind: 'natural' }), 'b')).toMatchObject({ score: 0 });
  });

  it('a later leave: leaver 0, opponent by margin or 100 when not ahead', () => {
    const ahead = contract([side('a', 4), side('b', 1)], { kind: 'left', leaverUserId: 'b' });
    expect([score(ahead, 'a'), score(ahead, 'b')]).toEqual([
      { kind: 'score', score: 200, outcome: 'win' },
      { kind: 'score', score: 0, outcome: 'loss' },
    ]);
    const behind = contract([side('a', 0), side('b', 3)], { kind: 'left', leaverUserId: 'b' });
    expect(score(behind, 'a')).toEqual({ kind: 'score', score: 100, outcome: 'win' });
    expect(score(behind, 'b')).toMatchObject({ score: 0 });
  });

  it('early leave cancels: leaver used, opponent returned', () => {
    const r = contract([side('a'), side('b')], { kind: 'early_leave', leaverUserId: 'a' });
    expect(score(r, 'a')).toEqual({ kind: 'cancel', refund: false });
    expect(score(r, 'b')).toEqual({ kind: 'cancel', refund: true });
  });

  it('both dropped: goals, then penalties, then correct answers; still level → both returned', () => {
    expect(score(contract([side('a', 2), side('b', 1)], { kind: 'both_dropped' }), 'a')).toMatchObject({ score: 100 });
    expect(score(contract([side('a', 1, 0, 9), side('b', 1, 0, 2)], { kind: 'both_dropped' }), 'a'))
      .toEqual({ kind: 'score', score: 100, outcome: 'win' });
    const level = contract([side('a', 1, 0, 3), side('b', 1, 0, 3)], { kind: 'both_dropped' });
    expect([score(level, 'a'), score(level, 'b')]).toEqual([{ kind: 'cancel', refund: true }, { kind: 'cancel', refund: true }]);
  });

  it('server failure: no events, both returned', () => {
    const r = contract([side('a', 5), side('b')], { kind: 'server_failure' });
    expect([score(r, 'a'), score(r, 'b')]).toEqual([{ kind: 'cancel', refund: true }, { kind: 'cancel', refund: true }]);
  });
});

const custom: RankedPointsTable = {
  margins: [
    { winner: 110, loser: 55 },
    { winner: 160, loser: 45 },
    { winner: 210, loser: 35 },
    { winner: 260, loser: 25 },
    { winner: 310, loser: 15 },
    { winner: 800, loser: 5 },
  ],
  penaltyWin: { winner: 120, loser: 70 },
  drawAfterPenalties: 65,
  leftNotAhead: 90,
};

describe('Freecroco ranked points with an edited table', () => {
  const scored = (sides: readonly [RankedSideTally, RankedSideTally], cause: Parameters<typeof rankedPartnerResult>[1]) =>
    rankedPartnerResult(sides, cause, custom);

  it('every row of the table is read from the table given', () => {
    expect([1, 5, 6, 12].map((m) => marginPoints(m, custom))).toEqual([
      { winner: 110, loser: 55 },
      { winner: 310, loser: 15 },
      { winner: 800, loser: 5 },
      { winner: 800, loser: 5 },
    ]);
    const pens = scored([side('a', 1, 3), side('b', 1, 2)], { kind: 'natural' });
    expect([score(pens, 'a'), score(pens, 'b')]).toEqual([
      { kind: 'score', score: 120, outcome: 'win' },
      { kind: 'score', score: 70, outcome: 'loss' },
    ]);
    expect(score(scored([side('a', 2, 2), side('b', 2, 2)], { kind: 'natural' }), 'a')).toMatchObject({ score: 65, outcome: 'draw' });
    expect(score(scored([side('a', 0), side('b', 1)], { kind: 'left', leaverUserId: 'b' }), 'a')).toMatchObject({ score: 90 });
    expect(score(scored([side('a', 3), side('b', 1)], { kind: 'left', leaverUserId: 'b' }), 'a')).toMatchObject({ score: 160 });
    expect(score(scored([side('a', 1, 0, 5), side('b', 1, 0, 4)], { kind: 'both_dropped' }), 'b')).toMatchObject({ score: 70 });
  });

  it('the per-play maximum is the largest value in the table', () => {
    expect(rankedMaxScore(DEFAULT_RANKED_POINTS)).toBe(500);
    expect(rankedMaxScore(custom)).toBe(800);
    expect(rankedMaxScore({ ...custom, leftNotAhead: 900 })).toBe(900);
  });
});

describe('ranked points validation', () => {
  it('accepts the contract table and an edited one', () => {
    expect(rankedPointsProblems(DEFAULT_RANKED_POINTS)).toEqual([]);
    expect(rankedPointsProblems(custom)).toEqual([]);
  });

  it('whole numbers from 0 to 5000 only', () => {
    expect(rankedPointsProblems({ ...custom, drawAfterPenalties: -1 })).toHaveLength(1);
    expect(rankedPointsProblems({ ...custom, leftNotAhead: 5001 })).toHaveLength(1);
    expect(rankedPointsProblems({ ...custom, leftNotAhead: 5000 })).toEqual([]);
    expect(rankedPointsProblems({ ...custom, penaltyWin: { winner: 100.5, loser: 0 } })).toHaveLength(1);
    expect(rankedPointsProblems({ ...custom, penaltyWin: { winner: Number.NaN, loser: 0 } })).not.toEqual([]);
  });

  it('winner points must be at least the loser points in every row; ties allowed', () => {
    const margins = custom.margins.map((m, i) => (i === 5 ? { winner: 10, loser: 20 } : m));
    expect(rankedPointsProblems({ ...custom, margins })).toEqual(['By 6 or more goals: winner points must be at least the loser points']);
    expect(rankedPointsProblems({ ...custom, penaltyWin: { winner: 40, loser: 50 } })).toHaveLength(1);
    expect(rankedPointsProblems({ ...custom, penaltyWin: { winner: 50, loser: 50 } })).toEqual([]);
  });

  it('exactly six margin rows (1..5 and 6+)', () => {
    expect(rankedPointsProblems({ ...custom, margins: custom.margins.slice(0, 5) })).not.toEqual([]);
    expect(rankedPointsProblems({ ...custom, margins: [...custom.margins, { winner: 900, loser: 0 }] })).not.toEqual([]);
  });
});
