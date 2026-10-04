import { describe, expect, it } from 'vitest';
import { exactHits, guess, newState, next, publicState, rebase, score } from '../../src/modules/minuto/minuto.rules.js';
import { indexed, makeDay, minuteOf } from './fixtures.js';

const day = indexed(makeDay('2026-10-01'));
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as { details?: { reason?: string } }).details?.reason; }
  return null;
};
const value = (r: number) => minuteOf(r).base + minuteOf(r).added;

describe('minuto rules', () => {
  it('a guess settles the goal once with its real minute and points; the tenth finishes the run in the same write', () => {
    let s = newState();
    for (let r = 0; r < 10; r += 1) {
      s = guess(s, day.goals[r], value(r) + (r % 4), 10);
      expect(s.res[r]).toMatchObject({ goal: day.goals[r].id, guess: value(r) + (r % 4), answer: minuteOf(r), diff: r % 4 });
      expect(code(() => guess(s, day.goals[r], 1, 10))).toBe(r === 9 ? 'run_done' : 'goal_settled');
      if (r < 9) s = next(s);
    }
    expect(s.done).toBe(true);
    // diffs 0,1,2,3 repeat: 3+2+2+1 per four goals.
    expect(score(s)).toBe(3 + 2 + 2 + 1 + 3 + 2 + 2 + 1 + 3 + 2);
    expect(exactHits(s)).toBe(3);
    expect(code(() => next(s))).toBe('run_done');
  });

  it('next needs a settled goal; added time is typed as base + added', () => {
    expect(code(() => next(newState()))).toBe('goal_not_settled');
    let s = newState();
    for (let r = 0; r < 9; r += 1) s = next(guess(s, day.goals[r], 1, 10));
    s = guess(s, day.goals[9], 94, 10);
    expect(s.res[9]).toMatchObject({ answer: { base: 90, added: 4 }, diff: 0, points: 3 });
  });

  it('the card never shows its minute before the guess; the settled result shows it', () => {
    const before = publicState(newState(), day.day, day.goals, { ranked: true });
    expect(before.goal?.id).toBe(day.goals[0].id);
    expect(before.settled).toBeNull();
    expect(JSON.stringify(before)).not.toMatch(/"minute"|"answer"|"base"/);
    const after = publicState(guess(newState(), day.goals[0], 12, 10), day.day, day.goals, { ranked: true });
    expect(after.settled).toMatchObject({ guess: 12, answer: { base: 10, added: 0 }, diff: 2, points: 2 });
    expect(after.goal?.id).toBe(day.goals[0].id);
  });

  it('another content version shows no card; results stay as they were judged', () => {
    const s = guess(newState(), day.goals[0], 10, 10);
    const view = publicState(s, day.day, null, { ranked: false });
    expect(view.goal).toBeNull();
    expect(view.results).toEqual([expect.objectContaining({ answer: { base: 10, added: 0 }, points: 3 })]);
  });

  it('a correction moves a settled current goal on, keeps the results and leaves an unsettled one where it is', () => {
    const settled = guess(newState(), day.goals[0], 10, 10);
    expect(rebase(settled)).toMatchObject({ r: 1, res: settled.res });
    const open = next(settled);
    expect(rebase(open)).toEqual(open);
  });
});
