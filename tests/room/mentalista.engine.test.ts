import { describe, expect, it } from 'vitest';
import {
  afterOutage, applyCommand, mentalistaCommandSchema, seatsChanged, standings, startMatch, tick, totals, matches, viewOf,
  type MentalistaState,
} from '../../src/modules/room/games/mentalista/mentalista.engine.js';
import {
  MENTALISTA_DEFAULT_TIMING, MENTALISTA_MATCH_POINTS, MENTALISTA_OUTAGE_MS,
  mentalistaContentSchema, mentalistaOptionsSchema, resolveTiming, type MentalistaCategory, type MentalistaContent,
} from '../../src/modules/room/games/mentalista/mentalista.rules.js';
import type { RoomSeatChange } from '../../src/modules/room/room.engine.js';

/**
 * Pure engine/rules tests. No DB, Redis, network or filesystem. Every fixture is an invented universe — no real quiz
 * content. The wire protocol is unchanged: a `choose`/`predict` command carries a round and an option index, and seats
 * read a MentalistaView.
 */

// ----- invented-universe fixtures (never real content) -----
const L = (s: string) => ({ es: s, en: s, ka: s, tr: s });
const opt = (id: string) => ({ id, name: L(`name-${id}`) });
const DIFFS = ['easy', 'medium', 'hard'] as const;
const cat = (id: string, nOpts = 4, difficulty: MentalistaCategory['difficulty'] = 'easy'): MentalistaCategory => ({
  id, difficulty, prompt: L(`prompt-${id}`),
  options: Array.from({ length: nOpts }, (_, i) => opt(`${id}-${i}`)),
});
const TIMING = { ...MENTALISTA_DEFAULT_TIMING };
const makeContent = (seats: number, nOpts = 4): MentalistaContent => ({
  timing: { ...TIMING },
  categories: Array.from({ length: seats }, (_, i) => cat(`cat${i}`, nOpts, DIFFS[i % 3])),
});

const T = 1_000_000;

const choose = (s: MentalistaState, content: MentalistaContent, seat: number, option: number, at: number) =>
  applyCommand(s, content, seat, { type: 'choose', round: s.round, option }, at);
const predict = (s: MentalistaState, content: MentalistaContent, seat: number, option: number, at: number) =>
  applyCommand(s, content, seat, { type: 'predict', round: s.round, option }, at);
const leave = (seat: number): RoomSeatChange => ({ seat, change: 'leave' });
const away = (seat: number): RoomSeatChange => ({ seat, change: 'away' });
const back = (seat: number): RoomSeatChange => ({ seat, change: 'back' });

/** Drives one healthy round: the scheduled chooser commits, every listed predictor locks, the round reveals, next opens. */
function playRound(
  s0: MentalistaState, content: MentalistaContent, now: number, chooserOpt: number, preds: Array<[number, number]>,
): { state: MentalistaState; now: number } {
  let s = s0;
  const chooser = s.round; // schedule[r] === r
  const committed = choose(s, content, chooser, chooserOpt, now + 100);
  expect(committed.error).toBeUndefined();
  s = committed.state;
  s = tick(s, content, now + 200);
  expect(s.phase).toBe('predict');
  let t = now + 300;
  for (const [seat, o] of preds) {
    const r = predict(s, content, seat, o, t);
    expect(r.error).toBeUndefined();
    s = r.state;
    t += 5;
  }
  s = tick(s, content, t);
  expect(s.phase).toBe('reveal');
  const deadline = s.deadline;
  s = tick(s, content, deadline);
  return { state: s, now: deadline };
}

