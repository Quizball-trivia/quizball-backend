import { describe, expect, it } from 'vitest';
import { canReveal, giveUp, guess, newState, next, publicState, reveal, score, solved } from '../../src/modules/pistas/pistas.rules.js';
import type { RunState } from '../../src/modules/pistas/pistas.types.js';
import { answerOf, indexed, makeDay } from './fixtures.js';

const day = indexed(makeDay('2026-09-27'));
const round = (s: RunState) => day.rounds[s.r];
const rejects = (fn: () => unknown, reason: string) => expect(fn).toThrowError(expect.objectContaining({ statusCode: 400, message: reason, details: { reason } }));
const revealTimes = (s: RunState, times: number): RunState => Array.from({ length: times }).reduce<RunState>((acc) => reveal(acc), s);
const wrong = (s: RunState) => guess(s, round(s), 'Nobody', 10).state;

describe('pistas round rules', () => {
  it('a round opens with clue 1 revealed and 10 points in play; each reveal costs a point', () => {
    const s = newState();
    expect(s).toEqual({ v: 1, r: 0, n: 1, g: 0, c: null, s: null, res: [], done: false });
    const four = revealTimes(s, 3);
    expect(four.n).toBe(4);
    expect(publicState(four, '2026-09-27', round(four), { ranked: false, disclose: false }).pointsInPlay).toBe(7);
  });

  it('reveals up to clue 10, then no_more_clues', () => {
    const all = revealTimes(newState(), 9);
    expect(all.n).toBe(10);
    expect(canReveal(all)).toBe(false);
    rejects(() => reveal(all), 'no_more_clues');
  });

  it('a correct guess (normalised, exact) settles the round solved for 11 − n', () => {
    const s = revealTimes(newState(), 2);
    for (const typed of ['numero 0', '  NÚMERO-0 ', 'n 0', 'ნომერი 0', 'Numara 0']) {
      const out = guess(s, round(s), typed, 10);
      expect(out.correct).toBe(true);
      expect(out.state.s).toEqual({ outcome: 'solved', clues: 3, points: 8 });
      expect(out.state.res).toEqual([{ outcome: 'solved', clues: 3, points: 8 }]);
    }
    expect(guess(newState(), round(newState()), answerOf(0), 10).state.s).toEqual({ outcome: 'solved', clues: 1, points: 10 });
    // No typo tolerance, no partial answers.
    for (const typed of ['numer 0', 'numero', '0', 'numero 1']) expect(guess(s, round(s), typed, 10).correct).toBe(false);
  });

  it('the first miss opens the last chance: min(10, n + 3) clues and one more guess', () => {
    const miss = wrong(revealTimes(newState(), 1));
    expect(miss).toMatchObject({ n: 2, g: 1, c: 5, s: null });
    const atCeiling = revealTimes(miss, 3);
    expect(atCeiling.n).toBe(5);
    rejects(() => reveal(atCeiling), 'no_more_clues');
    // The final guess is kept at the ceiling.
    expect(guess(atCeiling, round(atCeiling), answerOf(0), 10).state.s).toEqual({ outcome: 'solved', clues: 5, points: 6 });
    expect(wrong(revealTimes(newState(), 8))).toMatchObject({ n: 9, c: 10 });
    const late = wrong(revealTimes(newState(), 9));
    expect(late).toMatchObject({ n: 10, c: 10 });
    expect(canReveal(late)).toBe(false);
  });

  it('the second miss settles the round missed with 0; so does giving up', () => {
    const second = guess(wrong(newState()), round(newState()), 'Still nobody', 10);
    expect(second.correct).toBe(false);
    expect(second.state.s).toEqual({ outcome: 'missed', clues: 1, points: 0 });
    expect(second.state.g).toBe(2);
    expect(giveUp(revealTimes(newState(), 4), 10).s).toEqual({ outcome: 'missed', clues: 5, points: 0 });
    rejects(() => guess(second.state, round(second.state), answerOf(0), 10), 'round_settled');
    rejects(() => reveal(second.state), 'round_settled');
    rejects(() => giveUp(second.state, 10), 'round_settled');
  });

  it('guards the guess limit and an empty guess even if a caller skipped validation', () => {
    rejects(() => guess({ ...newState(), g: 2 }, round(newState()), answerOf(0), 10), 'guess_limit');
    rejects(() => guess(newState(), round(newState()), ' ¡! ', 10), 'empty_guess');
  });

  it('next only after a settled round; it opens the next round fresh', () => {
    rejects(() => next(newState()), 'round_not_settled');
    const settled = giveUp(wrong(revealTimes(newState(), 2)), 10);
    expect(next(settled)).toEqual({ v: 1, r: 1, n: 1, g: 0, c: null, s: null, res: [{ outcome: 'missed', clues: 3, points: 0 }], done: false });
  });

  it('the 10th settled round finishes the run at once (no extra /next); max 100', () => {
    let s = newState();
    for (let r = 0; r < 10; r += 1) {
      s = guess(s, round(s), answerOf(r), 10).state;
      expect(score(s)).toBe(10 * (r + 1));
      if (r < 9) {
        expect(s.done).toBe(false);
        s = next(s);
      }
    }
    expect(s).toMatchObject({ done: true, r: 9 });
    expect(s.res).toHaveLength(10);
    expect([score(s), solved(s)]).toEqual([100, 10]);
    rejects(() => next(s), 'run_done');
    rejects(() => reveal(s), 'run_done');
    rejects(() => guess(s, round(s), 'x', 10), 'run_done');
    rejects(() => giveUp(s, 10), 'run_done');
  });

  it('writes only the known state fields', () => {
    const extra = { ...newState(), junk: 1 } as RunState;
    expect(Object.keys(reveal(extra)).sort()).toEqual(['c', 'done', 'g', 'n', 'r', 'res', 's', 'v']);
  });
});

