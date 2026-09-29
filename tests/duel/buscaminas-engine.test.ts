import { describe, expect, it } from 'vitest';
import {
  BM_REVEAL_MS, BM_TIERS, BM_TURN_MS, buscaminasDuelEngine as engine, openerOf, type BuscaminasDuelState,
} from '../../src/modules/duel/engines/buscaminas.engine.js';
import type { Seat } from '../../src/modules/duel/duel.types.js';
import { buscaminasPack, ctx } from './duel-fixtures.js';

const content = engine.parseContent(buscaminasPack());
const start = (roll = 0.1) => engine.start(content, ctx([roll])).state;
const pick = (s: BuscaminasDuelState, seat: Seat, cardId: string) =>
  engine.apply(s, content, seat, { type: 'pick', round: s.r, at: s.picks.length, cardId }, ctx());
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  return null;
};

describe('buscaminas duel engine', () => {
  it('starts on a random opener with a 60 s turn', () => {
    expect(engine.start(content, ctx([0.2]))).toMatchObject({ state: { phase: 'turn', r: 0, turn: 0, first: 0 }, phase: { ms: BM_TURN_MS } });
    expect(engine.start(content, ctx([0.7])).state).toMatchObject({ turn: 1, first: 1 });
  });

  it('openers alternate and each seat opens 1 easy, 2 medium and 2 hard rounds', () => {
    for (const first of [0, 1] as Seat[]) {
      const opened: Record<Seat, string[]> = { 0: [], 1: [] };
      BM_TIERS.forEach((tier, r) => opened[openerOf({ first }, r)].push(tier));
      for (const seat of [0, 1] as Seat[]) expect(opened[seat].sort()).toEqual(['easy', 'hard', 'hard', 'medium', 'medium']);
    }
  });

  it('a good card passes the turn; out-of-turn, stale, repeated and unknown picks are refused', () => {
    const s = start();
    const next = pick(s, 0, 'c0');
    expect(next).toMatchObject({ state: { turn: 1, picks: [{ card: 'c0', seat: 0, auto: false }] }, phase: { ms: BM_TURN_MS } });
    expect(code(() => pick(next.state, 0, 'c1'))).toBe('not_your_turn');
    expect(code(() => engine.apply(next.state, content, 1, { type: 'pick', round: 0, at: 0, cardId: 'c1' }, ctx()))).toBe('stale_turn');
    expect(code(() => pick(next.state, 1, 'c0'))).toBe('already_picked');
    expect(code(() => pick(next.state, 1, 'zz'))).toBe('unknown_card');
  });

  it('an impostor ends the round and the rival scores the tier value', () => {
    const s = pick(start(), 0, 'c0').state;
    const mine = pick(s, 1, 'c13');
    expect(mine).toMatchObject({ state: { phase: 'reveal', scores: [1, 0], results: [{ outcome: 'mine', by: 1, points: [1, 0] }] }, phase: { ms: BM_REVEAL_MS } });
    const view = engine.view(mine.state, content, 0, 'es') as { cards: Array<{ id: string; fits: boolean | null }> };
    expect(view.cards.every((c) => c.fits !== null)).toBe(true);
  });

  it('all 12 good cards found: both seats score the tier value', () => {
    let s = start();
    for (let i = 0; i < 12; i += 1) s = pick(s, s.turn, `c${i}`).state;
    expect(s).toMatchObject({ phase: 'reveal', scores: [1, 1], results: [{ outcome: 'cleared', by: null, points: [1, 1] }] });
  });

  it('the reveal moves to the next round with the next opener; after round 10 the game is over', () => {
    let s = pick(start(), 0, 'c12').state;
    const next = engine.expire(s, content, ctx());
    expect(next).toMatchObject({ state: { phase: 'turn', r: 1, picks: [], turn: 1 }, phase: { ms: BM_TURN_MS } });
    s = next.state;
    while (s.phase !== 'over') {
      s = s.phase === 'turn' ? pick(s, s.turn, 'c15').state : engine.expire(s, content, ctx()).state;
    }
    expect(s.results).toHaveLength(10);
    expect(engine.outcome(s)).toEqual({ scores: s.scores, idle: null });
    // Hard rounds are worth 3: the 10 mines above scored 1+1+2+2+2+2+3+3+3+3 = 22 split by who hit them.
    expect(s.scores[0] + s.scores[1]).toBe(22);
  });

  it('a timeout picks a card for the seat, the same card for the same roll; a real pick resets the count; two in a row forfeit', () => {
    const s = start();
    const a = engine.expire(s, content, ctx([0.5]));
    const b = engine.expire(s, content, ctx([0.5]));
    expect(a).toEqual(b);
    expect(a.state.picks[0]).toMatchObject({ seat: 0, auto: true, card: 'c8' });
    expect(a.state.timeouts).toEqual([1, 0]);
    const reset = pick(pick(a.state, 1, 'c1').state, 0, 'c2').state;
    expect(reset.timeouts).toEqual([0, 0]);
    const once = engine.expire(reset, content, ctx([0.0])).state;
    expect(once.timeouts).toEqual([0, 1]);
    const twice = engine.expire(pick(once, 0, 'c4').state, content, ctx([0.0]));
    expect(twice).toMatchObject({ state: { phase: 'over', idle: 1 }, phase: null });
    expect(engine.outcome(twice.state)).toMatchObject({ idle: 1 });
  });

  it('while a round is open, cards nobody picked carry no fit flag', () => {
    const s = pick(start(), 0, 'c0').state;
    const view = engine.view(s, content, 1, 'en') as { cards: Array<{ id: string; fits: boolean | null }>; prompt: string };
    expect(view.prompt).toBe('Categoría 0 en');
    expect(view.cards.find((c) => c.id === 'c0')?.fits).toBe(true);
    expect(view.cards.filter((c) => c.id !== 'c0').every((c) => c.fits === null)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"ok"');
  });

  it('refuses a pack out of tier order or with fitting ids outside the round', () => {
    const bad = buscaminasPack();
    bad.rounds[0].difficulty = 'hard';
    expect(() => engine.parseContent(bad)).toThrow();
    const stray = buscaminasPack();
    stray.rounds[1].ok[0] = 'nope';
    expect(() => engine.parseContent(stray)).toThrow();
  });
});