describe('mentalista engine: start, schedule and a frozen chooser cycle', () => {
  it('admits only 3–6 seats, needs a category per round, and freezes a seat-order schedule', () => {
    expect(() => startMatch(2, makeContent(2), T)).toThrow();
    expect(() => startMatch(7, makeContent(7), T)).toThrow();
    expect(() => startMatch(3, { timing: { ...TIMING }, categories: [cat('a'), cat('b')] }, T)).toThrow();
    for (const seats of [3, 4, 5, 6]) {
      const s = startMatch(seats, makeContent(seats), T);
      expect(s.schedule).toEqual(Array.from({ length: seats }, (_, i) => i));
      expect(s).toMatchObject({ phase: 'choose', round: 0, deadline: T + TIMING.chooseMs });
      expect(s.status).toEqual(Array.from({ length: seats }, () => 'in'));
    }
  });

  it('a withdrawn future chooser is voided on their round — never reassigned, schedule unchanged', () => {
    const content = makeContent(3);
    let s = startMatch(3, content, T);
    s = seatsChanged(s, [leave(2)]); // seat 2 is the round-2 chooser
    expect(s.schedule).toEqual([0, 1, 2]);
    let r = playRound(s, content, T, 1, [[1, 1]]); // round 0: chooser 0, only seat 1 predicts (2 is withdrawn)
    r = playRound(r.state, content, r.now, 0, [[0, 0]]); // round 1: chooser 1, only seat 0 predicts
    s = r.state;
    expect(s.phase).toBe('choose');
    expect(s.round).toBe(2);
    s = tick(s, content, r.now + 10); // round 2 chooser (seat 2) is withdrawn → void, not reassigned
    expect(s.phase).toBe('reveal');
    const round2 = s.results[2];
    expect(round2).toMatchObject({ round: 2, chooser: 2, target: null, voided: true });
    s = tick(s, content, s.deadline);
    expect(s.phase).toBe('over');
    expect(s.schedule).toEqual([0, 1, 2]);
  });
});

describe('mentalista engine: commands, roles, phases and scoring', () => {
  it('chooser commits then predicts are locked; +2 on a match, the chooser always scores 0', () => {
    const content = makeContent(3);
    let r = playRound(startMatch(3, content, T), content, T, 1, [[1, 1], [2, 2]]); // seat 1 matches, seat 2 misses
    r = playRound(r.state, content, r.now, 0, [[0, 0], [2, 0]]); // seats 0 and 2 match chooser 1
    r = playRound(r.state, content, r.now, 3, [[0, 3], [1, 0]]); // seat 0 matches chooser 2, seat 1 misses
    const s = r.state;
    expect(s.phase).toBe('over');
    expect(totals(s)).toEqual([4, 2, 2]);
    expect(matches(s)).toEqual([2, 1, 1]);
    // In every round the chooser's own entry is a non-scoring null prediction.
    for (const res of s.results) expect(res.entries[res.chooser]).toMatchObject({ prediction: null, matched: false, points: 0 });
    const matched = s.results[0].entries[1];
    expect(matched).toMatchObject({ prediction: 1, matched: true, points: MENTALISTA_MATCH_POINTS });
    const place = standings(s);
    expect(place.find((p) => p.seat === 0)).toMatchObject({ points: 4, roundWins: 2, place: 1 });
    expect(place.find((p) => p.seat === 1)).toMatchObject({ place: 2 });
    expect(place.find((p) => p.seat === 2)).toMatchObject({ place: 2 }); // tie shares the place
  });

  it('rejects the wrong role, round, phase, an illegal option, a withdrawn seat and replays', () => {
    const content = makeContent(3, 3); // 3 options → indices 0..2 legal
    let s = startMatch(3, content, T);
    expect(choose(s, content, 1, 0, T + 1).error).toBe('not_chooser');
    expect(predict(s, content, 1, 0, T + 1).error).toBe('wrong_phase'); // predict before the predict phase
    expect(applyCommand(s, content, 0, { type: 'choose', round: 1, option: 0 }, T + 1).error).toBe('stale_round');
    expect(choose(s, content, 0, 5, T + 1).error).toBe('illegal_option'); // within the schema's 0..7 but past this category
    const withdrawn = seatsChanged(s, [leave(1)]);
    expect(choose(withdrawn, content, 1, 0, T + 1).error).toBe('withdrawn');
    // Commit, then a replay and a predict-by-chooser are both refused.
    s = choose(s, content, 0, 1, T + 1).state;
    expect(choose(s, content, 0, 2, T + 2).error).toBe('already_chosen');
    s = tick(s, content, T + 2); // → predict
    expect(choose(s, content, 0, 1, T + 3).error).toBe('wrong_phase'); // choose after the choose phase
    expect(predict(s, content, 0, 1, T + 3).error).toBe('chooser_cannot_predict');
    s = predict(s, content, 1, 2, T + 3).state;
    expect(predict(s, content, 1, 2, T + 4).error).toBe('already_predicted'); // immutable, even re-sent verbatim
    expect(predict(s, content, 1, 0, T + 4).error).toBe('already_predicted'); // and under a different option
  });

  it('refuses malformed commands at the schema before the engine sees them', () => {
    const bad = [
      { type: 'nope', round: 0, option: 0 },
      { type: 'choose', round: 0 },
      { type: 'choose', round: -1, option: 0 },
      { type: 'choose', round: 6, option: 0 },
      { type: 'choose', round: 0, option: 8 },
      { type: 'predict', round: 0, option: 0, extra: 1 },
      { type: 'choose', round: 0, option: 1.5 },
    ];
    for (const b of bad) expect(mentalistaCommandSchema.safeParse(b).success).toBe(false);
    expect(mentalistaCommandSchema.safeParse({ type: 'choose', round: 0, option: 0 }).success).toBe(true);
    expect(mentalistaCommandSchema.safeParse({ type: 'predict', round: 5, option: 7 }).success).toBe(true);
  });
});