describe('pistas public state', () => {
  it('carries only the revealed clues, as field-by-field copies', () => {
    const s = revealTimes(newState(), 2);
    const view = publicState(s, '2026-09-27', round(s), { ranked: true, disclose: false });
    expect(view).toMatchObject({ day: '2026-09-27', round: 0, totalRounds: 10, revealed: 3, pointsInPlay: 8, wrongGuesses: 0, ceiling: null, canReveal: true, settled: null, score: 0, solved: 0, ranked: true });
    expect(view.clues).toEqual(day.rounds[0].clues.slice(0, 3));
    expect(view.clues[0]).not.toBe(day.rounds[0].clues[0]);
    const json = JSON.stringify(view);
    expect(json).not.toContain('pista 0.3');
    expect(json).not.toMatch(/umero|ნომერი|Numara|accepted|"id"/);
  });

  it('a solved round always shows its answer; a missed one only when disclosed', () => {
    const won = guess(newState(), round(newState()), answerOf(0), 10).state;
    expect(publicState(won, 'd', round(won), { ranked: true, disclose: false }).settled?.answer).toEqual({ display: day.rounds[0].display });
    const lost = giveUp(newState(), 10);
    const hidden = publicState(lost, 'd', round(lost), { ranked: true, disclose: false });
    expect(hidden.settled).toEqual({ outcome: 'missed', clues: 1, points: 0, answer: null });
    expect(JSON.stringify(hidden)).not.toMatch(/umero/);
    expect(publicState(lost, 'd', round(lost), { ranked: false, disclose: true }).settled?.answer).toEqual({ display: day.rounds[0].display });
    // Without its content (a superseded version) nothing about the round is shown.
    expect(publicState(won, 'd', null, { ranked: false, disclose: true })).toMatchObject({ clues: [], settled: { answer: null } });
  });

  it('shows the last-chance state and the rank when given', () => {
    const miss = wrong(revealTimes(newState(), 3));
    expect(publicState(miss, 'd', round(miss), { ranked: true, disclose: false, rank: 3 })).toMatchObject({ wrongGuesses: 1, ceiling: 7, canReveal: true, rank: 3 });
    expect(publicState(miss, 'd', round(miss), { ranked: true, disclose: false })).not.toHaveProperty('rank');
  });
});
