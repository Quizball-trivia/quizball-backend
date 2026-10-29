import { describe, expect, it } from 'vitest';
import { categoryProblems, d501CategorySchema, MIN_SCORING, finishWithin } from '../../src/modules/darts501/darts501.content.js';
import { checkoutWindow, D501, finishes, fromRankScore, outs, rankScore, readDart, scoreDart } from '../../src/modules/darts501/darts501.rules.js';
import { boardFor, category, coverage, directory, UNCOVERED } from './fixture.js';

describe('scoreDart', () => {
  it('takes the number off, checks out from 0 down to the floor, and busts below it', () => {
    expect(scoreDart(501, 180)).toEqual({ verdict: 'score', after: 321 });
    expect(scoreDart(60, 60)).toEqual({ verdict: 'checkout', after: 0 });
    expect(scoreDart(60, 70)).toEqual({ verdict: 'checkout', after: D501.floor });
    expect(scoreDart(60, 71)).toEqual({ verdict: 'bust', after: 60 });
  });

  it('over 180 and a miss score nothing; bogeys only under pro rules', () => {
    expect(scoreDart(501, 181)).toEqual({ verdict: 'over180', after: 501 });
    expect(scoreDart(501, null)).toEqual({ verdict: 'miss', after: 501 });
    expect(scoreDart(501, 163)).toEqual({ verdict: 'score', after: 338 });
    expect(scoreDart(501, 163, true)).toEqual({ verdict: 'bogey', after: 501 });
  });
});

describe('checkoutWindow', () => {
  it('is [remaining, remaining + 10] capped at 180, and closed above 180 or at 0', () => {
    expect(checkoutWindow(60)).toEqual({ low: 60, high: 70 });
    expect(checkoutWindow(175)).toEqual({ low: 175, high: 180 });
    expect(checkoutWindow(180)).toEqual({ low: 180, high: 180 });
    expect(checkoutWindow(181)).toBeNull();
    expect(checkoutWindow(0)).toBeNull();
  });
});

describe('readDart: who first, then the category', () => {
  const board = boardFor(category());
  it('scores a footballer of the category', () => {
    expect(readDart(board, new Set(), 501, 'Aro Bandel', null)).toMatchObject({ free: false, verdict: 'score', eid: 'p0', value: 180, after: 321 });
  });
  it('a covered footballer outside the category is a miss that uses the dart', () => {
    expect(readDart(board, new Set(), 501, 'Udo Varn', null)).toMatchObject({ free: false, verdict: 'miss', eid: 'p10', value: null, after: 501 });
  });
  it('an uncovered footballer, an unknown name, an ambiguous name and a repeat are free', () => {
    expect(readDart(board, new Set(), 501, 'Wim Xell', null)).toEqual({ free: true, verdict: 'uncovered', eid: UNCOVERED });
    expect(readDart(board, new Set(), 501, 'Nobody Atall', null)).toEqual({ free: true, verdict: 'unknown', eid: null });
    expect(readDart(board, new Set(), 501, 'Zorr', null)).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    expect(readDart(board, new Set(['p0']), 501, 'Bandel', null)).toEqual({ free: true, verdict: 'repeat', eid: 'p0' });
  });
  it('a missed footballer thrown again is a repeat too', () => {
    expect(readDart(board, new Set(['p10']), 501, 'Udo Varn', null)).toMatchObject({ free: true, verdict: 'repeat' });
  });
  it('a picked suggestion is read as that footballer; an unknown pick falls back to the text', () => {
    expect(readDart(board, new Set(), 501, 'zz', 'p1')).toMatchObject({ verdict: 'score', eid: 'p1' });
    expect(readDart(board, new Set(), 501, 'Emil Fosk', 'nope')).toMatchObject({ verdict: 'score', eid: 'p2' });
  });
  it('every free verdict is the same whatever the category holds (no oracle)', () => {
    const other = { ...board, entries: new Map([['p13', 7]]) };
    for (const text of ['Wim Xell', 'Nobody Atall', 'Zorr']) expect(readDart(other, new Set(), 501, text, null)).toEqual(readDart(board, new Set(), 501, text, null));
  });
});