describe('mentalista engine: deadlines are one boundary (-1 / equal / +1)', () => {
  it('choose: a commit lands before the deadline, not at it; the deadline voids the slot', () => {
    const content = makeContent(3);
    const s = startMatch(3, content, T);
    const D = s.deadline;
    expect(choose(s, content, 0, 0, D - 1).error).toBeUndefined();
    expect(choose(s, content, 0, 0, D).error).toBe('not_open');
    expect(choose(s, content, 0, 0, D + 1).error).toBe('not_open');
    expect(tick(s, content, D - 1).phase).toBe('choose');
    expect(tick(s, content, D)).toMatchObject({ phase: 'reveal', results: [expect.objectContaining({ voided: true, target: null })] });
    expect(tick(s, content, D + 1).phase).toBe('reveal');
  });

  it('predict: a prediction lands before the deadline; the deadline banks the committed pick', () => {
    const content = makeContent(3);
    let s = startMatch(3, content, T);
    s = choose(s, content, 0, 2, T + 1).state;
    s = tick(s, content, T + 2); // → predict
    const P = s.deadline;
    expect(predict(s, content, 1, 0, P - 1).error).toBeUndefined();
    expect(predict(s, content, 1, 0, P).error).toBe('not_open');
    expect(tick(s, content, P - 1).phase).toBe('predict');
    const revealed = tick(s, content, P);
    expect(revealed.phase).toBe('reveal');
    expect(revealed.results[0]).toMatchObject({ target: 2, voided: false });
  });

  it('reveal: holds until its deadline, then opens the next round', () => {
    const content = makeContent(3);
    let r = playRound(startMatch(3, content, T), content, T, 0, [[1, 0], [2, 0]]);
    expect(r.state).toMatchObject({ phase: 'choose', round: 1 });
    // Re-derive the reveal state just before its boundary.
    let s = startMatch(3, content, T);
    s = choose(s, content, 0, 0, T + 1).state;
    s = tick(s, content, T + 2);
    s = predict(s, content, 1, 0, T + 3).state;
    s = predict(s, content, 2, 0, T + 4).state;
    s = tick(s, content, T + 5); // → reveal
    const R = s.deadline;
    expect(tick(s, content, R - 1).phase).toBe('reveal');
    expect(tick(s, content, R)).toMatchObject({ phase: 'choose', round: 1 });
  });
});

describe('mentalista engine: outage grace', () => {
  it('a deadline far overdue re-opens the phase window instead of charging anyone', () => {
    const content = makeContent(3);
    const s = startMatch(3, content, T);
    const overdue = s.deadline + MENTALISTA_OUTAGE_MS + 1;
    const re = tick(s, content, overdue);
    expect(re.phase).toBe('choose');
    expect(re.deadline).toBe(overdue + TIMING.chooseMs);
    expect(afterOutage(s, content, overdue).deadline).toBe(overdue + TIMING.chooseMs);
    const predictState = tick(choose(s, content, 0, 0, T + 1).state, content, T + 2);
    expect(afterOutage(predictState, content, overdue).deadline).toBe(overdue + TIMING.predictMs);
  });
});

