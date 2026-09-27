import { describe, expect, it } from 'vitest';
import { bank, newPayload, next, perfects, publicState, score, tap } from '../../src/modules/buscaminas/buscaminas.rules.js';
import type { RunPayload } from '../../src/modules/buscaminas/buscaminas.types.js';
import { indexOf, makeDay, mineCards, okCards } from './fixtures.js';

const day = indexOf(makeDay('2026-09-27')).get('2026-09-27')!;
const start = () => newPayload('rid', '2026-09-27', 1, null);
const rejects = (fn: () => unknown, reason: string) => expect(fn).toThrowError(expect.objectContaining({ statusCode: 400, message: reason }));

function tapAll(p: RunPayload, ids: string[]): RunPayload {
  return ids.reduce((acc, id) => tap(acc, day.rounds[acc.r], id).payload, p);
}

describe('buscaminas round rules', () => {
  it('a correct tap adds to the pot, a mine ends the round with 0', () => {
    const a = tap(start(), day.rounds[0], 'r0c0');
    expect(a.ok).toBe(true);
    expect(a.payload.s).toBeNull();
    const b = tap(tapAll(start(), ['r0c0', 'r0c1']), day.rounds[0], 'r0c12');
    expect(b.ok).toBe(false);
    expect(b.payload.m).toBe('r0c12');
    expect(b.payload.s).toEqual({ outcome: 'mine', found: 2, points: 0 });
  });

  it('rejects unknown, repeated and post-settle taps', () => {
    expect(() => tap(start(), day.rounds[0], 'r1c0')).toThrowError(expect.objectContaining({ statusCode: 409, code: 'content_changed' }));
    rejects(() => tap(tapAll(start(), ['r0c0']), day.rounds[0], 'r0c0'), 'already_picked');
    rejects(() => tap(tapAll(start(), ['r0c13']), day.rounds[0], 'r0c1'), 'round_settled');
  });

  it('bank needs at least one hit and keeps found points', () => {
    rejects(() => bank(start()), 'nothing_to_bank');
    expect(bank(tapAll(start(), ['r0c0', 'r0c5', 'r0c7'])).s).toEqual({ outcome: 'banked', found: 3, points: 3 });
    rejects(() => bank(bank(tapAll(start(), ['r0c0']))), 'round_settled');
  });

  it('finding all 12 correct cards is a perfect round worth found + 3', () => {
    const p = tapAll(start(), okCards(0));
    expect(p.s).toEqual({ outcome: 'perfect', found: 12, points: 15 });
  });

  it('next only after settle; the run is done after 20 rounds with a max of 300', () => {
    rejects(() => next(tapAll(start(), ['r0c0']), 20), 'round_not_settled');
    let p = start();
    for (let r = 0; r < 20; r += 1) {
      p = tapAll(p, okCards(r));
      expect(score(p)).toBe(15 * (r + 1));
      p = next(p, 20);
    }
    expect(p.done).toBe(true);
    expect(p.res).toHaveLength(20);
    expect(score(p)).toBe(300);
    expect(perfects(p.res)).toBe(20);
    rejects(() => next(p, 20), 'run_done');
    rejects(() => tap(p, day.rounds[p.r], 'r19c0'), 'run_done');
    rejects(() => bank(p), 'run_done');
  });

  it('reveals the answers only once the round is settled', () => {
    const open = publicState(tapAll(start(), ['r0c0']), day.rounds[0], { ranked: false, reveal: true });
    expect(open.settled).toBeNull();
    expect(JSON.stringify(open)).not.toContain('r0c12');
    expect(open.found).toBe(1);
    const settled = publicState(bank(tapAll(start(), ['r0c0'])), day.rounds[0], { ranked: false, reveal: true });
    expect(settled.settled?.reveal).toEqual({ ok: okCards(0), mines: mineCards(0) });
    const hidden = publicState(bank(tapAll(start(), ['r0c0'])), day.rounds[0], { ranked: false, reveal: false });
    expect(hidden.settled).toEqual({ outcome: 'banked', found: 1, points: 1, reveal: null });
    expect(JSON.stringify(hidden)).not.toContain('r0c12');
    const advanced = publicState(next(bank(tapAll(start(), ['r0c0'])), 20), day.rounds[1], { ranked: false, reveal: true });
    expect(advanced).toMatchObject({ round: 1, picked: [], settled: null, score: 1, results: [{ outcome: 'banked', found: 1, points: 1 }] });
  });
});
