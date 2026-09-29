import { describe, expect, it } from 'vitest';
import {
  PD_AFTER_PASS_MS, PD_REVEAL_MS, PD_WINDOW_MS, pistasDuelEngine as engine, type PistasDuelState,
} from '../../src/modules/duel/engines/pistas.engine.js';
import type { Seat } from '../../src/modules/duel/duel.types.js';
import { ctx, pistasPack } from './duel-fixtures.js';

const content = engine.parseContent(pistasPack());
const start = () => engine.start(content, ctx()).state;
const guess = (s: PistasDuelState, seat: Seat, text: string, remaining = 30_000) =>
  engine.apply(s, content, seat, { type: 'guess', round: s.r, text }, ctx([0.1], remaining));
const pass = (s: PistasDuelState, seat: Seat, remaining = 30_000) =>
  engine.apply(s, content, seat, { type: 'pass', round: s.r, clue: s.n }, ctx([0.1], remaining));
const expire = (s: PistasDuelState) => engine.expire(s, content, ctx([0.1], 0));
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  return null;
};
const view = (s: PistasDuelState, seat: Seat | null = 0) => engine.view(s, content, seat, 'es') as Record<string, unknown>;

describe('pistas duel engine', () => {
  it('opens clue 1 for both seats with a 45 s window; only revealed clues and no answer are visible', () => {
    const step = engine.start(content, ctx());
    expect(step).toMatchObject({ state: { phase: 'clue', r: 0, n: 1, ceiling: 10 }, phase: { ms: PD_WINDOW_MS } });
    const v = view(step.state);
    expect(v).toMatchObject({ clue: 1, pointsInPlay: 10, settled: null, clues: [{ text: 'pista 0.1 es' }] });
    expect(JSON.stringify(v)).not.toMatch(/Número|accepted|pista 0\.2/);
  });

  it('spaces and punctuation never decide a guess: "N.U.M.E.R.O 0" and "numero0" match "Número 0"', () => {
    expect(guess(start(), 0, 'N.U.M.E.R.O 0').state.settled).toMatchObject({ winner: 0 });
    expect(guess(start(), 1, 'numero0').state.settled).toMatchObject({ winner: 1 });
    expect(guess(start(), 1, 'numer 0').state.seats[1]).toMatchObject({ locked: true });
  });

  it('a correct guess (accents and case ignored) wins 11 − n and reveals the answer', () => {
    const s = pass(pass(start(), 0).state, 1).state;
    expect(s.n).toBe(2);
    const won = guess(s, 1, 'NUMERITO 0');
    expect(won).toMatchObject({ state: { phase: 'reveal', scores: [0, 9], settled: { winner: 1, clue: 2, points: 9 } }, phase: { ms: PD_REVEAL_MS } });
    expect(view(won.state)).toMatchObject({ settled: { answer: 'Número 0 es' } });
  });

  it('the first pass cuts the other seat to at most 15 s; the second opens the next clue with a fresh window', () => {
    const s = start();
    expect(pass(s, 0, 40_000)).toMatchObject({ state: { shortened: true, n: 1 }, phase: { ms: PD_AFTER_PASS_MS } });
    expect(pass(s, 0, 9_000).phase).toEqual({ ms: 9_000 });
    const both = pass(pass(s, 0).state, 1);
    expect(both).toMatchObject({ state: { n: 2, shortened: false, seats: [{ passed: false }, { passed: false }] }, phase: { ms: PD_WINDOW_MS } });
  });

  it('a pass is not binding: the seat can still guess before the next clue opens; a pass for an older clue is stale', () => {
    const passed = pass(start(), 0).state;
    expect(guess(passed, 0, 'Número 0').state.settled).toMatchObject({ winner: 0, points: 10 });
    const later = pass(pass(start(), 0).state, 1).state;
    expect(code(() => engine.apply(later, content, 0, { type: 'pass', round: 0, clue: 1 }, ctx()))).toBe('stale_clue');
  });

  it('a peer pass never invalidates an in-flight guess: guesses carry only the round, judged at the open clue', () => {
    const s = start();
    const afterPeer = pass(s, 1).state;
    expect(guess(afterPeer, 0, 'Número 0').state.settled).toMatchObject({ winner: 0, clue: 1, points: 10 });
    const advanced = pass(afterPeer, 0).state;
    expect(guess(advanced, 1, 'Número 0').state.settled).toMatchObject({ winner: 1, clue: 2, points: 9 });
    expect(code(() => engine.apply(advanced, content, 0, { type: 'guess', round: 1, text: 'x' }, ctx()))).toBe('stale_round');
  });

  it('a wrong guess locks the seat and caps the rival at three more clues; the rival alone advances on a pass', () => {
    const s = pass(pass(start(), 0).state, 1).state; // n = 2
    const wrong = guess(s, 0, 'Pérez');
    expect(wrong).toMatchObject({ state: { ceiling: 5, seats: [{ locked: true, wrong: 'Pérez' }, { locked: false }] }, phase: 'keep' });
    expect(code(() => guess(wrong.state, 0, 'Número 0'))).toBe('locked_out');
    let r = wrong.state;
    for (const n of [3, 4, 5]) {
      r = pass(r, 1).state;
      expect(r.n).toBe(n);
    }
    const last = pass(r, 1);
    expect(last.state).toMatchObject({ phase: 'reveal', settled: { winner: null, points: 0 } });
  });

  it('wrong vs correct at the same clue: the correct seat still scores', () => {
    const wrong = guess(start(), 0, 'Pérez').state;
    expect(guess(wrong, 1, 'Número 0').state).toMatchObject({ scores: [0, 10], settled: { winner: 1 } });
  });

  it('both wrong: nobody scores; a wrong guess by a seat whose rival already passed opens the next clue', () => {
    const bothWrong = guess(guess(start(), 0, 'a').state, 1, 'b');
    expect(bothWrong.state).toMatchObject({ phase: 'reveal', scores: [0, 0], settled: { winner: null } });
    const rivalPassed = pass(start(), 1).state;
    expect(guess(rivalPassed, 0, 'a').state).toMatchObject({ n: 2, ceiling: 4 });
  });

  it('window expiry: passes everyone left, strikes seats that did nothing, and opens the next clue', () => {
    const s = pass(start(), 0).state;
    const next = expire(s);
    expect(next).toMatchObject({ state: { n: 2, idle: [0, 1] }, phase: { ms: PD_WINDOW_MS } });
    const acted = pass(next.state, 1).state;
    expect(acted.idle).toEqual([0, 0]);
  });

  it('three idle windows in a row forfeit that seat; locked seats collect no strikes', () => {
    let s = start();
    for (let i = 0; i < 2; i += 1) s = expire(pass(s, 0).state).state;
    expect(s.idle).toEqual([0, 2]);
    const gone = expire(pass(s, 0).state);
    expect(gone).toMatchObject({ state: { phase: 'over', idleSeat: 1 }, phase: null });
    expect(engine.outcome(gone.state)).toMatchObject({ idle: 1 });
    const locked = guess(start(), 1, 'x').state;
    expect(expire(locked).state.idle).toEqual([1, 0]);
  });

  it('expiry at the ceiling settles the round for nobody; the reveal moves on; after 10 rounds the game is over', () => {
    let s = guess(start(), 0, 'x').state; // ceiling 4; seat 1 plays on alone
    for (const n of [2, 3, 4]) {
      s = pass(s, 1).state;
      expect(s.n).toBe(n);
    }
    s = expire(s).state;
    expect(s).toMatchObject({ phase: 'reveal', n: 4, idle: [0, 1], settled: { winner: null } });
    s = expire(s).state;
    expect(s).toMatchObject({ phase: 'clue', r: 1, n: 1, ceiling: 10, settled: null, seats: [{ locked: false }, { locked: false }] });
    for (let r = 1; r < 10; r += 1) s = expire(guess(s, 0, `Número ${r}`).state).state;
    expect(s.phase).toBe('over');
    expect(engine.outcome(s)).toEqual({ scores: [90, 0], idle: null });
  });

  it('normalises accepted answers when the pack is parsed; refuses a pack without 10 clues', () => {
    expect(content.rounds[0].answer.accepted).toEqual(['numero 0', 'numerito 0']);
    const bad = pistasPack();
    bad.rounds[0].clues.pop();
    expect(() => engine.parseContent(bad)).toThrow();
  });
});