describe('mentalista engine: absence, withdrawal and terminal settlement', () => {
  it('a withdrawal before the commit voids; a commit that lands first is preserved', () => {
    const content = makeContent(3);
    // before commit → void
    let s = startMatch(3, content, T);
    s = seatsChanged(s, [leave(0)]);
    s = tick(s, content, T + 1);
    expect(s.results[0]).toMatchObject({ chooser: 0, target: null, voided: true });
    // commit, then withdraw in the same breath → the pick stands and the round scores on it
    let t = startMatch(3, content, T);
    t = choose(t, content, 0, 1, T + 1).state;
    t = seatsChanged(t, [leave(0)]);
    t = tick(t, content, T + 2); // committed wins → predict
    expect(t.phase).toBe('predict');
    t = predict(t, content, 1, 1, T + 3).state;
    t = predict(t, content, 2, 0, T + 4).state;
    t = tick(t, content, T + 5);
    expect(t.results[0]).toMatchObject({ target: 1, voided: false });
    expect(t.results[0].entries[1]).toMatchObject({ matched: true, points: MENTALISTA_MATCH_POINTS });
  });

  it('an away predictor stays eligible and keeps the round from revealing early', () => {
    const content = makeContent(3);
    // eligible: predicts while present, then goes away → still banked +2
    let s = startMatch(3, content, T);
    s = choose(s, content, 0, 2, T + 1).state;
    s = tick(s, content, T + 2);
    s = predict(s, content, 1, 2, T + 3).state;
    s = predict(s, content, 2, 2, T + 4).state;
    s = seatsChanged(s, [away(2)]);
    s = tick(s, content, T + 5);
    expect(s.results[0].entries[2]).toMatchObject({ matched: true, points: MENTALISTA_MATCH_POINTS }); // away, still banked
    // prevents early reveal: away seat not locked → no early completion, only the deadline banks
    let e = startMatch(3, content, T);
    e = choose(e, content, 0, 0, T + 1).state;
    e = tick(e, content, T + 2); // predict, deadline P
    const P = e.deadline;
    e = seatsChanged(e, [away(2)]);
    e = predict(e, content, 1, 0, P - 100).state;
    expect(tick(e, content, P - 1).phase).toBe('predict'); // away seat pending → not everyone locked
    const banked = tick(e, content, P);
    expect(banked.phase).toBe('reveal');
    expect(banked.results[0].entries[2].points).toBe(0); // away never locked
  });

  it('a predictor who leaves before the reveal loses the round; a banked reveal is untouched by a later leave', () => {
    const content = makeContent(3);
    let s = startMatch(3, content, T);
    s = choose(s, content, 0, 1, T + 1).state;
    s = tick(s, content, T + 2);
    s = predict(s, content, 1, 1, T + 3).state; // seat 1 predicts the right pick
    s = predict(s, content, 2, 1, T + 4).state;
    const beforeReveal = seatsChanged(s, [leave(1)]); // leaves while the round is still open
    const banked = tick(beforeReveal, content, T + 5);
    expect(banked.results[0].entries[1].points).toBe(0); // withdrew before reveal → no points, despite the match
    expect(banked.results[0].entries[2].points).toBe(MENTALISTA_MATCH_POINTS);
    const afterReveal = seatsChanged(banked, [leave(2)]); // leaving after the reveal cannot rewrite a banked result
    expect(afterReveal.results[0].entries[2].points).toBe(MENTALISTA_MATCH_POINTS);
    expect(totals(afterReveal)[2]).toBe(MENTALISTA_MATCH_POINTS);
  });

  it('terminal settlement: one seat in ends it, one away waits, none cancels', () => {
    const content = makeContent(3);
    const base = startMatch(3, content, T);
    expect(seatsChanged(base, [leave(1), leave(2)]).phase).toBe('over'); // one survivor present → over
    const waiting = seatsChanged(base, [leave(1), leave(2), away(0)]); // the survivor is away → wait
    expect(waiting.phase).toBe('choose');
    expect(seatsChanged(waiting, [back(0)]).phase).toBe('over'); // they come back → over
    expect(seatsChanged(base, [leave(0), leave(1), leave(2)]).phase).toBe('cancelled'); // nobody left → cancel
  });

  it('a lone away survivor at the last reveal keeps the match open until the clock or their return', () => {
    const content = makeContent(3);
    let r = playRound(startMatch(3, content, T), content, T, 0, [[1, 0], [2, 0]]);
    r = playRound(r.state, content, r.now, 0, [[0, 0], [2, 0]]);
    let s = r.state; // choose, round 2, chooser 2
    s = choose(s, content, 2, 0, r.now + 100).state;
    s = tick(s, content, r.now + 200); // predict
    s = predict(s, content, 0, 0, r.now + 300).state;
    s = predict(s, content, 1, 0, r.now + 305).state;
    s = tick(s, content, r.now + 400); // reveal of the last round
    expect(s.phase).toBe('reveal');
    s = seatsChanged(s, [leave(0), leave(1), away(2)]); // only seat 2 survives, and it is away → wait
    expect(s.phase).toBe('reveal');
    const extended = tick(s, content, s.deadline); // the clock runs out → still open, window re-armed
    expect(extended.phase).toBe('reveal');
    expect(extended.deadline).toBe(s.deadline + TIMING.revealMs);
    expect(seatsChanged(extended, [back(2)]).phase).toBe('over'); // their return ends it
  });
});

