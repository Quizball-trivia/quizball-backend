import { describe, expect, it } from 'vitest';
import { ANSWER_GRACE_MS, REVEAL_MS } from '../../src/modules/ultimo/ultimo.constants.js';
import * as rules from '../../src/modules/ultimo/ultimo.rules.js';
import { category, nameOf, plainCategory } from './fixtures.js';

const T0 = 1_000_000;
const c = category();
const begun = () => rules.begin(rules.newState(), T0);

describe('Último en pie solo rules', () => {
  it('begin opens the clock once, including the reveal; a second begin, or an answer before it, is refused', () => {
    const s = begun();
    expect(s.open).toBe(true);
    expect(s.dl).toBe(T0 + REVEAL_MS + 20_000);
    expect(() => rules.begin(s, T0)).toThrow('category_open');
    expect(() => rules.answer(rules.newState(), c, 'Emilio Varga', T0)).toThrow('category_closed');
  });

  it('a new answer resets the misses and restarts a shorter clock; repeats and unknown names are misses on the same clock', () => {
    let s = begun();
    let out = rules.answer(s, c, 'Emilio Varga', T0 + 1_000);
    expect(out.result).toBe('ok');
    s = out.state;
    expect(s.said).toHaveLength(1);
    expect(s.dl).toBe(T0 + 1_000 + 20_000);
    out = rules.answer(s, c, 'Varga', T0 + 2_000);
    expect(out.result).toBe('repeat');
    expect(out.state.m).toBe(1);
    expect(out.state.dl).toBe(s.dl);
    out = rules.answer(out.state, c, 'Nadie', T0 + 3_000);
    expect(out.result).toBe('wrong');
    expect(out.state.m).toBe(2);
  });

  it('an ambiguous name changes nothing: no miss, no clock', () => {
    const s = begun();
    const out = rules.answer(s, c, 'Martel', T0 + 1_000);
    expect(out.result).toBe('ambiguous');
    expect(out.state).toBe(s);
  });

  it('the third miss in a row ends the category; the fifth settled category finishes the run', () => {
    let s = begun();
    for (const text of ['Nadie', 'Nadie dos', 'Nadie tres']) s = rules.answer(s, c, text, T0 + 1_000).state;
    expect(s.end).toBe('misses');
    expect(s.open).toBe(false);
    expect(s.res).toEqual([{ named: 0, complete: false, reason: 'misses' }]);
    for (let i = 1; i < 5; i += 1) s = rules.project(rules.begin(rules.next(s), T0), T0 + 60_000);
    expect(s.done).toBe(true);
    expect(s.res.map((r) => r.reason)).toEqual(['misses', 'time', 'time', 'time', 'time']);
    expect(() => rules.next(s)).toThrow('run_done');
  });

  it('naming the whole list completes it: one point per name plus the bonus', () => {
    const small = plainCategory('p', 8);
    let s = begun();
    for (let i = 0; i < 8; i += 1) s = rules.answer(s, small, nameOf(small, i), T0 + i * 1_000).state;
    expect(s.end).toBe('complete');
    expect(rules.score(s)).toBe(8 + 5);
    expect(rules.answers(s)).toBe(8);
  });

  it('the clock runs out only past the grace; projection settles it and records when', () => {
    const s = begun();
    const edge = s.dl! + ANSWER_GRACE_MS;
    expect(rules.project(s, edge)).toBe(s);
    const late = rules.project(s, edge + 1);
    expect(late.end).toBe('time');
    expect(rules.settledAt(s, late)).toBe(edge);
    expect(rules.settledAt(late, late)).toBeNull();
  });

  it('a correction starts the run over (answers are kept by position)', () => {
    const s = rules.answer(begun(), c, 'Emilio Varga', T0 + 1_000).state;
    expect(rules.rebase(s)).toEqual(rules.newState());
  });

  it('the title is hidden until the category starts; unsaid names only when the day may disclose them', () => {
    const closed = rules.publicState(rules.newState(), '2026-10-01', c, T0, { ranked: true, disclose: false });
    expect(closed.title).toBeNull();
    expect(closed.total).toBeNull();
    let s = rules.answer(begun(), c, 'Emilio Varga', T0 + 1_000).state;
    const open = rules.publicState(s, '2026-10-01', c, T0 + 1_000, { ranked: true, disclose: false });
    expect(open.title?.es).toBe(c.title.es);
    expect(open.said.map((n) => n.es)).toEqual(['Emilio Varga']);
    expect(open.deadline).toBe(new Date(s.dl!).toISOString());
    s = rules.project(s, s.dl! + ANSWER_GRACE_MS + 1);
    const hidden = rules.publicState(s, '2026-10-01', c, T0, { ranked: true, disclose: false });
    expect(hidden.settled).toMatchObject({ reason: 'time', named: 1, missing: null, missingCount: c.answers.length - 1 });
    const shown = rules.publicState(s, '2026-10-01', c, T0, { ranked: false, disclose: true });
    expect(shown.settled?.missing).toHaveLength(c.answers.length - 1);
    expect(JSON.stringify(hidden)).not.toContain('Bruno Martel');
  });
});
