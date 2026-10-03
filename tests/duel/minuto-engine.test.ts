import { describe, expect, it } from 'vitest';
import { MD_IDLE_FORFEIT, MD_REVEAL_MS, MD_ROUNDS, MD_WINDOW_MS, minutoDuelEngine as engine, type MinutoDuelState } from '../../src/modules/duel/engines/minuto.engine.js';
import type { Seat } from '../../src/modules/duel/duel.types.js';
import { ctx } from './duel-fixtures.js';
import { minuteOf, rawGoal } from '../minuto/fixtures.js';

const content = engine.parseContent({ rounds: Array.from({ length: MD_ROUNDS }, (_, r) => rawGoal('2026-10-01', r)) });
const value = (r: number) => minuteOf(r).base + minuteOf(r).added;
const start = () => engine.start(content, ctx()).state;
const guess = (s: MinutoDuelState, seat: Seat, minute: number) => engine.apply(s, content, seat, { type: 'guess', round: s.r, minute }, ctx([0.1], 10_000));
const expire = (s: MinutoDuelState) => engine.expire(s, content, ctx([0.1], 0));
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as { code?: string }).code; }
  return null;
};
const view = (s: MinutoDuelState, seat: Seat | null) => engine.view(s, content, seat, 'es') as unknown as Record<string, unknown>;

describe('minuto duel engine', () => {
  it('opens goal 1 with a 30 s window; the view never carries the minute', () => {
    const step = engine.start(content, ctx());
    expect(step).toMatchObject({ state: { phase: 'guess', r: 0, guesses: [null, null] }, phase: { ms: MD_WINDOW_MS } });
    expect(JSON.stringify(view(step.state, 0))).not.toMatch(/"minute"|"answer"|fingerprint/);
  });

  it('the first guess keeps the clock and is private: the rival only learns that it was sent', () => {
    const first = guess(start(), 0, 33);
    expect(first.phase).toBe('keep');
    expect(view(first.state, 0)).toMatchObject({ me: { answered: true, guess: 33 }, rival: { answered: false }, settled: null });
    const rival = view(first.state, 1);
    expect(rival).toMatchObject({ me: { answered: false, guess: null }, rival: { answered: true }, settled: null });
    expect(JSON.stringify(rival)).not.toContain('33');
    expect(JSON.stringify(view(first.state, null))).not.toContain('33');
    expect(scoresOf(first.state)).toEqual([0, 0]);
  });

  it('a guess is final, even with a fresh command; a guess for another goal is stale', () => {
    const first = guess(start(), 0, 33).state;
    expect(code(() => guess(first, 0, 10))).toBe('already_answered');
    expect(code(() => engine.apply(first, content, 1, { type: 'guess', round: 1, minute: 10 }, ctx()))).toBe('stale_round');
  });

  it('the second guess settles at once with the video points and opens a 6 s reveal; the reveal then opens the next goal', () => {
    const done = guess(guess(start(), 0, value(0)).state, 1, value(0) + 1);
    expect(done).toMatchObject({ state: { phase: 'reveal', scores: [3, 0], settled: { guesses: [value(0), value(0) + 1], answer: minuteOf(0), points: [3, 0] } }, phase: { ms: MD_REVEAL_MS } });
    expect(view(done.state, 1)).toMatchObject({ settled: { answer: minuteOf(0) } });
    expect(code(() => guess(done.state, 0, 1))).toBe('round_over');
    const nextGoal = expire(done.state);
    expect(nextGoal).toMatchObject({ state: { phase: 'guess', r: 1, guesses: [null, null], settled: null }, phase: { ms: MD_WINDOW_MS } });
  });

  it('the window ending settles with whoever answered (1 point for a lone guess) and strikes the silent seat', () => {
    const lone = expire(guess(start(), 1, 80).state);
    expect(lone.state).toMatchObject({ phase: 'reveal', scores: [0, 1], idle: [1, 0] });
  });

  it('three goals in a row without a guess forfeit that seat; a guess resets the count; both silent ends on the scores', () => {
    let s = start();
    for (let i = 0; i < MD_IDLE_FORFEIT; i += 1) {
      const w = expire(guess(s, 1, 50).state);
      if (i < MD_IDLE_FORFEIT - 1) {
        expect(w.state.phase).toBe('reveal');
        s = expire(w.state).state;
      } else {
        // The forfeiting round still settles: the seat that answered keeps its point for it.
        expect(w).toMatchObject({ state: { phase: 'over', idleSeat: 0, scores: [0, MD_IDLE_FORFEIT] }, phase: null });
        expect(w.state.results).toHaveLength(MD_IDLE_FORFEIT);
        expect(engine.outcome(w.state)).toMatchObject({ idle: 0 });
      }
    }
    let both = start();
    for (let i = 0; i < MD_IDLE_FORFEIT - 1; i += 1) both = expire(expire(both).state).state;
    const over = expire(both);
    expect(over.state).toMatchObject({ phase: 'over', idleSeat: null });
  });

  it('a pack that deals the same goal twice is refused', () => {
    const rounds = Array.from({ length: MD_ROUNDS }, (_, r) => rawGoal('2026-10-01', r));
    rounds[5] = { ...rounds[5], fingerprint: rounds[2].fingerprint };
    expect(() => engine.parseContent({ rounds })).toThrow();
  });

  it('the tenth goal shows its reveal before the game is over', () => {
    let s = start();
    for (let r = 0; r < MD_ROUNDS; r += 1) {
      s = guess(guess(s, 0, value(r)).state, 1, value(r) + 3).state;
      expect(engine.outcome(s)).toBeNull();
      const after = expire(s);
      if (r === MD_ROUNDS - 1) {
        expect(after).toMatchObject({ state: { phase: 'over' }, phase: null });
        expect(engine.outcome(after.state)).toEqual({ scores: [30, 0], idle: null });
      } else s = after.state;
    }
  });
});

function scoresOf(s: MinutoDuelState) {
  return engine.scores(s);
}