describe('mentalista engine: views never leak an open secret', () => {
  it('a non-author cannot distinguish two states that differ only in another seat’s open choice or prediction', () => {
    for (const seats of [3, 4, 5, 6]) {
      const content = makeContent(seats);
      // choose phase: the chooser (seat 0) commits two different picks.
      const base = startMatch(seats, content, T);
      const a = choose(base, content, 0, 0, T + 1).state;
      const b = choose(base, content, 0, Math.min(3, seats - 1), T + 1).state;
      for (let o = 1; o < seats; o++) {
        expect(viewOf(a, content, o, 'en')).toEqual(viewOf(b, content, o, 'en'));
      }
      // predict phase: a predictor (seat 2) varies their locked prediction; observer seat 1 has already locked too.
      let open = choose(base, content, 0, 1, T + 1).state;
      open = tick(open, content, T + 2);
      open = predict(open, content, 1, 0, T + 3).state;
      const pa = predict(open, content, 2, 0, T + 4).state;
      const pb = predict(open, content, 2, 1, T + 4).state;
      for (let o = 0; o < seats; o++) {
        if (o === 2) continue; // the author of the varied prediction does see their own value
        expect(viewOf(pa, content, o, 'en')).toEqual(viewOf(pb, content, o, 'en'));
      }
      // only the author ever reads their own secret
      expect(viewOf(a, content, 0, 'en').myChoice).toBe(0);
      expect(viewOf(pa, content, 2, 'en').myPrediction).toBe(0);
    }
  });

  it('a terminal projection carries no unfinished secret: no open category, pick or prediction', () => {
    const content = makeContent(3);
    // over
    let r = playRound(startMatch(3, content, T), content, T, 0, [[1, 0], [2, 0]]);
    r = playRound(r.state, content, r.now, 0, [[0, 0], [2, 0]]);
    r = playRound(r.state, content, r.now, 0, [[0, 0], [1, 0]]);
    const over = r.state;
    expect(over.phase).toBe('over');
    for (let seat = 0; seat < 3; seat++) {
      const v = viewOf(over, content, seat, 'en');
      expect(v).toMatchObject({ phase: 'over', category: null, reveal: null, myChoice: null, myPrediction: null, deadline: null, iAmChooser: false });
      expect(v.standings).not.toBeNull();
      expect(v.results.every((res) => res.target !== null || res.voided)).toBe(true);
    }
    // cancelled mid-commit: the committed-but-unrevealed pick is never exposed
    let c = startMatch(3, content, T);
    c = choose(c, content, 0, 2, T + 1).state; // a live secret sits in state.choice
    c = seatsChanged(c, [leave(0), leave(1), leave(2)]);
    expect(c.phase).toBe('cancelled');
    for (let seat = 0; seat < 3; seat++) {
      const v = viewOf(c, content, seat, 'en');
      expect(v).toMatchObject({ phase: 'over', category: null, myChoice: null, myPrediction: null });
      expect(v.results).toEqual([]);
    }
  });

  it('replays do not revise a view: a locked secret keeps its first value', () => {
    const content = makeContent(3);
    let s = startMatch(3, content, T);
    s = choose(s, content, 0, 1, T + 1).state;
    s = tick(s, content, T + 2);
    const first = predict(s, content, 1, 2, T + 3).state;
    expect(viewOf(first, content, 1, 'en').myPrediction).toBe(2);
    const replayed = predict(first, content, 1, 0, T + 4); // rejected
    expect(replayed.error).toBe('already_predicted');
    expect(viewOf(replayed.state, content, 1, 'en').myPrediction).toBe(2);
  });
});

