import { describe, expect, it } from 'vitest';
import { bank, newState, next, perfects, publicState, score, tap } from '../../src/modules/buscaminas/buscaminas.rules.js';
import type { RunState } from '../../src/modules/buscaminas/buscaminas.types.js';
import { indexed, makeDay, mineCards, okCards } from './fixtures.js';

const day = indexed(makeDay('2026-09-27'));
const rejects = (fn: () => unknown, reason: string) => expect(fn).toThrowError(expect.objectContaining({ statusCode: 400, message: reason }));

function tapAll(s: RunState, ids: string[]): RunState {
  return ids.reduce((acc, id) => tap(acc, day.rounds[acc.r], id).state, s);
}

describe('buscaminas round rules', () => {
  it('a correct tap adds to the pot, a mine ends the round with 0', () => {
    const a = tap(newState(), day.rounds[0], 'r0c0');
    expect(a.ok).toBe(true);
    expect(a.state.s).toBeNull();
    const b = tap(tapAll(newState(), ['r0c0', 'r0c1']), day.rounds[0], 'r0c12');
    expect(b.ok).toBe(false);
    expect(b.state.m).toBe('r0c12');
    expect(b.state.s).toEqual({ outcome: 'mine', found: 2, points: 0 });
  });

  it('rejects unknown, repeated and post-settle taps', () => {
    expect(() => tap(newState(), day.rounds[0], 'r1c0')).toThrowError(expect.objectContaining({ statusCode: 409, code: 'content_changed' }));
    rejects(() => tap(tapAll(newState(), ['r0c0']), day.rounds[0], 'r0c0'), 'already_picked');
    rejects(() => tap(tapAll(newState(), ['r0c13']), day.rounds[0], 'r0c1'), 'round_settled');
  });

  it('bank needs at least one hit and keeps found points', () => {
    rejects(() => bank(newState()), 'nothing_to_bank');
    expect(bank(tapAll(newState(), ['r0c0', 'r0c5', 'r0c7'])).s).toEqual({ outcome: 'banked', found: 3, points: 3 });
    rejects(() => bank(bank(tapAll(newState(), ['r0c0']))), 'round_settled');
  });

  it('finding all 12 correct cards is a perfect round worth found + 3', () => {
    expect(tapAll(newState(), okCards(0)).s).toEqual({ outcome: 'perfect', found: 12, points: 15 });
  });

  it('next only after settle; the run is done after 20 rounds with a max of 300', () => {
    rejects(() => next(tapAll(newState(), ['r0c0']), 20), 'round_not_settled');
    let s = newState();
    for (let r = 0; r < 20; r += 1) {
      s = tapAll(s, okCards(r));
      expect(score(s)).toBe(15 * (r + 1));
      s = next(s, 20);
    }
    expect(s.done).toBe(true);
    expect(s.res).toHaveLength(20);
    expect(score(s)).toBe(300);
    expect(perfects(s.res)).toBe(20);
    rejects(() => next(s, 20), 'run_done');
    rejects(() => tap(s, day.rounds[s.r], 'r19c0'), 'run_done');
    rejects(() => bank(s), 'run_done');
  });

  it('writes only the known state fields, dropping the extra ones of rows from the token design', () => {
    const legacy = { ...newState(), rid: 'old', d: '2026-09-27', cv: 1, u: 'user-a', sv: 4 } as RunState;
    expect(Object.keys(tap(legacy, day.rounds[0], 'r0c0').state).sort()).toEqual(['done', 'm', 'p', 'r', 'res', 's', 'v']);
    expect(Object.keys(bank(tapAll(legacy, ['r0c0']))).sort()).toEqual(['done', 'm', 'p', 'r', 'res', 's', 'v']);
  });

  it('reveals the answers only once the round is settled', () => {
    const open = publicState(tapAll(newState(), ['r0c0']), '2026-09-27', day.rounds[0], { ranked: false, reveal: true });
    expect(open.settled).toBeNull();
    expect(open.day).toBe('2026-09-27');
    expect(JSON.stringify(open)).not.toContain('r0c12');
    expect(open.found).toBe(1);
    const settled = publicState(bank(tapAll(newState(), ['r0c0'])), '2026-09-27', day.rounds[0], { ranked: false, reveal: true });
    expect(settled.settled?.reveal).toEqual({ ok: okCards(0), mines: mineCards(0) });
    const hidden = publicState(bank(tapAll(newState(), ['r0c0'])), '2026-09-27', day.rounds[0], { ranked: false, reveal: false });
    expect(hidden.settled).toEqual({ outcome: 'banked', found: 1, points: 1, reveal: null });
    expect(JSON.stringify(hidden)).not.toContain('r0c12');
    const advanced = publicState(next(bank(tapAll(newState(), ['r0c0'])), 20), '2026-09-27', day.rounds[1], { ranked: false, reveal: true });
    expect(advanced).toMatchObject({ round: 1, picked: [], settled: null, score: 1, results: [{ outcome: 'banked', found: 1, points: 1 }] });
  });
});
