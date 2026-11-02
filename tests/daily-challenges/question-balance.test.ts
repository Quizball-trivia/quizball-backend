import { describe, expect, it } from 'vitest';

import {
  minimumPerAnswer,
  moneyDropDifficultyQuota,
  orderByDifficultyAscending,
  rebalanceBinaryAnswers,
} from '../../src/modules/daily-challenges/question-balance.js';

type Item = { id: string; answer: boolean; difficulty?: string };
const item = (id: string, answer: boolean, difficulty = 'easy'): Item => ({ id, answer, difficulty });
const opts = (minEach: number, rankOf?: (i: Item) => number) => ({
  idOf: (i: Item) => i.id,
  answerOf: (i: Item) => i.answer,
  minEach,
  rankOf,
});

describe('orderByDifficultyAscending', () => {
  it('sorts easy → medium → hard, keeps the pick order within a tier, unknown tiers last', () => {
    const items = [item('a', true, 'hard'), item('b', true, 'easy'), item('c', true, 'weird'), item('d', true, 'medium'), item('e', true, 'easy')];
    expect(orderByDifficultyAscending(items, (i) => i.difficulty!).map((i) => i.id)).toEqual(['b', 'e', 'd', 'a', 'c']);
  });
});

describe('moneyDropDifficultyQuota', () => {
  it.each([
    [1, { easy: 1, medium: 0, hard: 0 }],
    [2, { easy: 1, medium: 0, hard: 1 }],
    [5, { easy: 2, medium: 1, hard: 2 }],
    [10, { easy: 4, medium: 3, hard: 3 }],
    [20, { easy: 7, medium: 7, hard: 6 }],
  ])('splits %i questions into a climb that always opens easy', (count, expected) => {
    const quota = moneyDropDifficultyQuota(count);
    expect(quota).toEqual(expected);
    expect(quota.easy + quota.medium + quota.hard).toBe(count);
  });
});

describe('minimumPerAnswer', () => {
  it('asks for at least one of each answer from two statements up, about a third of larger sets', () => {
    expect(minimumPerAnswer(1)).toBe(0);
    expect(minimumPerAnswer(2)).toBe(1);
    expect(minimumPerAnswer(4)).toBe(1);
    expect(minimumPerAnswer(6)).toBe(2);
    expect(minimumPerAnswer(10)).toBe(3);
  });
});

describe('rebalanceBinaryAnswers', () => {
  it('swaps in the missing answer from the pool', () => {
    const picked = [item('t1', true), item('t2', true), item('t3', true), item('t4', true)];
    const pool = [...picked, item('f1', false), item('t5', true)];
    const result = rebalanceBinaryAnswers(picked, pool, opts(1));
    expect(result.filter((i) => !i.answer).map((i) => i.id)).toEqual(['f1']);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((i) => i.id)).size).toBe(4);
  });

  it('works in both directions and reaches the minimum for larger sets', () => {
    const picked = Array.from({ length: 6 }, (_, n) => item(`f${n}`, false));
    const pool = [...picked, item('t1', true), item('t2', true), item('t3', true)];
    const result = rebalanceBinaryAnswers(picked, pool, opts(2));
    expect(result.filter((i) => i.answer)).toHaveLength(2);
    expect(result.filter((i) => !i.answer)).toHaveLength(4);
  });

  it('leaves an already balanced set untouched', () => {
    const picked = [item('t1', true), item('f1', false), item('t2', true)];
    expect(rebalanceBinaryAnswers(picked, [...picked, item('f2', false)], opts(1))).toEqual(picked);
  });

  it('prefers lower-ranked (e.g. not recently served) candidates', () => {
    const picked = [item('t1', true), item('t2', true)];
    const pool = [...picked, item('stale', false), item('fresh', false)];
    const result = rebalanceBinaryAnswers(picked, pool, opts(1, (i) => (i.id === 'stale' ? 1 : 0)));
    expect(result.map((i) => i.id)).toContain('fresh');
    expect(result.map((i) => i.id)).not.toContain('stale');
  });

  it('is soft: with no candidates of the missing answer it returns the pick as is', () => {
    const picked = [item('t1', true), item('t2', true)];
    expect(rebalanceBinaryAnswers(picked, [...picked, item('t3', true)], opts(1))).toEqual(picked);
  });
});