describe('mentalista engine: a full normal cycle of 3, 4, 5 and 6 seats', () => {
  it('runs every admitted size to completion with correct standings', () => {
    for (const seats of [3, 4, 5, 6]) {
      const content = makeContent(seats);
      let state = startMatch(seats, content, T);
      let now = T;
      const expected = Array.from({ length: seats }, () => 0);
      for (let round = 0; round < seats; round++) {
        const chooser = round;
        const pick = round % content.categories[round].options.length;
        const preds: Array<[number, number]> = [];
        for (let seat = 0; seat < seats; seat++) {
          if (seat === chooser) continue;
          const guess = seat === (chooser + 1) % seats ? pick : (pick + 1) % content.categories[round].options.length; // one neighbour matches
          preds.push([seat, guess]);
          if (guess === pick) expected[seat] += MENTALISTA_MATCH_POINTS;
        }
        const r = playRound(state, content, now, pick, preds);
        state = r.state;
        now = r.now;
      }
      expect(state.phase).toBe('over');
      expect(totals(state)).toEqual(expected);
      const place = standings(state);
      expect(place).toHaveLength(seats);
      expect(place.every((p) => p.place >= 1 && p.place <= seats)).toBe(true);
    }
  });
});

describe('mentalista rules: strict bounded timing and content schemas', () => {
  it('resolveTiming reads FLAT clocks, fills defaults, enforces bounds and rejects unknown shapes', () => {
    expect(resolveTiming(null)).toEqual(MENTALISTA_DEFAULT_TIMING);
    expect(resolveTiming(undefined)).toEqual(MENTALISTA_DEFAULT_TIMING);
    expect(resolveTiming({})).toEqual(MENTALISTA_DEFAULT_TIMING);
    // Flat, top-level clocks (what the shared lobby options transport can carry): defaults fill the rest.
    expect(resolveTiming({ chooseMs: 5_000 })).toEqual({ ...MENTALISTA_DEFAULT_TIMING, chooseMs: 5_000 });
    expect(resolveTiming({ chooseMs: 5_000, predictMs: 30_000, revealMs: 10_000 })).toEqual({ chooseMs: 5_000, predictMs: 30_000, revealMs: 10_000 });
    expect(resolveTiming({ chooseMs: 4_999 })).toBeUndefined(); // below min
    expect(resolveTiming({ chooseMs: 60_001 })).toBeUndefined(); // above max
    expect(resolveTiming({ revealMs: 1_999 })).toBeUndefined();
    expect(resolveTiming({ revealMs: 15_001 })).toBeUndefined();
    expect(resolveTiming({ chooseMs: 10.5 })).toBeUndefined(); // non-integer
    expect(resolveTiming({ unknown: 1 })).toBeUndefined(); // strict: unknown key
    expect(resolveTiming('string')).toBeUndefined();
  });

  it('the host options are FLAT: a nested { timing: {...} } blob is not this game’s options', () => {
    // The stored content keeps a nested `timing` block, but the host-tunable options are flat primitives (the shared
    // lobbyRoomOptionsSchema transport carries only string/number/boolean), so a nested blob must be rejected outright.
    expect(resolveTiming({ timing: { chooseMs: 20_000 } })).toBeUndefined();
    expect(resolveTiming({ timing: {} })).toBeUndefined();
    expect(mentalistaOptionsSchema.safeParse({ chooseMs: 5_000 }).success).toBe(true); // flat accepted
    expect(mentalistaOptionsSchema.safeParse({ timing: { chooseMs: 5_000 } }).success).toBe(false); // nested rejected
    // A flat options object is a plain record of primitives — exactly the shape the lobby transport admits.
    const flat: Record<string, number> = { chooseMs: 5_000, predictMs: 30_000, revealMs: 10_000 };
    expect(Object.values(flat).every((v) => typeof v === 'number')).toBe(true);
    expect(resolveTiming(flat)).toEqual(flat);
  });

  it('rejects two options that share a visible label in any supported locale, including the English fallback', () => {
    const base = () => [cat('a'), cat('b'), cat('c')] as MentalistaCategory[];
    // Distinct ids but the same English name → rejected (English is also the fallback of ru/pt/de/fr).
    const sameEn = base();
    sameEn[0] = { ...sameEn[0], options: [{ id: 'x1', name: L('Alpha') }, { id: 'x2', name: L('Alpha') }, { id: 'x3', name: L('Beta') }, { id: 'x4', name: L('Gamma') }] };
    expect(mentalistaContentSchema.safeParse({ timing: { ...TIMING }, categories: sameEn }).success).toBe(false);
    // Same label only after NFKC + trim + whitespace-collapse + lowercase normalization → still rejected.
    const normalized = base();
    normalized[0] = { ...normalized[0], options: [{ id: 'y1', name: L('The  Striker') }, { id: 'y2', name: L('the striker ') }, { id: 'y3', name: L('Keeper') }, { id: 'y4', name: L('Winger') }] };
    expect(mentalistaContentSchema.safeParse({ timing: { ...TIMING }, categories: normalized }).success).toBe(false);
    // A clash only in a non-English locale (es), while English stays distinct → still rejected per-locale.
    const esClash = base();
    esClash[0] = {
      ...esClash[0],
      options: [
        { id: 'z1', name: { es: 'Portero', en: 'Keeper', ka: 'k', tr: 't' } },
        { id: 'z2', name: { es: 'Portero', en: 'Goalie', ka: 'k2', tr: 't2' } },
        { id: 'z3', name: L('Winger') }, { id: 'z4', name: L('Striker') },
      ],
    };
    expect(mentalistaContentSchema.safeParse({ timing: { ...TIMING }, categories: esClash }).success).toBe(false);
    // Distinct visible labels in every locale (canonical ids distinct too) → accepted.
    const ok = base();
    ok[0] = { ...ok[0], options: [{ id: 'w1', name: L('Alpha') }, { id: 'w2', name: L('Beta') }, { id: 'w3', name: L('Gamma') }, { id: 'w4', name: L('Delta') }] };
    expect(mentalistaContentSchema.safeParse({ timing: { ...TIMING }, categories: ok }).success).toBe(true);
  });

  it('content parses a legal pack and rejects the malformed ones', () => {
    const legal = { timing: { ...TIMING }, categories: [cat('a'), cat('b'), cat('c')] };
    expect(mentalistaContentSchema.safeParse(legal).success).toBe(true);
    const reject = [
      { timing: { ...TIMING }, categories: [cat('a'), cat('b')] }, // too few
      { timing: { ...TIMING }, categories: Array.from({ length: 7 }, (_, i) => cat(`c${i}`)) }, // too many
      { timing: { ...TIMING }, categories: [cat('a'), cat('a'), cat('b')] }, // duplicate category id
      { timing: { ...TIMING }, categories: [{ ...cat('a'), options: [opt('x'), opt('x'), opt('y')] }, cat('b'), cat('c')] }, // duplicate option id
      { timing: { ...TIMING }, categories: [cat('a', 2), cat('b'), cat('c')] }, // too few options
      { timing: { ...TIMING }, categories: [cat('a', 9), cat('b'), cat('c')] }, // too many options
      { timing: { chooseMs: 1_000, predictMs: 20_000, revealMs: 5_000 }, categories: [cat('a'), cat('b'), cat('c')] }, // choose below bound
      { timing: { ...TIMING }, categories: [cat('a'), cat('b'), cat('c')], extra: 1 }, // strict: unknown key
      { timing: { ...TIMING }, categories: [{ ...cat('a'), prompt: { en: 'x', ka: 'x', tr: 'x' } }, cat('b'), cat('c')] }, // missing required locale es
    ];
    for (const r of reject) expect(mentalistaContentSchema.safeParse(r).success).toBe(false);
  });
});
