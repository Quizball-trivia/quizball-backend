import { describe, expect, it } from 'vitest';
import { UL_CAT_END_MS, UL_REVEAL_MS, UL_TIERS, ultimoDuelEngine as engine, type UltimoDuelState } from '../../src/modules/duel/engines/ultimo.engine.js';
import { DuelRuleError, type Seat } from '../../src/modules/duel/duel.types.js';
import { category, nameOf, plainCategory } from '../ultimo/fixtures.js';

const content = engine.parseContent({
  rounds: UL_TIERS.map((difficulty, i) => (i === 0 ? { ...category('c0'), difficulty } : { ...plainCategory(`c${i}`, 8 + i), difficulty })),
});
const ctx = (r = 0.1) => ({ rng: () => r, remainingMs: 1_000 });

function started(first: Seat = 0) {
  const s = engine.start(content, ctx(first === 0 ? 0.1 : 0.9)).state;
  return engine.expire(s, content, ctx()).state;
}
const say = (s: UltimoDuelState, seat: Seat, text: string) => engine.apply(s, content, seat, { type: 'answer', cat: s.c, k: s.k, text }, ctx());
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as DuelRuleError).code; }
  return null;
};

describe('Último en pie duel engine', () => {
  it('opens on a reveal (title only), then the starter\'s turn with the 20 s clock', () => {
    const start = engine.start(content, ctx());
    expect(start.phase).toEqual({ ms: UL_REVEAL_MS });
    const view = engine.view(start.state, content, 0, 'es') as { phase: string; title: string; said: unknown[]; missing: unknown };
    expect(view).toMatchObject({ phase: 'reveal', title: content.rounds[0].title.es, said: [], missing: null });
    expect(JSON.stringify(view)).not.toContain('Bruno Martel');
    const turn = engine.expire(start.state, content, ctx());
    expect(turn.state).toMatchObject({ phase: 'turn', turn: start.state.first });
    expect(turn.phase).toEqual({ ms: 20_000 });
  });

  it('a new answer passes the turn with a fresh clock; a miss keeps the turn and its clock', () => {
    let s = started(0);
    const hit = say(s, 0, 'Emilio Varga');
    expect(hit.state).toMatchObject({ turn: 1, k: 1, m: 0, last: { seat: 0, kind: 'ok' } });
    expect(hit.phase).toEqual({ ms: 20_000 });
    s = hit.state;
    const miss = say(s, 1, 'Emilio Varga');
    expect(miss.state).toMatchObject({ turn: 1, k: 2, m: 1, last: { seat: 1, kind: 'repeat' } });
    expect(miss.phase).toBe('keep');
    const ambiguous = say(miss.state, 1, 'Martel');
    expect(ambiguous.state).toMatchObject({ m: 1, k: 3, last: { kind: 'ambiguous' } });
    expect(ambiguous.phase).toBe('keep');
  });

  it('a double submit (same attempt token) is stale, never a second miss; out of turn is refused', () => {
    const s = started(0);
    const first = say(s, 0, 'Nadie');
    expect(code(() => engine.apply(first.state, content, 0, { type: 'answer', cat: 0, k: s.k, text: 'Nadie' }, ctx()))).toBe('stale_turn');
    expect(code(() => say(first.state, 1, 'Emilio Varga'))).toBe('not_your_turn');
  });

  it('the third miss or the clock gives the category to the other seat, then a reveal of what was left', () => {
    let s = started(0);
    for (const t of ['Nadie', 'Nadie dos']) s = say(s, 0, t).state;
    const out = say(s, 0, 'Nadie tres');
    expect(out.state).toMatchObject({ phase: 'catEnd', scores: [0, 1] });
    expect(out.phase).toEqual({ ms: UL_CAT_END_MS });
    const view = engine.view(out.state, content, 0, 'es') as { missing: string[] };
    expect(view.missing).toHaveLength(content.rounds[0].answers.length);
    const timed = engine.expire(started(1), content, ctx());
    expect(timed.state.results.at(-1)).toMatchObject({ winner: 0, reason: 'time' });
  });

  it('a list named in full scores for both seats (its length never decides the category)', () => {
    let s = started(0);
    // Category 0 has 12 answers; play them all alternately.
    const names = content.rounds[0].answers.map((_, i) => nameOf(content.rounds[0], i));
    for (const name of names) s = say(s, s.turn, name).state;
    expect(s.phase).toBe('catEnd');
    expect(s.results[0]).toMatchObject({ winner: null, reason: 'complete', named: [6, 6] });
    expect(s.scores).toEqual([1, 1]);
  });

  it('the point that reaches 3 ends the match at once (no live final reveal); starters alternate', () => {
    let s = started(0);
    expect(s.turn).toBe(0);
    for (let cat = 0; cat < 3; cat += 1) {
      // Seat 1 runs out of time each category.
      if (s.turn === 0) s = say(s, 0, nameOf(content.rounds[s.c], cat === 0 ? 4 : 0)).state;
      const out = engine.expire(s, content, ctx());
      s = out.state;
      if (cat < 2) {
        expect(out.phase).toEqual({ ms: UL_CAT_END_MS });
        s = engine.expire(engine.expire(s, content, ctx()).state, content, ctx()).state;
        expect(s.turn).toBe(cat === 0 ? 1 : 0);
      } else {
        expect(out.phase).toBeNull();
      }
    }
    expect(s).toMatchObject({ phase: 'over', scores: [3, 0] });
    expect(engine.outcome(s)).toEqual({ scores: [3, 0], idle: null });
    expect((engine.view(s, content, 1, 'es') as { missing: string[] | null }).missing).not.toBeNull();
    expect(code(() => engine.expire(s, content, ctx()))).toBe('game_over');
  });

  it('the pack must follow the tier order', () => {
    expect(() => engine.parseContent({ rounds: content.rounds.map((r) => ({ ...r, difficulty: 'hard' })) })).toThrow();
  });
});
