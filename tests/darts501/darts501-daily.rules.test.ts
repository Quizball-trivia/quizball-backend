import { describe, expect, it } from 'vitest';
import { completion, giveUp, newState, publicState, say, type Day } from '../../src/modules/darts501-daily/darts501-daily.rules.js';
import { D501, rankScore } from '../../src/modules/darts501/darts501.rules.js';
import { category, coverage, directory, pad } from './fixture.js';

const day: Day = { category: category(), directory, coverage };
const throwAll = (texts: string[]) => texts.reduce((s, t) => say(s, day, t, null), newState({ locale: 'en' }));
const view = (s: ReturnType<typeof newState>, disclose = false) => publicState(s, '2026-11-01', day, 0, { ranked: true, disclose });

describe('solo run', () => {
  it('checks out with three darts and ranks above any run without one', () => {
    const s = throwAll(['Aro Bandel', 'Ceto Darrin', 'Quin Rask']);
    expect(s.r).toBe(0);
    expect(s.done).toBe(true);
    expect(s.end).toBe('checkout');
    expect(completion(s)).toEqual({ score: rankScore(true, 3, 0), stat: 3 });
  });

  it('free answers use no dart and are not stored as darts', () => {
    const s = throwAll(['Nobody Atall', 'Zorr', 'Wim Xell', 'Aro Bandel', 'Bandel']);
    expect(s.d).toHaveLength(1);
    expect(s.k).toBe(5);
    expect(s.last?.v).toBe('repeat');
  });

  it('ends after the last dart without a checkout', () => {
    const s = throwAll(Array.from({ length: D501.darts }, (_, k) => pad(k)));
    expect(s.done).toBe(true);
    expect(s.end).toBe('darts');
    expect(completion(s)).toEqual({ score: rankScore(false, 10, 491), stat: 10 });
  });

  it('a finished run refuses more answers, and giving up twice', () => {
    const s = giveUp(newState());
    expect(s.end).toBe('gaveUp');
    expect(() => say(s, day, 'Aro Bandel', null)).toThrow();
    expect(() => giveUp(s)).toThrow();
  });
});

describe('what a run shows', () => {
  it('only its own darts and the outs count while playing', () => {
    const live = throwAll(['Aro Bandel', 'Ceto Darrin', 'Emil Fosk']); // 80 left
    const v = view(live);
    expect(v.remaining).toBe(80);
    expect(v.outs).toBe(0);
    expect(v.darts.map((d) => d.name)).toEqual(['Aro Bandel', 'Ceto Darrin', 'Emil Fosk']);
    expect(JSON.stringify(v)).not.toContain('Gian Holt');
  });

  it("today's end screen counts the finishes it missed; their names wait for the day to close", () => {
    // 501 − 180 − 141 − 100 − 20 = 60: Gian Holt (60) would have finished; then give up.
    const s = giveUp(throwAll(['Aro Bandel', 'Ceto Darrin', 'Emil Fosk', 'Ivo Jarrel']));
    expect(s.r).toBe(60);
    const today = view(s, false);
    expect(today.finishes).toEqual({ count: 1, shown: null });
    expect(JSON.stringify(today)).not.toContain('Gian Holt');
    expect(view(s, true).finishes).toEqual({ count: 1, shown: [{ name: 'Gian Holt', value: 60 }] });
  });
});