describe('outs and finishes', () => {
  const entries = boardFor(category()).entries;
  it('counts footballers in the window not thrown yet', () => {
    // 50..60: Gian Holt 60, Yan Zorr 50.
    expect(outs(entries, new Set(), 50)).toBe(2);
    expect(outs(entries, new Set(['p3']), 50)).toBe(1);
    expect(outs(entries, new Set(), 400)).toBeNull();
  });
  it('lists them closest to a bullseye first', () => {
    expect(finishes(entries, new Set(), 50, 5)).toEqual([{ eid: 'p12', value: 50 }, { eid: 'p3', value: 60 }]);
  });
  it('pro rules leave bogeys out', () => {
    expect(outs(entries, new Set(), 160)).toBe(1);
    expect(outs(entries, new Set(), 160, true)).toBe(0);
  });
});

describe('rankScore', () => {
  it('orders any checkout above any run without one, then fewer darts, then closer to 0', () => {
    const order = [rankScore(true, 3, 0), rankScore(true, 3, -1), rankScore(true, 4, 0), rankScore(true, 10, -10), rankScore(false, 10, 1), rankScore(false, 10, 501)];
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });
  it('decodes back to what the board shows', () => {
    for (const [out, darts, rem] of [[true, 3, 0], [true, 10, -10], [false, 10, 1], [false, 4, 501]] as const) {
      expect(fromRankScore(rankScore(out, darts, rem), darts)).toEqual({ checkedOut: out, remaining: rem });
    }
  });
});

describe('content', () => {
  const filler = Array.from({ length: MIN_SCORING }, (_, i) => ({ eid: `f${i}`, value: i + 1 }));
  it('accepts a category with enough scoring entries', () => {
    expect(d501CategorySchema.safeParse({ ...category(), entries: filler }).success).toBe(true);
  });
  it('refuses duplicate footballers and too few scoring entries', () => {
    expect(d501CategorySchema.safeParse({ ...category(), entries: [...filler, filler[0]] }).success).toBe(false);
    expect(d501CategorySchema.safeParse({ ...category(), entries: filler.map((f) => ({ ...f, value: 181 + f.value })) }).success).toBe(false);
  });
  it('categoryProblems: every entry must be in the release and covered', () => {
    expect(categoryProblems(category(), directory, coverage)).toEqual([]);
    const bad = { ...category(), entries: [...category().entries, { eid: 'ghost', value: 3 }, { eid: UNCOVERED, value: 4 }] };
    expect(categoryProblems(bad, directory, coverage)).toEqual(['ghost is not in the release', `${UNCOVERED} is not covered`]);
  });
});

describe('finishWithin', () => {
  const ones = Array.from({ length: 40 }, (_, i) => ({ eid: `o${i}`, value: 1 }));
  const withSame = (value: number, n: number) => ({ ...category(), entries: [...ones, ...Array.from({ length: n }, (_, i) => ({ eid: `t${i}`, value }))] });
  it('three darts: footballers whose numbers total 501..511 (landing 0 to −10)', () => {
    expect(finishWithin(category(), 3)).toBe(true); // 180 + 141 + 180 = 501
    expect(finishWithin(withSame(170, 3), 3)).toBe(true); // 510: checks out on −9
    expect(finishWithin(withSame(164, 3), 3)).toBe(false); // 492: leaves 9
  });
  it('four darts reach what three cannot', () => {
    expect(finishWithin(withSame(126, 4), 3)).toBe(false);
    expect(finishWithin(withSame(126, 4), 4)).toBe(true); // 504
  });
  it('one footballer is never thrown twice, and unthrowable ones do not count', () => {
    expect(finishWithin({ ...category(), entries: [{ eid: 'x', value: 167 }, ...ones] }, 4)).toBe(false);
    expect(finishWithin(category(), 3, (eid) => eid !== 'p8')).toBe(false); // one 180 left: 180 + 163 + 141 = 484
  });
});
