import { describe, expect, it } from 'vitest';
import { flip, newState, publicState, score, stop } from '../../src/modules/codenames/codenames.rules.js';
import { dayBoardSchema, type DayBoard, type DayKind } from '../../src/modules/codenames/codenames.types.js';

// INVENTED board (public repo): cards m0–m7 are yours, t0–t6 the rival's, n0–n3 neutral, x the Own Goal.
const W = (en: string) => ({ en, es: en, tr: en, ru: en, ka: en });
const kinds: Array<[string, DayKind]> = [
  ...Array.from({ length: 8 }, (_, i): [string, DayKind] => [`m${i}`, 'mine']),
  ...Array.from({ length: 7 }, (_, i): [string, DayKind] => [`t${i}`, 'theirs']),
  ...Array.from({ length: 4 }, (_, i): [string, DayKind] => [`n${i}`, 'neutral']),
  ['xx', 'owngoal'],
];
const DAY: DayBoard = dayBoardSchema.parse({
  cards: kinds.map(([id, kind]) => ({ id: `card-${id}`, kind })),
  clues: [
    { word: W('Alpha'), count: 3, cards: ['m0', 'm1', 'm2'].map((m) => ({ id: `card-${m}`, why: W(`alpha ${m}`) })) },
    { word: W('Beta'), count: 3, cards: ['m3', 'm4', 'm5'].map((m) => ({ id: `card-${m}`, why: W(`beta ${m}`) })) },
    { word: W('Gamma'), count: 2, cards: ['m6', 'm7'].map((m) => ({ id: `card-${m}`, why: W(`gamma ${m}`) })) },
  ],
});
const at = (id: string) => DAY.cards.findIndex((c) => c.id === `card-${id}`);
const play = (...ids: string[]) => ids.reduce((s, id) => (id === 'stop' ? stop(s, DAY) : flip(s, DAY, at(id))), newState());

describe('codenames daily rules', () => {
  it('a perfect run finds all 8 without a miss', () => {
    const s = play('m0', 'm1', 'm2', 'stop', 'm3', 'm4', 'm5', 'stop', 'm6', 'm7');
    expect(s).toMatchObject({ done: true, end: 'complete' });
    expect(score(s)).toBe(899);
  });

  it('count + 1 guesses per clue, then the next clue', () => {
    const s = play('m0', 'm1', 'm2', 'm3');
    expect(s.clue).toBe(1);
    expect(s.done).toBe(false);
  });

  it('a wrong card ends the clue; the Own Goal ends the run', () => {
    expect(play('n0').clue).toBe(1);
    expect(play('t0', 'm3', 'xx')).toMatchObject({ done: true, end: 'owngoal' });
  });

  it('after the last clue the run is over', () => {
    expect(play('n0', 'n1', 'n2')).toMatchObject({ done: true, end: 'clues' });
  });

  it('stop needs one flip on the clue; no card twice; nothing after the end', () => {
    expect(() => stop(newState(), DAY)).toThrow();
    expect(() => play('m0', 'm0')).toThrow();
    expect(() => flip(play('xx'), DAY, at('m0'))).toThrow();
    expect(() => flip(newState(), DAY, 20)).toThrow();
  });

  it('scores: found first, then fewer misses', () => {
    expect(score(play('m0', 'n0', 't0', 'n1'))).toBe(100 + 96);
    expect(score(play('m0', 'm1', 'm2', 'm3', 'xx'))).toBe(400 + 98);
  });

  it('shows kinds only once flipped, clues up to the current one, and the whys only at the end', () => {
    const live = publicState(play('m0', 'stop'), '2031-01-01', DAY, { ranked: true });
    expect(live.cards.filter((c) => c.kind !== null)).toHaveLength(1);
    expect(live.clues).toHaveLength(2);
    expect(live.clues.every((c) => c.cards === undefined)).toBe(true);
    expect(JSON.stringify(live)).not.toContain('why');
    expect(live.guessesLeft).toBe(4);
    const done = publicState(play('xx'), '2031-01-01', DAY, { ranked: false });
    expect(done.cards.every((c) => c.kind !== null)).toBe(true);
    expect(done.clues).toHaveLength(3);
    expect(done.clues[2].cards).toEqual([{ id: 'card-m6', why: W('gamma m6') }, { id: 'card-m7', why: W('gamma m7') }]);
  });

  it('a finished run whose day was corrected since still counts out of eight', () => {
    const s = publicState(play('m0', 'xx'), '2031-01-01', null, { ranked: false });
    expect(s).toMatchObject({ found: 1, total: 8, cards: [], clues: [] });
  });

  it('the board schema refuses a bad key split or clues that miss your cards', () => {
    const raw = dayBoardSchema.parse(DAY);
    expect(dayBoardSchema.safeParse({ ...raw, clues: raw.clues.slice(0, 2) }).success).toBe(false);
    expect(dayBoardSchema.safeParse({ ...raw, cards: raw.cards.map((c, i) => (i === 0 ? { ...c, kind: 'neutral' } : c)) }).success).toBe(false);
  });
});
